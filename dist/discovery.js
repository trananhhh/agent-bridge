const ipv4 = (ips) => ips?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
export function parseTailscaleStatus(raw) {
    const j = raw;
    const peers = [];
    for (const p of Object.values(j.Peer ?? {})) {
        const ip = ipv4(p.TailscaleIPs);
        if (ip && p.Online)
            peers.push({ ip, host: p.HostName ?? ip, ...(p.OS && { os: p.OS }) });
    }
    return { selfIp: ipv4(j.Self?.TailscaleIPs), peers };
}
/** Probes every online tailnet peer for a running agent-bridge daemon. */
export async function findBridges(peers, opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const results = await Promise.all(peers.map(async (p) => {
        const url = `http://${p.ip}:${opts.port}`;
        try {
            const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 2500) });
            if (!res.ok)
                return undefined;
            const body = (await res.json());
            return body.app === 'agent-bridge' && body.name ? { name: body.name, ip: p.ip, host: p.host, url } : undefined;
        }
        catch {
            return undefined;
        }
    }));
    return results.filter((r) => Boolean(r));
}
