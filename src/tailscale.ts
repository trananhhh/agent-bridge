import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CANDIDATES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** Runs the Tailscale CLI (PATH or the macOS app bundle); undefined when unavailable. */
export async function tailscale(args: string[]): Promise<string | undefined> {
  for (const bin of CANDIDATES) {
    try {
      const { stdout } = await run(bin, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch {
      // try next location
    }
  }
  return undefined;
}

export async function tailscaleStatus(): Promise<unknown | undefined> {
  const out = await tailscale(['status', '--json']);
  return out ? (JSON.parse(out) as unknown) : undefined;
}

/** "Display Name <login@x>" for a tailnet IP, from Tailscale's own identity — not self-asserted. */
export async function tailscaleWhois(ip: string): Promise<string | undefined> {
  const out = await tailscale(['whois', '--json', ip]);
  if (!out) return undefined;
  try {
    const j = JSON.parse(out) as { UserProfile?: { LoginName?: string; DisplayName?: string }; Node?: { ComputedName?: string; Name?: string } };
    const user = j.UserProfile?.LoginName;
    const machine = j.Node?.ComputedName ?? j.Node?.Name?.split('.')[0];
    return [user, machine && `machine ${machine}`].filter(Boolean).join(', ') || undefined;
  } catch {
    return undefined;
  }
}
