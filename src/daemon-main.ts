import { serve } from '@hono/node-server';
import { createWriteStream } from 'node:fs';
import { format } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRunner } from './claude-runner.ts';
import { BRIDGE_HOME, DB_PATH, VERSION, loadConfig, readRawConfig } from './config.ts';
import { createDaemon, peerForToken } from './daemon.ts';
import { listRecentSessions } from './sessions.ts';
import { BridgeStore } from './store.ts';
import { installGlobalPackage, notify, relaunchService, removePidFile, serviceInstalled, writePidFile } from './platform.ts';
import { tailscaleWhois } from './tailscale.ts';
import { createTelegramMirror, telegramCall } from './telegram.ts';
import { LATEST_COMMIT_URL, createUpdater, packageUrlAt, tarballAt } from './updater.ts';
import { createTelegramInbox } from './telegram-inbox.ts';

const OUTBOX_INTERVAL_MS = 30_000;
const MIRROR_INTERVAL_MS = 3_000;
/** Agents often send one question as several messages a few seconds apart. */
const COALESCE_MS = 10_000;
const UPDATE_CHECK_MS = 6 * 3600_000;
const FIRST_UPDATE_CHECK_MS = 2 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/** Background launchers without stdio redirection (Windows Startup) pass --log. */
function logTo(file: string): void {
  const out = createWriteStream(file, { flags: 'a' });
  const write = (...args: unknown[]) => out.write(`${format(...args)}\n`);
  console.log = write;
  console.error = write;
  process.on('uncaughtException', (err) => {
    write(JSON.stringify({ event: 'crashed', error: String(err?.stack ?? err) }));
    process.exit(1);
  });
}

