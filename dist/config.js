import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EFFORTS } from "./claude-runner.js";
/** Package root — works from src/ (dev) and dist/ (installed). */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version;
export const BRIDGE_HOME = process.env.BRIDGE_HOME ?? join(homedir(), '.agent-bridge');
export const CONFIG_PATH = join(BRIDGE_HOME, 'config.json');
export const DB_PATH = join(BRIDGE_HOME, 'bridge.db');
const ConfigSchema = z.object({
    name: z.string().regex(/^[a-z0-9_-]{1,50}$/, 'name: 1-50 characters, lowercase a-z 0-9 _ -'),
    listenHost: z.string({ error: 'listenHost: required (Tailscale IP of this machine)' }).min(1),
    peerPort: z.number().int().positive().default(8790),
    localPort: z.number().int().positive().default(8791),
    claudeBin: z.string().default('claude'),
    headlessTimeoutMs: z.number().int().positive().default(15 * 60_000),
    routing: z
        .object({
        recentHours: z.number().positive().default(48),
        recentLimit: z.number().int().positive().default(8),
        activeWindowMin: z.number().nonnegative().default(10),
        classifierModel: z.string().default('haiku'),
        /** Pinned explicitly: --restricted ignores the user's settings, and a resumed session would otherwise keep whatever model it last ran. */
        answerModel: z.string().default('opus'),
        answerEffort: z.enum(EFFORTS).optional(),
    })
        .prefault({}),
    /** Every exchange is posted to a Telegram chat; its owners can answer, approve and correct from there (set up with `agent-bridge telegram`). */
    telegram: z
        .object({
        botToken: z.string().min(1),
        chatId: z.union([z.number(), z.string().min(1)]),
        chatTitle: z.string().optional(),
        /** Telegram users who speak for this machine in that chat. Nobody else's replies or button presses are acted on. */
        owners: z.array(z.object({ id: z.number().int(), name: z.string().min(1).max(100) })).default([]),
    })
        .optional(),
});
export function expandPath(p, home = homedir()) {
    const expanded = resolve(p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p).replace(/(.)\/+$/, '$1');
    // Claude Code records the canonical cwd (e.g. /tmp → /private/tmp), so compare against the same form.
    try {
        return realpathSync.native(expanded);
    }
    catch {
        return expanded;
    }
}
export function parseConfig(raw) {
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`agent-bridge config invalid:\n${parsed.error.issues.map((i) => `  - ${i.message}`).join('\n')}`);
    }
    return parsed.data;
}
export function readRawConfig(path = CONFIG_PATH) {
    if (!existsSync(path))
        throw new Error(`Not set up yet (${path} missing). Run: agent-bridge setup`);
    return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadConfig(path = CONFIG_PATH) {
    return parseConfig(readRawConfig(path));
}
export function writeRawConfig(raw, path = CONFIG_PATH) {
    parseConfig(raw);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}
