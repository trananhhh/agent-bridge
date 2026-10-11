import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAgentNote } from "./agent-note.js";
import { BRIDGE_HOME, CONFIG_PATH, VERSION, expandPath, loadConfig, readRawConfig, writeRawConfig } from "./config.js";
import { findBridges, parseTailscaleStatus } from "./discovery.js";
import { IS_WIN, claudeInvocation, copyToClipboard, findClaude, installService, openUrl, serviceInstalled, uninstallService } from "./platform.js";
import { shortThreadId } from "./protocol.js";
import { tailscaleStatus, tailscaleWhois } from "./tailscale.js";
import { channelsFromUpdates, telegramCall } from "./telegram.js";
const CLI_PATH = fileURLToPath(import.meta.url);
const LOG_PATH = join(BRIDGE_HOME, 'daemon.log');
const INSTALL_CMD = 'npm install -g --prefer-online https://github.com/trananhhh/agent-bridge/tarball/main';
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
  agent-bridge log [thread] [-f] what the agents said to each other (-f: keep watching)
  agent-bridge telegram [off]   post every message to a read-only Telegram channel (--token, --chat to skip prompts)
  agent-bridge status           check daemon, Tailscale and each connection
  agent-bridge uninstall        stop the daemon, remove the MCP server (keeps ~/.agent-bridge)