export async function runDaemon(opts: { logFile?: string } = {}): Promise<void> {
  if (opts.logFile) logTo(opts.logFile);
  const cfg = loadConfig();
  const store = new BridgeStore(DB_PATH);
  const publicUrl = `http://${cfg.listenHost}:${cfg.peerPort}`;
  const log = (event: string, data?: Record<string, unknown>) => console.error(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
  // 0.7.0 kept owners in the config; they live in the store now.
  const legacyOwners = (readRawConfig() as { telegram?: { owners?: { id: number; name: string }[] } }).telegram?.owners ?? [];
  for (const o of legacyOwners) if (!store.telegramOwner(o.id)) store.setTelegramOwner({ ...o, machine: cfg.name });
  /** Registered at run time (a one-time link), so read on every use. */
  const ownerNames = () => store.telegramOwners(cfg.name).map((o) => o.name).join(' / ') || undefined;
  const readsBot = Boolean(cfg.telegram && !cfg.telegram.hub);

  const daemon = createDaemon({
    name: cfg.name,
    publicUrl,
    version: VERSION,
    store,
    runner: createClaudeRunner(cfg.claudeBin),
    listSessions: (allowedDirs) =>
      listRecentSessions(PROJECTS_ROOT, { now: Date.now(), sinceHours: cfg.routing.recentHours, limit: cfg.routing.recentLimit, allowedDirs }),
    headlessTimeoutMs: cfg.headlessTimeoutMs,
    activeWindowMs: cfg.routing.activeWindowMin * 60_000,
    classifierModel: cfg.routing.classifierModel,
    answerModel: cfg.routing.answerModel,
    answerEffort: cfg.routing.answerEffort,
    mirrorChat: cfg.telegram ? String(cfg.telegram.chatId) : undefined,
    ownerReview: cfg.telegram ? { owners: ownerNames } : undefined,
    coalesceMs: COALESCE_MS,
    whois: tailscaleWhois,
    notify,
  });

  const mirror = cfg.telegram ? createTelegramMirror({ store, selfName: cfg.name, target: cfg.telegram, owners: () => store.telegramOwners(cfg.name), log }) : undefined;
  // Mounted even before Telegram is set up here: joining a shared bot happens through these endpoints.
  const inbox = createTelegramInbox({
    store,
    selfName: cfg.name,
    settings: () => cfg.telegram,
    actions: daemon,
    authenticate: (authorization) => peerForToken(authorization, store.listPeers()),
    log,
    afterAction: () => void tickMirror(),
  });
  inbox.mount(daemon.peerApp, daemon.localApp);

  daemon.recover();
  const peerServer = serve({ fetch: daemon.peerApp.fetch, hostname: cfg.listenHost, port: cfg.peerPort });
  const localServer = serve({ fetch: daemon.localApp.fetch, hostname: '127.0.0.1', port: cfg.localPort });
  writePidFile(BRIDGE_HOME);
  process.on('exit', () => removePidFile(BRIDGE_HOME));
  const outboxTimer = setInterval(() => {
    daemon.flushOutbox().catch((err) => console.error(JSON.stringify({ event: 'outbox_flush_failed', error: String(err) })));
  }, OUTBOX_INTERVAL_MS);

  const tickMirror = () => mirror?.tick().catch((err) => log('telegram_mirror_failed', { error: String(err) }));
  const mirrorTimer = mirror && setInterval(tickMirror, MIRROR_INTERVAL_MS);
  let stopping = false;
  void (async () => {
    while (readsBot && !stopping) {
      const wait = await inbox.pollOnce();
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
  })();

  console.error(
    JSON.stringify({
      event: 'started',
      telegram: cfg.telegram?.chatTitle ?? cfg.telegram?.chatId,
      owners: ownerNames(),
      reads_bot: cfg.telegram ? (readsBot ? 'here' : `via ${cfg.telegram.hub}`) : undefined,
      answer: [cfg.routing.answerModel, cfg.routing.answerEffort].filter(Boolean).join(' '),
      auto_update: cfg.autoUpdate,
      version: VERSION,
      name: cfg.name,
      url: publicUrl,
      peers: store.listPeers().map((p) => `${p.name} [${p.folders.join(', ')}]`),
    }),
  );

  const shutdown = async (signal: string, relaunch = false) => {
    if (stopping) return;
    stopping = true;
    console.error(JSON.stringify({ event: 'stopping', signal }));
    clearInterval(outboxTimer);
    clearInterval(updateTimer);
    if (mirrorTimer) clearInterval(mirrorTimer);
    await tickMirror();
    peerServer.close();
    localServer.close();
    await Promise.race([daemon.idle(), new Promise((r) => setTimeout(r, 5_000))]);
    store.close();
    if (relaunch) relaunchService();
    process.exit(0);
  };

  const announce = async (text: string) => {
    log('notice', { text });
    if (cfg.telegram) await telegramCall(cfg.telegram.botToken, 'sendMessage', { chat_id: cfg.telegram.chatId, text });
    else notify('agent-bridge', text);
  };
  const fetchJson = async <T>(url: string): Promise<T> => (await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })).json() as Promise<T>;
  const updater = createUpdater({
    name: cfg.name,
    current: VERSION,
    manualBecause: !cfg.autoUpdate ? 'auto-update is off' : !serviceInstalled() ? 'no background service here to restart it' : undefined,
    store,
    fetchLatest: async () => {
      const { sha } = await fetchJson<{ sha?: unknown }>(LATEST_COMMIT_URL);
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('could not read the latest commit');
      const { version } = await fetchJson<{ version?: unknown }>(packageUrlAt(sha));
      if (typeof version !== 'string') throw new Error('no version in the published package.json');
      return { version, ref: sha };
    },
    install: (ref) => installGlobalPackage(tarballAt(ref)),
    // Answers being written finish first; the service manager then starts the new version.
    restart: async () => {
      await daemon.idle();
      await shutdown('update', true);
    },
    peers: () => store.listPeers(),
    peerVersion: async (url) => (await fetchJson<{ version?: string }>(`${url.replace(/\/$/, '')}/health`)).version,
    announce,
    log,
  });
  void updater.announceRestart();
  const checkForUpdates = () => void updater.check();
  setTimeout(checkForUpdates, FIRST_UPDATE_CHECK_MS).unref();
  const updateTimer = setInterval(checkForUpdates, UPDATE_CHECK_MS);

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
