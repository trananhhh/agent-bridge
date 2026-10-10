import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAgentNote } from './agent-note.ts';
import { BRIDGE_HOME, CONFIG_PATH, VERSION, expandPath, loadConfig, readRawConfig, writeRawConfig, type RawConfig } from './config.ts';
import { findBridges, parseTailscaleStatus, type FoundBridge } from './discovery.ts';
import { IS_WIN, claudeInvocation, copyToClipboard, findClaude, installService, openUrl, serviceInstalled, uninstallService } from './platform.ts';
import { tailscaleStatus, tailscaleWhois } from './tailscale.ts';

const CLI_PATH = fileURLToPath(import.meta.url);
const LOG_PATH = join(BRIDGE_HOME, 'daemon.log');
const INSTALL_CMD = 'npm install -g https://github.com/trananhhh/agent-bridge/tarball/main';
const WAIT_FOR_ANSWER_MS = 15 * 60_000;

const TAILSCALE_GUIDE = `Link Tailscale with a colleague (separate accounts, once per pair):
  1. Open https://login.tailscale.com/admin/machines
  2. On your machine's row: ⋯ → "Share…" → copy the share link (or enter their email)
  3. Send the link to your colleague → they open it and click Accept
  4. They do the same for their machine and send you the link → you click Accept
  Share BOTH ways: a shared machine can receive connections but cannot initiate them.`;

const HELP = `agent-bridge ${VERSION} — let Claude Code agents on different machines talk to each other (over Tailscale)

  agent-bridge                  wizard: setup → handle pending requests → connect someone new
  agent-bridge setup            pick a name, start the background daemon, register the MCP server
  agent-bridge connect [ip]     find agent-bridge machines on Tailscale (or give an IP), pick folders, send a request
  agent-bridge requests         review & accept pending connection requests
  agent-bridge peers            list connections
  agent-bridge note <name>      print the note to paste into Claude Code again
  agent-bridge folders <name>   change which folders that person can read
  agent-bridge remove <name>    disconnect
  agent-bridge status           check daemon, Tailscale and each connection
  agent-bridge uninstall        stop the daemon, remove the MCP server (keeps ~/.agent-bridge)
`;

// ── small terminal helpers ────────────────────────────────────────────────

// One reader for the whole process: piped input (scripts, Claude running the CLI) arrives before prompts are asked.
let reader: { next: () => Promise<string | undefined>; close: () => void } | undefined;
function lines() {
  if (reader) return reader;
  const io = createInterface({ input: process.stdin, terminal: false });
  const queue: string[] = [];
  const waiters: ((line: string | undefined) => void)[] = [];
  let closed = false;
  io.on('line', (l) => (waiters.length ? waiters.shift()!(l) : queue.push(l)));
  io.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!(undefined);
  });
  reader = {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(undefined) : new Promise((r) => waiters.push(r))),
    close: () => io.close(),
  };
  return reader;
}

async function ask(question: string, fallback?: string): Promise<string> {
  process.stdout.write(`? ${question}${fallback ? ` [${fallback}]` : ''}: `);
  const line = await lines().next();
  if (line === undefined) {
    process.stdout.write('\n');
    if (fallback !== undefined) return fallback;
    throw new Error('no more input');
  }
  if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
  return line.trim() || fallback || '';
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const a = (await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a ? a.startsWith('y') : defaultYes;
}

async function askFolders(question: string): Promise<string[]> {
  for (;;) {
    const raw = await ask(`${question} — paths, comma-separated`, process.cwd());
    const folders = raw.split(',').map((f) => f.trim()).filter(Boolean).map((f) => expandPath(f));
    const missing = folders.filter((f) => !existsSync(f) || !statSync(f).isDirectory());
    if (folders.length && missing.length === 0) return [...new Set(folders)];
    console.log(`  ✗ not found: ${missing.join(', ') || '(empty)'}`);
  }
}

function sh(bin: string, args: string[], input?: string): string {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, input, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).trim();
}

function tryRun(bin: string, args: string[], input?: string): string | undefined {
  try {
    return sh(bin, args, input);
  } catch {
    return undefined;
  }
}

