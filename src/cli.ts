import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BRIDGE_HOME, CONFIG_PATH, loadConfig, readRawConfig, writeRawConfig, type RawConfig } from './config.ts';

const CLI_PATH = fileURLToPath(import.meta.url);
const SERVICE_LABEL = 'com.agent-bridge.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const LOG_PATH = join(BRIDGE_HOME, 'daemon.log');

const HELP = `agent-bridge — Claude Code ⇄ Claude Code across machines (over Tailscale)

  setup --name <you>            one-time: config + background daemon + MCP for Claude Code
  invite --folder <dir>...      create a one-time invite code (peer may READ these folders)
  accept <code> --folder <dir>...
                                accept an invite (the inviter may READ these folders)
  peers                         list connections
  folders <peer> --folder <dir>...   change what a peer may read
  remove-peer <peer>            disconnect
  status                        daemon + peer reachability
  uninstall                     stop daemon, remove MCP (keeps ~/.agent-bridge)

  daemon | channel              internal: run daemon / MCP stdio server

Normally you don't run these yourself — tell Claude Code "kết nối với <tên>" or paste an ab1_… code.
`;

function sh(bin: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'] }).trim();
}

function tryRun(bin: string, args: string[]): string | undefined {
  try {
    return sh(bin, args, { quiet: true });
  } catch {
    return undefined;
  }
}

function detectTailscaleIp(): string | undefined {
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    const ip = tryRun(bin, ['ip', '-4'])?.split('\n')[0];
    if (ip) return ip;
  }
  return undefined;
}

function detectClaudeBin(): string | undefined {
  // Keep the launcher path (not its realpath): Claude Code's auto-updater swaps the versioned target behind it.
  return tryRun('/bin/sh', ['-c', 'command -v claude']) ?? tryRun('/bin/zsh', ['-lc', 'command -v claude']);
}

function serviceInstalled(): boolean {
  return process.platform === 'darwin' && existsSync(PLIST_PATH);
}

async function daemonApi<T>(path: string, body?: unknown): Promise<T> {
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
    throw new Error('daemon không chạy. Chạy: agent-bridge setup (hoặc agent-bridge daemon)');
  }
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `daemon responded ${res.status}`);
  return json;
}

function folderArgs(argv: string[]): { folders: string[]; positionals: string[] } {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { folder: { type: 'string', multiple: true } } });
  if (!values.folder?.length) throw new Error('cần ít nhất một --folder <dir>');
  return { folders: values.folder, positionals };
}

async function cmdSetup(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { name: { type: 'string' } } });
  const existing = existsSync(CONFIG_PATH) ? readRawConfig() : undefined;
  const name = values.name ?? existing?.name;
  if (!name) throw new Error('--name is required the first time (how teammates see you, e.g. anh)');
  const ip = detectTailscaleIp();
  if (!ip) throw new Error('Tailscale chưa chạy hoặc chưa đăng nhập. Cài https://tailscale.com/download, đăng nhập, rồi chạy lại.');
  const claudeBin = detectClaudeBin();
  if (!claudeBin) throw new Error('không tìm thấy lệnh `claude` trên PATH');
  const raw: RawConfig = { ...existing, name, listenHost: ip, claudeBin };
  writeRawConfig(raw);
  console.log(`✓ config ${CONFIG_PATH} (name=${name}, ${ip}:${raw.peerPort ?? 8790})`);
  if (process.platform === 'darwin') {
    cmdInstallService();
  } else {
    console.log('! Linux: chạy `agent-bridge daemon` dưới systemd/tmux để daemon luôn bật');
  }
  cmdRegisterMcp();
  console.log('\nXong. Mở session Claude Code mới và nói "kết nối với <tên>" hoặc dán mã ab1_… nhận được.');
}

async function cmdInvite(argv: string[]): Promise<void> {
  const { folders } = folderArgs(argv);
  const r = await daemonApi<{ code: string; folders: string[]; expires_at: string }>('/local/invite', { folders });
  console.log(`Gửi mã này cho người kia (dùng 1 lần, hết hạn ${r.expires_at}). Họ sẽ chỉ đọc được: ${r.folders.join(', ')}\n\n${r.code}`);
}

async function cmdAccept(argv: string[]): Promise<void> {
  const { folders, positionals } = folderArgs(argv);
  if (!positionals[0]) throw new Error('usage: agent-bridge accept <ab1_…> --folder <dir>...');
  const r = await daemonApi<{ peer: string; folders: string[] }>('/local/accept', { code: positionals[0], folders });
  console.log(`✓ Đã kết nối với ${r.peer}. ${r.peer} chỉ đọc được: ${r.folders.join(', ')}`);
}

