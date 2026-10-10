import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE_HOME = process.env.BRIDGE_HOME ?? join(homedir(), '.agent-bridge');
export const CONFIG_PATH = join(BRIDGE_HOME, 'config.json');
export const DB_PATH = join(BRIDGE_HOME, 'bridge.db');

export const DEFAULT_HEADLESS_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
];

const Name = z.string().regex(/^[a-z0-9_-]{1,50}$/i, 'name: 1-50 chars [a-zA-Z0-9_-]');
const Token = z.string().min(24, 'token: at least 24 chars');

const PeerSchema = z.object({
  name: Name,
  url: z.url(),
  token: Token,
  workdirs: z.array(z.string().min(1)).min(1).optional(),
});

const ConfigSchema = z
  .object({
    name: Name,
    listenHost: z.string().default('0.0.0.0'),
    peerPort: z.number().int().positive().default(8790),
    localPort: z.number().int().positive().default(8791),
    workdirs: z.array(z.string().min(1)).min(1, 'workdirs: at least one directory peers may work in'),
    peers: z.array(PeerSchema).default([]),
    claudeBin: z.string().default('claude'),
    headless: z
      .object({
        allowedTools: z.array(z.string()).default(DEFAULT_HEADLESS_TOOLS),
        timeoutMs: z.number().int().positive().default(15 * 60_000),
      })
      .prefault({}),
    routing: z
      .object({
        recentHours: z.number().positive().default(48),
        recentLimit: z.number().int().positive().default(8),
        activeWindowMin: z.number().nonnegative().default(10),
        classifierModel: z.string().default('haiku'),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    const tokens = new Set<string>();
    for (const p of cfg.peers) {
      if (names.has(p.name)) ctx.addIssue({ code: 'custom', message: `duplicate peer "${p.name}"` });
      if (tokens.has(p.token)) ctx.addIssue({ code: 'custom', message: `token reused by peer "${p.name}" (one token per peer)` });
      names.add(p.name);
      tokens.add(p.token);
    }
  });

export type RawConfig = z.input<typeof ConfigSchema>;
export interface PeerConfig {
  name: string;
  url: string;
  token: string;
  workdirs: string[];
}
export type BridgeConfig = Omit<z.output<typeof ConfigSchema>, 'peers'> & { peers: PeerConfig[] };

export function expandPath(p: string, home = homedir()): string {
  const expanded = resolve(p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p).replace(/(.)\/+$/, '$1');
  // Claude Code records the canonical cwd (e.g. /tmp → /private/tmp), so compare against the same form.
  try {
    return realpathSync.native(expanded);
  } catch {
    return expanded;
  }
}

export function parseConfig(raw: unknown, home = homedir()): BridgeConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`agent-bridge config invalid:\n${parsed.error.issues.map((i) => `  - ${[...i.path, ''].join('.')} ${i.message}`).join('\n')}`);
  }
  const cfg = parsed.data;
  const workdirs = cfg.workdirs.map((d) => expandPath(d, home));
  return {
    ...cfg,
    workdirs,
    peers: cfg.peers.map((p) => ({ ...p, workdirs: p.workdirs ? p.workdirs.map((d) => expandPath(d, home)) : workdirs })),
  };
}

export function readRawConfig(path = CONFIG_PATH): RawConfig {
  if (!existsSync(path)) throw new Error(`No config at ${path}. Run: agent-bridge init --name <your-name>`);
  return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
}

export function loadConfig(path = CONFIG_PATH): BridgeConfig {
  return parseConfig(readRawConfig(path));
}

export function writeRawConfig(raw: RawConfig, path = CONFIG_PATH): void {
  parseConfig(raw);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