function printNote(note: string): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}\nPaste this into your Claude Code:\n${line}\n${note}\n${line}`);
  if (copyToClipboard(note)) console.log('(copied to clipboard)');
}

// ── daemon API ─────────────────────────────────────────────────────────────

async function api<T>(path: string, body?: unknown): Promise<T> {
  const cfg = loadConfig();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.localPort}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('daemon is not running. Run: agent-bridge setup');
  }
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `daemon responded ${res.status}`);
  return json;
}

interface PeerView {
  name: string;
  url: string;
  folders: string[];
  remote_folders: string[];
}
interface RequestView {
  id: string;
  name: string;
  url: string;
  identity?: string;
  folders: string[];
  status: 'pending' | 'accepted' | 'declined';
  remote_folders?: string[];
}

const hostOf = (url: string) => new URL(url).hostname;

// ── setup ──────────────────────────────────────────────────────────────────

function registerMcp(claudeBin: string): void {
  const inv = claudeInvocation(claudeBin);
  tryRun(inv.command, [...inv.args, 'mcp', 'remove', '-s', 'user', 'agent-bridge']);
  sh(inv.command, [...inv.args, 'mcp', 'add', '-s', 'user', 'agent-bridge', '--', process.execPath, '--disable-warning=ExperimentalWarning', CLI_PATH, 'channel']);
}

async function waitForDaemon(port: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/local/status`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function cmdSetup(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { name: { type: 'string' } } });
  if (/[\\/]_npx[\\/]/.test(CLI_PATH)) {
    throw new Error(`agent-bridge runs a background daemon, so install it globally instead of using npx:\n  ${INSTALL_CMD}\n  agent-bridge`);
  }
  const ts = await tailscaleStatus();
  const selfIp = ts ? parseTailscaleStatus(ts).selfIp : undefined;
  if (!selfIp) throw new Error('Tailscale is not installed or not logged in. Install https://tailscale.com/download, log in, then run this again.');
  const claudeBin = findClaude();
  if (!claudeBin) throw new Error('`claude` not found. Install Claude Code first: https://claude.com/claude-code');

  const existing = existsSync(CONFIG_PATH) ? readRawConfig() : undefined;
  const suggested = (existing?.name ?? userInfo().username).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  let name = values.name ?? (await ask('Your name (shown to colleagues; lowercase, no spaces)', suggested));
  while (!/^[a-z0-9_-]{1,50}$/.test(name)) name = await ask('Use only a-z 0-9 _ -', suggested);

  const raw: RawConfig = { ...existing, name, listenHost: selfIp, claudeBin };
  writeRawConfig(raw);
  console.log(`✓ name: ${name} · Tailscale ${selfIp}`);
  const service = installService({
    nodePath: process.execPath,
    cliPath: CLI_PATH,
    bridgeHome: BRIDGE_HOME,
    logPath: LOG_PATH,
    bridgeHomeEnv: process.env.BRIDGE_HOME,
    claudeDir: claudeBin.includes('/') ? dirname(claudeBin) : undefined,
  });
  if (service) console.log(`✓ daemon running in the background — ${service} (log: ${LOG_PATH})`);
  else console.log('! Linux: keep `agent-bridge daemon` running under systemd/tmux yourself');
  registerMcp(claudeBin);
  console.log('✓ MCP server "agent-bridge" registered for Claude Code');
  if (!(await waitForDaemon(raw.localPort ?? 8791))) console.log(`! daemon not responding yet — check ${LOG_PATH}`);
  console.log(
    IS_WIN
      ? '  If Windows Firewall asks about Node.js → click Allow (tick Private and Public).'
      : '  If macOS asks to "Allow node to accept incoming connections" → click Allow.',
  );
}

// ── connect / requests ─────────────────────────────────────────────────────