async function cmdPeers(): Promise<void> {
  const r = await daemonApi<{ peers: { name: string; url: string; folders: string[] }[] }>('/local/peers');
  console.log(r.peers.length ? r.peers.map((p) => `${p.name}  ${p.url}  →  ${p.folders.join(', ')}`).join('\n') : 'Chưa kết nối với ai.');
}

async function cmdFolders(argv: string[]): Promise<void> {
  const { folders, positionals } = folderArgs(argv);
  const r = await daemonApi<{ name: string; folders: string[] }>('/local/peers/folders', { name: positionals[0], folders });
  console.log(`✓ ${r.name} giờ chỉ đọc được: ${r.folders.join(', ')}`);
}

async function cmdRemovePeer(argv: string[]): Promise<void> {
  const r = await daemonApi<{ removed: string }>('/local/peers/remove', { name: argv[0] });
  console.log(`✓ Đã ngắt kết nối với ${r.removed}`);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  console.log(`me:      ${cfg.name}  http://${cfg.listenHost}:${cfg.peerPort}`);
  console.log(`service: ${serviceInstalled() ? `launchd (log ${LOG_PATH})` : 'not installed'}`);
  let peers: { name: string; url: string; folders: string[] }[] = [];
  try {
    const s = await daemonApi<{ live: number; outbox: number }>('/local/status');
    peers = (await daemonApi<{ peers: typeof peers }>('/local/peers')).peers;
    console.log(`daemon:  running · live sessions ${s.live} · outbox ${s.outbox}`);
  } catch {
    console.log('daemon:  NOT running');
  }
  for (const p of peers) {
    let state: string;
    try {
      const h = (await (await fetch(`${p.url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(4000) })).json()) as { name?: string };
      state = h.name === p.name ? 'online' : `online but reports "${h.name}"`;
    } catch {
      state = 'offline/unreachable';
    }
    console.log(`peer ${p.name}: ${state} · reads ${p.folders.join(', ')}`);
  }
}

function cmdRegisterMcp(): void {
  const cfg = loadConfig();
  tryRun(cfg.claudeBin, ['mcp', 'remove', '-s', 'user', 'agent-bridge']);
  sh(cfg.claudeBin, ['mcp', 'add', '-s', 'user', 'agent-bridge', '--', process.execPath, '--disable-warning=ExperimentalWarning', CLI_PATH, 'channel']);
  console.log('✓ MCP server "agent-bridge" registered for Claude Code (user scope) — open a new session to use it');
}

function cmdInstallService(): void {
  if (process.platform !== 'darwin') throw new Error('install-service supports macOS only; run `agent-bridge daemon` under your own supervisor (systemd, pm2…)');
  const cfg = loadConfig();
  const claudeDir = cfg.claudeBin.includes('/') ? dirname(cfg.claudeBin) : '';
  const path = [dirname(process.execPath), claudeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const args = [process.execPath, '--disable-warning=ExperimentalWarning', CLI_PATH, 'daemon'];
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  mkdirSync(BRIDGE_HOME, { recursive: true });
  writeFileSync(
    PLIST_PATH,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(path)}</string><key>HOME</key><string>${esc(homedir())}</string>${
    process.env.BRIDGE_HOME ? `<key>BRIDGE_HOME</key><string>${esc(BRIDGE_HOME)}</string>` : ''
  }</dict>
  <key>WorkingDirectory</key><string>${esc(BRIDGE_HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_PATH)}</string>
</dict>
</plist>
`,
  );
  const domain = `gui/${process.getuid?.()}`;
  tryRun('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]);
  sh('launchctl', ['bootstrap', domain, PLIST_PATH]);
  console.log(`✓ daemon running in background, starts at login (log ${LOG_PATH})`);
}

function cmdUninstall(): void {
  tryRun('launchctl', ['bootout', `gui/${process.getuid?.()}/${SERVICE_LABEL}`]);
  rmSync(PLIST_PATH, { force: true });
  const cfg = existsSync(CONFIG_PATH) ? loadConfig() : undefined;
  tryRun(cfg?.claudeBin ?? 'claude', ['mcp', 'remove', '-s', 'user', 'agent-bridge']);
  console.log(`✓ daemon stopped, MCP removed. Data kept in ${BRIDGE_HOME} (delete it to forget all peers).`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'setup':
      return cmdSetup(rest);
    case 'invite':
      return cmdInvite(rest);
    case 'accept':
      return cmdAccept(rest);
    case 'peers':
      return cmdPeers();
    case 'folders':
      return cmdFolders(rest);
    case 'remove-peer':
      return cmdRemovePeer(rest);
    case 'status':
      return cmdStatus();
    case 'uninstall':
      return cmdUninstall();
    case 'daemon':
      return (await import('./daemon-main.ts')).runDaemon();
    case 'channel':
      return (await import('./channel.ts')).runChannel();
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`agent-bridge: ${(err as Error).message}`);
  process.exit(1);
});
