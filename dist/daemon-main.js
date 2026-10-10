import { serve } from '@hono/node-server';
import { createWriteStream } from 'node:fs';
import { format } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRunner } from "./claude-runner.js";
import { BRIDGE_HOME, DB_PATH, VERSION, loadConfig } from "./config.js";
import { createDaemon } from "./daemon.js";
import { listRecentSessions } from "./sessions.js";
import { BridgeStore } from "./store.js";
import { notify, removePidFile, writePidFile } from "./platform.js";
import { tailscaleWhois } from "./tailscale.js";
const OUTBOX_INTERVAL_MS = 30_000;
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
/** Background launchers without stdio redirection (Windows Startup) pass --log. */
function logTo(file) {
    const out = createWriteStream(file, { flags: 'a' });
    const write = (...args) => out.write(`${format(...args)}\n`);
    console.log = write;
    console.error = write;
    process.on('uncaughtException', (err) => {
        write(JSON.stringify({ event: 'crashed', error: String(err?.stack ?? err) }));
        process.exit(1);
    });
}
export async function runDaemon(opts = {}) {
    if (opts.logFile)
        logTo(opts.logFile);
    const cfg = loadConfig();
    const store = new BridgeStore(DB_PATH);
    const publicUrl = `http://${cfg.listenHost}:${cfg.peerPort}`;
    const daemon = createDaemon({
        name: cfg.name,
        publicUrl,
        version: VERSION,
        store,
        runner: createClaudeRunner(cfg.claudeBin),
        listSessions: (allowedDirs) => listRecentSessions(PROJECTS_ROOT, { now: Date.now(), sinceHours: cfg.routing.recentHours, limit: cfg.routing.recentLimit, allowedDirs }),
        headlessTimeoutMs: cfg.headlessTimeoutMs,
        activeWindowMs: cfg.routing.activeWindowMin * 60_000,
        classifierModel: cfg.routing.classifierModel,
        whois: tailscaleWhois,
        notify,
    });
    const peerServer = serve({ fetch: daemon.peerApp.fetch, hostname: cfg.listenHost, port: cfg.peerPort });
    const localServer = serve({ fetch: daemon.localApp.fetch, hostname: '127.0.0.1', port: cfg.localPort });
    writePidFile(BRIDGE_HOME);
    process.on('exit', () => removePidFile(BRIDGE_HOME));
    const outboxTimer = setInterval(() => {
        daemon.flushOutbox().catch((err) => console.error(JSON.stringify({ event: 'outbox_flush_failed', error: String(err) })));
    }, OUTBOX_INTERVAL_MS);
    console.error(JSON.stringify({
        event: 'started',
        version: VERSION,
        name: cfg.name,
        url: publicUrl,
        peers: store.listPeers().map((p) => `${p.name} [${p.folders.join(', ')}]`),
    }));
    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping)
            return;
        stopping = true;
        console.error(JSON.stringify({ event: 'stopping', signal }));
        clearInterval(outboxTimer);
        peerServer.close();
        localServer.close();
        await Promise.race([daemon.idle(), new Promise((r) => setTimeout(r, 5_000))]);
        store.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