async function cmdConnect(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  if (argv[0]) return connectTo(await bridgeAt(argv[0], cfg.peerPort));
  console.log('Looking for agent-bridge machines on Tailscale…');
  const ts = await tailscaleStatus();
  if (!ts) throw new Error('cannot read Tailscale status (is the app running?)');
  const { peers: online } = parseTailscaleStatus(ts);
  const connected = new Set((await api<{ peers: PeerView[] }>('/local/peers')).peers.map((p) => p.name));
  const found = (await findBridges(online, { port: cfg.peerPort })).filter((b) => b.name !== cfg.name);

  if (found.length === 0) {
    console.log(`\nNobody found. Machines online in your Tailscale: ${online.map((p) => p.host).join(', ') || '(none)'}`);
    console.log(`- Colleague's machine not listed → Tailscale isn't shared yet:\n\n${TAILSCALE_GUIDE}\n`);
    console.log('- Their machine is listed but not found → they haven\'t run `agent-bridge` yet, or a firewall blocks node.');
    if (await confirm('Open the Tailscale admin page to share your machine?', false)) openUrl('https://login.tailscale.com/admin/machines');
    return;
  }

  console.log('');
  found.forEach((b, i) => console.log(`  ${i + 1}) ${b.name}  — machine ${b.host} (${b.ip})${connected.has(b.name) ? '  [connected]' : ''}`));
  let pick: number;
  do pick = Number(await ask('Connect to number', found.length === 1 ? '1' : undefined));
  while (!(pick >= 1 && pick <= found.length));
  await connectTo(found[pick - 1]);
}

/** Direct target (`agent-bridge connect 100.x.y.z`) when scanning can't see the machine. */
async function bridgeAt(arg: string, port: number): Promise<FoundBridge> {
  const url = arg.includes('://') ? arg.replace(/\/$/, '') : /:\d+$/.test(arg) ? `http://${arg}` : `http://${arg}:${port}`;
  const [hit] = await findBridges([{ ip: hostOf(url), host: hostOf(url) }], { port: Number(new URL(url).port) || port });
  if (!hit) throw new Error(`${url} is not running agent-bridge (or is unreachable over Tailscale)`);
  return hit;
}

async function connectTo(target: FoundBridge): Promise<void> {
  const folders = await askFolders(`Folders ${target.name} may READ (read-only; includes any .env inside)`);
  if (!(await confirm(`Send a connection request to ${target.name}, letting them read ${folders.join(', ')}?`))) return;
  const { request_id } = await api<{ request_id: string }>('/local/connect', { url: target.url, folders });

  console.log(`⏳ Sent. Waiting for ${target.name} to accept — they get a notification and run "agent-bridge" to accept.`);
  console.log('   (Ctrl+C to stop waiting; if they accept later, run "agent-bridge note ' + target.name + '" for the note)');
  const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await api<RequestView>(`/local/requests/${request_id}`);
    if (r.status === 'declined') return console.log(`✗ ${target.name} declined.`);
    if (r.status === 'accepted') {
      console.log(`✓ Connected to ${target.name}. You can ask them about: ${(r.remote_folders ?? []).join(', ')}`);
      const identity = await tailscaleWhois(target.ip);
      printNote(buildAgentNote({ peer: target.name, identity, theirFolders: r.remote_folders ?? [], myFolders: folders }));
      return;
    }
  }
  console.log('Stopped waiting. The request stays open — once they accept, run "agent-bridge note ' + target.name + '".');
}

async function handleRequests(): Promise<number> {
  const { incoming } = await api<{ incoming: RequestView[] }>('/local/requests');
  for (const r of incoming) {
    console.log(`\n📨 ${r.name}${r.identity ? ` (${r.identity})` : ''} wants to connect.`);
    console.log(`   ${r.name} lets you ask about: ${r.folders.join(', ') || '(no folders)'}`);
    if (!(await confirm('Accept?'))) {
      await api('/local/requests/answer', { request_id: r.id, accept: false });
      console.log('   ✗ declined');
      continue;
    }
    const folders = await askFolders(`Folders ${r.name} may READ (read-only; includes any .env inside)`);
    await api('/local/requests/answer', { request_id: r.id, accept: true, folders });
    console.log(`✓ Connected to ${r.name}.`);
    printNote(buildAgentNote({ peer: r.name, identity: r.identity, theirFolders: r.folders, myFolders: folders }));
  }
  return incoming.length;
}

async function cmdRequests(): Promise<void> {
  if ((await handleRequests()) === 0) console.log('No pending connection requests.');
}

// ── peers ──────────────────────────────────────────────────────────────────

