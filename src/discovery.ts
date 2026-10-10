export interface TailnetPeer {
  ip: string;
  host: string;
  os?: string;
}

export interface FoundBridge {
  name: string;
  ip: string;
  host: string;
  url: string;
}

interface RawNode {
  HostName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
}

const ipv4 = (ips: string[] | undefined) => ips?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));

export function parseTailscaleStatus(raw: unknown): { selfIp?: string; peers: TailnetPeer[] } {
  const j = raw as { Self?: RawNode; Peer?: Record<string, RawNode> };
  const peers: TailnetPeer[] = [];
  for (const p of Object.values(j.Peer ?? {})) {
    const ip = ipv4(p.TailscaleIPs);
    if (ip && p.Online) peers.push({ ip, host: p.HostName ?? ip, ...(p.OS && { os: p.OS }) });
  }
  return { selfIp: ipv4(j.Self?.TailscaleIPs), peers };
}

/** Probes every online tailnet peer for a running agent-bridge daemon. */
export async function findBridges(
  peers: TailnetPeer[],
  opts: { port: number; timeoutMs?: number; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> },
): Promise<FoundBridge[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const results = await Promise.all(
    peers.map(async (p): Promise<FoundBridge | undefined> => {
      const url = `http://${p.ip}:${opts.port}`;
      try {
        const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 2500) });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { app?: string; name?: string };
        return body.app === 'agent-bridge' && body.name ? { name: body.name, ip: p.ip, host: p.host, url } : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((r): r is FoundBridge => Boolean(r));
}