`;
// ── small terminal helpers ────────────────────────────────────────────────
// One reader for the whole process: piped input (scripts, Claude running the CLI) arrives before prompts are asked.
let reader;
function lines() {
    if (reader)
        return reader;
    const io = createInterface({ input: process.stdin, terminal: false });
    const queue = [];
    const waiters = [];
    let closed = false;
    io.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
    io.on('close', () => {
        closed = true;
        while (waiters.length)
            waiters.shift()(undefined);
    });
    reader = {
        next: () => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(undefined) : new Promise((r) => waiters.push(r))),
        close: () => io.close(),
    };
    return reader;
}
async function ask(question, fallback) {
    process.stdout.write(`? ${question}${fallback ? ` [${fallback}]` : ''}: `);
    const line = await lines().next();
    if (line === undefined) {
        process.stdout.write('\n');
        if (fallback !== undefined)
            return fallback;
        throw new Error('no more input');
    }
    if (!process.stdin.isTTY)
        process.stdout.write(`${line}\n`);
    return line.trim() || fallback || '';
}
async function confirm(question, defaultYes = true) {
    const a = (await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`)).toLowerCase();
    return a ? a.startsWith('y') : defaultYes;
}
async function askFolders(question) {
    for (;;) {
        const raw = await ask(`${question} — paths, comma-separated`, process.cwd());
        const folders = raw.split(',').map((f) => f.trim()).filter(Boolean).map((f) => expandPath(f));
        const missing = folders.filter((f) => !existsSync(f) || !statSync(f).isDirectory());
        if (folders.length && missing.length === 0)
            return [...new Set(folders)];
        console.log(`  ✗ not found: ${missing.join(', ') || '(empty)'}`);
    }
}
function sh(bin, args, input) {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, input, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).trim();
}
function tryRun(bin, args, input) {
    try {
        return sh(bin, args, input);
    }
    catch {
        return undefined;
    }
}
function printNote(note) {
    const line = '─'.repeat(60);
    console.log(`\n${line}\nPaste this into your Claude Code:\n${line}\n${note}\n${line}`);
    if (copyToClipboard(note))
        console.log('(copied to clipboard)');
}
// ── daemon API ─────────────────────────────────────────────────────────────
async function api(path, body) {
    const cfg = loadConfig();
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${cfg.localPort}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20_000),
        });
    }
    catch {
        throw new Error('daemon is not running. Run: agent-bridge setup');
    }
    const json = (await res.json().catch(() => ({})));
    if (res.status === 404 && !json.error)
        throw new Error(`the running daemon is older than this CLI (${VERSION}). Restart it: agent-bridge setup`);
    if (!res.ok)
        throw new Error(json.error ?? `daemon responded ${res.status}`);
    return json;
}
const hostOf = (url) => new URL(url).hostname;
// ── setup ──────────────────────────────────────────────────────────────────
function registerMcp(claudeBin) {
    const inv = claudeInvocation(claudeBin);
    tryRun(inv.command, [...inv.args, 'mcp', 'remove', '-s', 'user', 'agent-bridge']);
    sh(inv.command, [...inv.args, 'mcp', 'add', '-s', 'user', 'agent-bridge', '--', process.execPath, '--disable-warning=ExperimentalWarning', CLI_PATH, 'channel']);
}
async function waitForDaemon(port) {
    for (let i = 0; i < 20; i++) {
        try {
            await fetch(`http://127.0.0.1:${port}/local/status`, { signal: AbortSignal.timeout(500) });
            return true;
        }
        catch {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    return false;
}
/** Installs (or reinstalls, which restarts) the background service. */
function startDaemon(claudeBin) {
    return installService({
        nodePath: process.execPath,
        cliPath: CLI_PATH,
        bridgeHome: BRIDGE_HOME,
        logPath: LOG_PATH,
        bridgeHomeEnv: process.env.BRIDGE_HOME,
        claudeDir: claudeBin.includes('/') ? dirname(claudeBin) : undefined,
    });
}
async function restartDaemon(raw) {
    if (!startDaemon(raw.claudeBin ?? 'claude'))
        return console.log('! restart `agent-bridge daemon` yourself to apply this');
    if (!(await waitForDaemon(raw.localPort ?? 8791)))
        console.log(`! daemon not responding yet — check ${LOG_PATH}`);
}
async function cmdSetup(argv) {
    const { values } = parseArgs({ args: argv, options: { name: { type: 'string' } } });
    if (/[\\/]_npx[\\/]/.test(CLI_PATH)) {
        throw new Error(`agent-bridge runs a background daemon, so install it globally instead of using npx:\n  ${INSTALL_CMD}\n  agent-bridge`);
    }
    const ts = await tailscaleStatus();
    const selfIp = ts ? parseTailscaleStatus(ts).selfIp : undefined;
    if (!selfIp)
        throw new Error('Tailscale is not installed or not logged in. Install https://tailscale.com/download, log in, then run this again.');
    const claudeBin = findClaude();
    if (!claudeBin)
        throw new Error('`claude` not found. Install Claude Code first: https://claude.com/claude-code');
    const existing = existsSync(CONFIG_PATH) ? readRawConfig() : undefined;
    const suggested = (existing?.name ?? userInfo().username).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    let name = values.name ?? (await ask('Your name (shown to colleagues; lowercase, no spaces)', suggested));
    while (!/^[a-z0-9_-]{1,50}$/.test(name))
        name = await ask('Use only a-z 0-9 _ -', suggested);
    const raw = { ...existing, name, listenHost: selfIp, claudeBin };
    writeRawConfig(raw);
    console.log(`✓ name: ${name} · Tailscale ${selfIp}`);
    const service = startDaemon(claudeBin);
    if (service)
        console.log(`✓ daemon running in the background — ${service} (log: ${LOG_PATH})`);
    else
        console.log('! Linux: keep `agent-bridge daemon` running under systemd/tmux yourself');
    registerMcp(claudeBin);
    console.log('✓ MCP server "agent-bridge" registered for Claude Code');
    if (!(await waitForDaemon(raw.localPort ?? 8791)))
        console.log(`! daemon not responding yet — check ${LOG_PATH}`);
    console.log(IS_WIN
        ? '  If Windows Firewall asks about Node.js → click Allow (tick Private and Public).'
        : '  If macOS asks to "Allow node to accept incoming connections" → click Allow.');
}
// ── connect / requests ─────────────────────────────────────────────────────
async function cmdConnect(argv) {
    const cfg = loadConfig();
    if (argv[0])
        return connectTo(await bridgeAt(argv[0], cfg.peerPort));
    console.log('Looking for agent-bridge machines on Tailscale…');
    const ts = await tailscaleStatus();
    if (!ts)
        throw new Error('cannot read Tailscale status (is the app running?)');
    const { peers: online } = parseTailscaleStatus(ts);
    const connected = new Set((await api('/local/peers')).peers.map((p) => p.name));
    const found = (await findBridges(online, { port: cfg.peerPort })).filter((b) => b.name !== cfg.name);
    if (found.length === 0) {
        console.log(`\nNobody found. Machines online in your Tailscale: ${online.map((p) => p.host).join(', ') || '(none)'}`);
        console.log(`- Colleague's machine not listed → Tailscale isn't shared yet:\n\n${TAILSCALE_GUIDE}\n`);
        console.log('- Their machine is listed but not found → they haven\'t run `agent-bridge` yet, or a firewall blocks node.');
        if (await confirm('Open the Tailscale admin page to share your machine?', false))
            openUrl('https://login.tailscale.com/admin/machines');
        return;
    }
    console.log('');
    found.forEach((b, i) => console.log(`  ${i + 1}) ${b.name}  — machine ${b.host} (${b.ip})${connected.has(b.name) ? '  [connected]' : ''}`));
    let pick;
    do
        pick = Number(await ask('Connect to number', found.length === 1 ? '1' : undefined));
    while (!(pick >= 1 && pick <= found.length));
    await connectTo(found[pick - 1]);
}
/** Direct target (`agent-bridge connect 100.x.y.z`) when scanning can't see the machine. */
async function bridgeAt(arg, port) {
    const url = arg.includes('://') ? arg.replace(/\/$/, '') : /:\d+$/.test(arg) ? `http://${arg}` : `http://${arg}:${port}`;
    const [hit] = await findBridges([{ ip: hostOf(url), host: hostOf(url) }], { port: Number(new URL(url).port) || port });
    if (!hit)
        throw new Error(`${url} is not running agent-bridge (or is unreachable over Tailscale)`);
    return hit;
}
async function connectTo(target) {
    const folders = await askFolders(`Folders ${target.name} may READ (read-only; includes any .env inside)`);
    if (!(await confirm(`Send a connection request to ${target.name}, letting them read ${folders.join(', ')}?`)))
        return;
    const { request_id } = await api('/local/connect', { url: target.url, folders });
    console.log(`⏳ Sent. Waiting for ${target.name} to accept — they get a notification and run "agent-bridge" to accept.`);
    console.log('   (Ctrl+C to stop waiting; if they accept later, run "agent-bridge note ' + target.name + '" for the note)');
    const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await api(`/local/requests/${request_id}`);
        if (r.status === 'declined')
            return console.log(`✗ ${target.name} declined.`);
        if (r.status === 'accepted') {
            console.log(`✓ Connected to ${target.name}. You can ask them about: ${(r.remote_folders ?? []).join(', ')}`);
            const identity = await tailscaleWhois(target.ip);
            printNote(buildAgentNote({ peer: target.name, identity, theirFolders: r.remote_folders ?? [], myFolders: folders }));
            return;
        }
    }
    console.log('Stopped waiting. The request stays open — once they accept, run "agent-bridge note ' + target.name + '".');
}
async function handleRequests() {
    const { incoming } = await api('/local/requests');
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
async function cmdRequests() {
    if ((await handleRequests()) === 0)
        console.log('No pending connection requests.');
}
// ── peers ──────────────────────────────────────────────────────────────────
async function cmdPeers() {
    const { peers } = await api('/local/peers');
    if (!peers.length)
        return console.log('Not connected to anyone. Run: agent-bridge connect');
    for (const p of peers) {
        console.log(`${p.name}  (${hostOf(p.url)})`);
        console.log(`  you can ask about: ${p.remote_folders.join(', ') || '?'}`);
        console.log(`  they can read:     ${p.folders.join(', ')}`);
    }
}
const stamp = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false }).slice(5, 16);
const firstLine = (text, max) => {
    const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
function printMessage(m, withThread) {
    const thread = withThread ? `  [${shortThreadId(m.thread_id)}]` : '';
    console.log(`\n── ${stamp(m.received_at)} · ${m.from} · ${m.kind === 'ask' ? 'asks' : 'answers'}${thread} ──\n${m.text}`);
}
async function cmdLog(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { follow: { type: 'boolean', short: 'f' }, limit: { type: 'string', short: 'n' } },
    });
    const [threadArg] = positionals;
    if (threadArg) {
        const { thread, messages } = await api(`/local/threads/${encodeURIComponent(threadArg)}`);
        const who = thread.origin === 'remote' ? `${thread.peer} asked you` : `you asked ${thread.peer ?? '?'}`;
        console.log(`Thread ${thread.thread_id} — ${who}`);
        for (const m of messages)
            printMessage(m, false);
        if (thread.session_id) {
            const role = thread.origin === 'remote' ? 'Answered on this machine by' : 'Asked from';
            console.log(`\n${role} Claude Code session ${thread.session_id} — to see what it read and did:\n  claude --resume ${thread.session_id}`);
        }
    }
    else if (!values.follow) {
        const { threads } = await api(`/local/threads?limit=${Number(values.limit) || 20}`);
        if (!threads.length)
            return console.log('No messages yet.');
        for (const t of threads.reverse()) {
            const who = t.origin === 'remote' ? `← ${t.peer} asked` : `→ asked ${t.peer ?? '?'}`;
            const state = t.origin === 'local' && t.last_kind === 'ask' ? 'waiting' : `${t.count} msgs`;
            console.log(`${stamp(t.last_at)}  ${shortThreadId(t.thread_id).padEnd(22)} ${who.padEnd(20)} ${state}\n    ${firstLine(t.first_text, 100)}`);
        }
        console.log('\nFull thread: agent-bridge log <thread>   ·   watch live: agent-bridge log -f');
    }
    if (values.follow) {
        let { latest } = await api('/local/messages');
        console.log('Watching for new messages (Ctrl+C to stop)…');
        for (;;) {
            await new Promise((r) => setTimeout(r, 2000));
            const res = await api(`/local/messages?after=${latest}`);
            for (const m of res.messages)
                printMessage(m, true);
            latest = res.latest;
        }
    }
}
async function cmdNote(argv) {
    const { peers } = await api('/local/peers');
    const p = peers.find((x) => x.name === argv[0]);
    if (!p)
        throw new Error(`no connection named "${argv[0] ?? ''}". See: agent-bridge peers`);
    const identity = await tailscaleWhois(hostOf(p.url));
    printNote(buildAgentNote({ peer: p.name, identity, theirFolders: p.remote_folders, myFolders: p.folders }));
}
async function cmdFolders(argv) {
    if (!argv[0])
        throw new Error('usage: agent-bridge folders <name>');
    const folders = await askFolders(`Folders ${argv[0]} may READ`);
    await api('/local/peers/folders', { name: argv[0], folders });
    console.log(`✓ ${argv[0]} can now read only: ${folders.join(', ')}`);
}
async function cmdRemove(argv) {
    await api('/local/peers/remove', { name: argv[0] });
    console.log(`✓ disconnected from ${argv[0]}`);
}
async function cmdStatus() {
    const cfg = loadConfig();
    console.log(`agent-bridge ${VERSION} · ${cfg.name} · http://${cfg.listenHost}:${cfg.peerPort}`);
    console.log(`service: ${serviceInstalled() ? `installed (log ${LOG_PATH})` : 'not installed'}`);
    if (cfg.telegram)
        console.log(`telegram: mirroring to ${cfg.telegram.chatTitle ?? cfg.telegram.chatId}`);
    let peers = [];
    try {
        const s = await api('/local/status');
        peers = (await api('/local/peers')).peers;
        console.log(`daemon:  running · live sessions ${s.live} · queued messages ${s.outbox}`);
    }
    catch {
        console.log('daemon:  NOT running → agent-bridge setup');
    }
    for (const p of peers) {
        let state = 'offline / unreachable';
        try {
            const h = (await (await fetch(`${p.url}/health`, { signal: AbortSignal.timeout(4000) })).json());
            state = h.name === p.name ? 'online' : `online but reports itself as "${h.name}"`;
        }
        catch {
            // stays offline
        }
        console.log(`${p.name}: ${state}`);
    }
}
const BOTFATHER_URL = 'https://t.me/BotFather';
const addToChannelUrl = (bot) => `https://t.me/${bot}?startchannel&admin=post_messages`;
/** Resolves "@name" or "-100…" to the numeric id both sides compare, and checks the bot may post there. */
async function resolveChannel(token, botId, chat) {
    const info = await telegramCall(token, 'getChat', { chat_id: /^-?\d+$/.test(chat) ? Number(chat) : chat });
    const member = await telegramCall(token, 'getChatMember', { chat_id: info.id, user_id: botId });
    if (member.status !== 'administrator' || member.can_post_messages === false)
        throw new Error(`the bot is not an admin that can post in "${info.title ?? chat}"`);
    return { id: info.id, title: info.title ?? String(info.id) };
}
async function detectChannel(token, bot) {
    const poll = async (timeout) => channelsFromUpdates(await telegramCall(token, 'getUpdates', { timeout, allowed_updates: ['my_chat_member', 'channel_post'] }));
    let channels = await poll(0);
    if (!channels.length) {
        const link = addToChannelUrl(bot);
        console.log(`\nTap this link, then pick your channel (or create one) and confirm — it adds @${bot} as an admin:\n  ${link}`);
        openUrl(link);
        console.log('Waiting up to 4 minutes…');
        for (let i = 0; i < 48 && !channels.length; i++)
            channels = await poll(5);
    }
    if (channels.length <= 1)
        return channels[0];
    channels.forEach((c, n) => console.log(`  ${n + 1}. ${c.title}`));
    return channels[Number(await ask('Which channel?', '1')) - 1];
}
async function cmdTelegram(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { token: { type: 'string' }, chat: { type: 'string' } },
    });
    const raw = readRawConfig();
    if (positionals[0] === 'off') {
        delete raw.telegram;
        writeRawConfig(raw);
        await restartDaemon(raw);
        return console.log('✓ Telegram mirror off');
    }
    let token = values.token?.trim();
    if (!token) {
        console.log('Every message between the agents will be posted to a Telegram channel; its members can only read.');
        console.log('Messages leave your Tailscale network and are stored by Telegram.\n');
        token = (await ask('Bot token (got one from a colleague? paste it · none yet? press Enter)')).trim();
        if (!token) {
            console.log(`In Telegram: @BotFather → /newbot → pick a name and a username → copy the token.\n  ${BOTFATHER_URL}`);
            openUrl(BOTFATHER_URL);
            token = (await ask('Bot token')).trim();
        }
    }
    const bot = await telegramCall(token, 'getMe', {}).catch((err) => {
        throw new Error(`Telegram rejected that token (${err.message})`);
    });
    console.log(`✓ bot @${bot.username}`);
    const chat = values.chat ? await resolveChannel(token, bot.id, values.chat) : await detectChannel(token, bot.username);
    if (!chat)
        throw new Error(`No channel found. Add @${bot.username} as a channel admin (${addToChannelUrl(bot.username)}), then run this again.`);
    await telegramCall(token, 'sendMessage', {
        chat_id: chat.id,
        text: `agent-bridge: ${raw.name}'s agent now posts the messages it sends and receives here.`,
    });
    raw.telegram = { botToken: token, chatId: chat.id, chatTitle: chat.title };
    writeRawConfig(raw);
    await restartDaemon(raw);
    console.log(`✓ mirroring to "${chat.title}"`);
    console.log(`\nColleagues can post their side to the same channel (each message still appears once). Send them this privately:\n  agent-bridge telegram --token ${token} --chat ${chat.id}`);
}
function cmdUninstall() {
    uninstallService(BRIDGE_HOME);
    const inv = claudeInvocation(existsSync(CONFIG_PATH) ? loadConfig().claudeBin : 'claude');
    tryRun(inv.command, [...inv.args, 'mcp', 'remove', '-s', 'user', 'agent-bridge']);
    console.log(`✓ daemon stopped and MCP server removed. Data kept in ${BRIDGE_HOME} (delete it to forget all connections).`);
}
async function cmdHome() {
    if (!existsSync(CONFIG_PATH)) {
        await cmdSetup([]);
        console.log('');
        if (await confirm('Also post every message between the agents to a Telegram channel, so people can read along?', false)) {
            await cmdTelegram([]);
        }
        console.log('');
    }
    if ((await handleRequests()) > 0)
        return;
    const { peers } = await api('/local/peers');
    if (peers.length) {
        console.log(`Connected: ${peers.map((p) => p.name).join(', ')}`);
        if (!(await confirm('Connect someone new?')))
            return;
    }
    await cmdConnect([]);
}
async function main() {
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
        case 'log':
            return cmdLog(rest);
        case 'telegram':
            return cmdTelegram(rest);
        case 'status':
            return cmdStatus();
        case 'uninstall':
            return cmdUninstall();
        case 'daemon': {
            const { values } = parseArgs({ args: rest, options: { log: { type: 'string' } } });
            return (await import("./daemon-main.js")).runDaemon({ logFile: values.log });
        }
        case 'channel':
            return (await import("./channel.js")).runChannel();
        case 'version':
        case '--version':
        case '-v':
            return console.log(VERSION);
        default:
            console.log(HELP);
            if (!['help', '--help', '-h'].includes(cmd))
                process.exitCode = 1;
    }
}
main()
    .catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
})
    .finally(() => reader?.close());