async function cmdPeers(): Promise<void> {
  const { peers } = await api<{ peers: PeerView[] }>('/local/peers');
  if (!peers.length) return console.log('Not connected to anyone. Run: agent-bridge connect');
  for (const p of peers) {
    console.log(`${p.name}  (${hostOf(p.url)})`);
    console.log(`  you can ask about: ${p.remote_folders.join(', ') || '?'}`);
    console.log(`  they can read:     ${p.folders.join(', ')}`);
  }
}

async function cmdNote(argv: string[]): Promise<void> {
  const { peers } = await api<{ peers: PeerView[] }>('/local/peers');
  const p = peers.find((x) => x.name === argv[0]);
  if (!p) throw new Error(`no connection named "${argv[0] ?? ''}". See: agent-bridge peers`);
  const identity = await tailscaleWhois(hostOf(p.url));
  printNote(buildAgentNote({ peer: p.name, identity, theirFolders: p.remote_folders, myFolders: p.folders }));
}

async function cmdFolders(argv: string[]): Promise<void> {
  if (!argv[0]) throw new Error('usage: agent-bridge folders <name>');
  const folders = await askFolders(`Folders ${argv[0]} may READ`);
  await api('/local/peers/folders', { name: argv[0], folders });
  console.log(`✓ ${argv[0]} can now read only: ${folders.join(', ')}`);
}

async function cmdRemove(argv: string[]): Promise<void> {
  await api('/local/peers/remove', { name: argv[0] });
  console.log(`✓ disconnected from ${argv[0]}`);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  console.log(`agent-bridge ${VERSION} · ${cfg.name} · http://${cfg.listenHost}:${cfg.peerPort}`);
  console.log(`service: ${serviceInstalled() ? `installed (log ${LOG_PATH})` : 'not installed'}`);
  let peers: PeerView[] = [];
  try {
    const s = await api<{ live: number; outbox: number }>('/local/status');
    peers = (await api<{ peers: PeerView[] }>('/local/peers')).peers;
    console.log(`daemon:  running · live sessions ${s.live} · queued messages ${s.outbox}`);
  } catch {
    console.log('daemon:  NOT running → agent-bridge setup');
  }
  for (const p of peers) {
    let state = 'offline / unreachable';
    try {
      const h = (await (await fetch(`${p.url}/health`, { signal: AbortSignal.timeout(4000) })).json()) as { name?: string };
      state = h.name === p.name ? 'online' : `online but reports itself as "${h.name}"`;
    } catch {
      // stays offline
    }
    console.log(`${p.name}: ${state}`);
  }
}

function cmdUninstall(): void {
  uninstallService(BRIDGE_HOME);
  const inv = claudeInvocation(existsSync(CONFIG_PATH) ? loadConfig().claudeBin : 'claude');
  tryRun(inv.command, [...inv.args, 'mcp', 'remove', '-s', 'user', 'agent-bridge']);
  console.log(`✓ daemon stopped and MCP server removed. Data kept in ${BRIDGE_HOME} (delete it to forget all connections).`);
}

async function cmdHome(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    await cmdSetup([]);
    console.log('');
  }
  if ((await handleRequests()) > 0) return;
  const { peers } = await api<{ peers: PeerView[] }>('/local/peers');
  if (peers.length) {
    console.log(`Connected: ${peers.map((p) => p.name).join(', ')}`);
    if (!(await confirm('Connect someone new?'))) return;
  }
  await cmdConnect([]);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
      return cmdHome();
    case 'setup':
      return cmdSetup(rest);
    case 'connect':
      return cmdConnect(rest);
    case 'requests':
      return cmdRequests();
    case 'peers':
      return cmdPeers();
    case 'note':
      return cmdNote(rest);
    case 'folders':
      return cmdFolders(rest);
    case 'remove':
      return cmdRemove(rest);
    case 'status':
      return cmdStatus();
    case 'uninstall':
      return cmdUninstall();
    case 'daemon': {
      const { values } = parseArgs({ args: rest, options: { log: { type: 'string' } } });
      return (await import('./daemon-main.ts')).runDaemon({ logFile: values.log });
    }
    case 'channel':
      return (await import('./channel.ts')).runChannel();
    case 'version':
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      console.log(HELP);
      if (!['help', '--help', '-h'].includes(cmd)) process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`✗ ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => reader?.close());
