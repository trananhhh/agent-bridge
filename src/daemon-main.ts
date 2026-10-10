import { serve } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRunner } from './claude-runner.ts';
import { DB_PATH, loadConfig } from './config.ts';
import { createDaemon } from './daemon.ts';
import { listRecentSessions } from './sessions.ts';
import { BridgeStore } from './store.ts';

const OUTBOX_INTERVAL_MS = 30_000;
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

export async function runDaemon(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.peers.length === 0) console.error('warning: no peers configured yet (agent-bridge add-peer <name> <url>)');
  const store = new BridgeStore(DB_PATH);

  const daemon = createDaemon({
    name: cfg.name,
    peers: cfg.peers,
    store,
    runner: createClaudeRunner(cfg.claudeBin),
    listSessions: (allowedDirs) =>
      listRecentSessions(PROJECTS_ROOT, { now: Date.now(), sinceHours: cfg.routing.recentHours, limit: cfg.routing.recentLimit, allowedDirs }),
    headlessAllowedTools: cfg.headless.allowedTools,
    headlessTimeoutMs: cfg.headless.timeoutMs,
    activeWindowMs: cfg.routing.activeWindowMin * 60_000,
    classifierModel: cfg.routing.classifierModel,
  });

  const peerServer = serve({ fetch: daemon.peerApp.fetch, hostname: cfg.listenHost, port: cfg.peerPort });
  const localServer = serve({ fetch: daemon.localApp.fetch, hostname: '127.0.0.1', port: cfg.localPort });
  const outboxTimer = setInterval(() => {
    daemon.flushOutbox().catch((err) => console.error(JSON.stringify({ event: 'outbox_flush_failed', error: String(err) })));
  }, OUTBOX_INTERVAL_MS);

  console.error(
    JSON.stringify({
      event: 'started',
      name: cfg.name,
      peer: `${cfg.listenHost}:${cfg.peerPort}`,
      local: `127.0.0.1:${cfg.localPort}`,
      peers: cfg.peers.map((p) => `${p.name}=${p.url} [${p.workdirs.join(', ')}]`),
    }),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
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
