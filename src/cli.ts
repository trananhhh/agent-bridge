import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BRIDGE_HOME, CONFIG_PATH, expandPath, loadConfig, readRawConfig, writeRawConfig, type RawConfig } from './config.ts';

const CLI_PATH = fileURLToPath(import.meta.url);
const SERVICE_LABEL = 'com.agent-bridge.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const LOG_PATH = join(BRIDGE_HOME, 'daemon.log');

const HELP = `agent-bridge — Claude Code ⇄ Claude Code across machines

Setup
  init --name <you> [--workdir <dir>]...     create ~/.agent-bridge/config.json
  add-peer <name> <url> [--token <t>] [--workdir <dir>]...
                                             add/replace a peer (token generated if omitted)
  remove-peer <name>
  register-mcp                               register the MCP server in Claude Code (user scope)
  install-service | uninstall-service        run the daemon at login (macOS launchd)

Run
  daemon                                     run the daemon in the foreground
  channel                                    MCP stdio server (started by Claude Code)
  status                                     config, daemon and peer reachability
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

function restartServiceIfInstalled(): void {
  if (!serviceInstalled()) {
    console.log('Restart the daemon to apply (agent-bridge daemon).');
    return;
  }
  tryRun('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${SERVICE_LABEL}`]);
  console.log('Daemon service restarted.');
}

function selfUrl(raw: RawConfig): string {
  const host = raw.listenHost && raw.listenHost !== '0.0.0.0' ? raw.listenHost : (detectTailscaleIp() ?? '<your-tailscale-ip>');
  return `http://${host}:${raw.peerPort ?? 8790}`;
}

function cmdInit(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: 'string' }, workdir: { type: 'string', multiple: true }, force: { type: 'boolean' } },
  });
  if (existsSync(CONFIG_PATH) && !values.force) throw new Error(`${CONFIG_PATH} already exists (use --force to overwrite)`);
  if (!values.name) throw new Error('--name is required (how peers will see you, e.g. anh)');
  const ip = detectTailscaleIp();
  const claudeBin = detectClaudeBin();
  const raw: RawConfig = {
    name: values.name,
    listenHost: ip ?? '0.0.0.0',
    peerPort: 8790,
    localPort: 8791,
    workdirs: values.workdir?.length ? values.workdir.map((d) => expandPath(d)) : [process.cwd()],
    peers: [],
    claudeBin: claudeBin ?? 'claude',
  };
  writeRawConfig(raw);
  console.log(`Wrote ${CONFIG_PATH}`);
  console.log(`  name:      ${raw.name}`);
  console.log(`  listen:    ${raw.listenHost}:8790 ${ip ? '(tailscale)' : '(WARNING: tailscale not detected — listening on all interfaces)'}`);
  console.log(`  workdirs:  ${raw.workdirs.join(', ')}   ← peers' questions are answered only inside these`);
  console.log(`  claude:    ${raw.claudeBin}${claudeBin ? '' : '   (WARNING: claude not found on PATH)'}`);
  console.log(`\nYour peer URL (give it to teammates): ${selfUrl(raw)}`);
}

function cmdAddPeer(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { token: { type: 'string' }, workdir: { type: 'string', multiple: true } },
  });
  const [name, url] = positionals;
  if (!name || !url) throw new Error('usage: agent-bridge add-peer <name> <url> [--token <t>] [--workdir <dir>]...');
  const raw = readRawConfig();
  const generated = !values.token;
  const token = values.token ?? randomBytes(24).toString('hex');
  const peer = { name, url, token, ...(values.workdir?.length && { workdirs: values.workdir.map((d) => expandPath(d)) }) };
  raw.peers = [...(raw.peers ?? []).filter((p) => p.name !== name), peer];
  writeRawConfig(raw);
  console.log(`Peer "${name}" saved → ${url}`);
  if (generated) {
    console.log(`\nSend this to ${name} privately (DM), so their bot can add you back:\n`);
    console.log(`  agent-bridge add-peer ${raw.name} ${selfUrl(raw)} --token ${token}\n`);
  }
  restartServiceIfInstalled();
}

function cmdRemovePeer(argv: string[]): void {
  const [name] = argv;
  if (!name) throw new Error('usage: agent-bridge remove-peer <name>');
  const raw = readRawConfig();
  const before = raw.peers?.length ?? 0;
  raw.peers = (raw.peers ?? []).filter((p) => p.name !== name);
  if (raw.peers.length === before) throw new Error(`no peer named "${name}"`);
  writeRawConfig(raw);
  console.log(`Peer "${name}" removed.`);
  restartServiceIfInstalled();
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  console.log(`config:   ${CONFIG_PATH}`);
  console.log(`me:       ${cfg.name} (listen ${cfg.listenHost}:${cfg.peerPort})`);
  console.log(`workdirs: ${cfg.workdirs.join(', ')}`);
  console.log(`service:  ${serviceInstalled() ? `launchd ${SERVICE_LABEL} (log ${LOG_PATH})` : 'not installed'}`);
  try {
    const s = (await (await fetch(`http://127.0.0.1:${cfg.localPort}/local/status`, { signal: AbortSignal.timeout(3000) })).json()) as {
      live: number;
      outbox: number;
    };
    console.log(`daemon:   running · live sessions ${s.live} · outbox ${s.outbox}`);
  } catch {
    console.log('daemon:   NOT running');
  }
  for (const p of cfg.peers) {
    let state: string;
    try {
      const h = (await (await fetch(`${p.url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(4000) })).json()) as { name?: string };
      state = h.name === p.name ? 'reachable' : `reachable but reports name "${h.name}"`;
    } catch (err) {
      state = `unreachable (${(err as Error).message})`;
    }
    console.log(`peer ${p.name}: ${p.url} · ${state} · workdirs ${p.workdirs.join(', ')}`);
  }
}

function cmdRegisterMcp(): void {
  const cfg = loadConfig();
  tryRun(cfg.claudeBin, ['mcp', 'remove', '-s', 'user', 'agent-bridge']);
  sh(cfg.claudeBin, ['mcp', 'add', '-s', 'user', 'agent-bridge', '--', process.execPath, '--disable-warning=ExperimentalWarning', CLI_PATH, 'channel']);
  console.log('Registered MCP server "agent-bridge" (user scope). Restart open Claude Code sessions to pick it up.');
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
  console.log(`Installed ${PLIST_PATH}; daemon starts now and at every login. Log: ${LOG_PATH}`);
}

function cmdUninstallService(): void {
  tryRun('launchctl', ['bootout', `gui/${process.getuid?.()}/${SERVICE_LABEL}`]);
  rmSync(PLIST_PATH, { force: true });
  console.log('Service removed.');
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      return cmdInit(rest);
    case 'add-peer':
      return cmdAddPeer(rest);
    case 'remove-peer':
      return cmdRemovePeer(rest);
    case 'status':
      return cmdStatus();
    case 'register-mcp':
      return cmdRegisterMcp();
    case 'install-service':
      return cmdInstallService();
    case 'uninstall-service':
      return cmdUninstallService();
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
