import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAgentNote } from "./agent-note.js";
import { BRIDGE_HOME, CONFIG_PATH, VERSION, expandPath, loadConfig, readRawConfig, writeRawConfig } from "./config.js";
import { findBridges, parseTailscaleStatus } from "./discovery.js";
import { tailscaleStatus, tailscaleWhois } from "./tailscale.js";
const CLI_PATH = fileURLToPath(import.meta.url);
const SERVICE_LABEL = 'com.agent-bridge.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const LOG_PATH = join(BRIDGE_HOME, 'daemon.log');
const INSTALL_CMD = 'npm install -g https://github.com/trananhhh/agent-bridge/tarball/main';
const WAIT_FOR_ANSWER_MS = 15 * 60_000;
const TAILSCALE_GUIDE = `Kết nối Tailscale với đồng nghiệp (mỗi người một account, làm 1 lần):
  1. Mở https://login.tailscale.com/admin/machines
  2. Ở dòng máy của bạn: bấm ⋯ → "Share…" → copy share link (hoặc nhập email người kia)
  3. Gửi link cho đồng nghiệp → họ mở link, bấm Accept
  4. Đồng nghiệp làm y hệt với máy của họ và gửi link cho bạn → bạn bấm Accept
  Phải share CẢ HAI CHIỀU: Tailscale chỉ cho máy được share nhận kết nối, không cho nó chủ động gọi lại.`;
const HELP = `agent-bridge ${VERSION} — cho Claude Code trên các máy khác nhau nói chuyện với nhau (qua Tailscale)

  agent-bridge                  wizard: setup → xử lý yêu cầu kết nối → kết nối người mới
  agent-bridge setup            đặt tên, chạy daemon nền, đăng ký MCP cho Claude Code
  agent-bridge connect [ip]     tìm máy có agent-bridge trên Tailscale (hoặc nhập IP), chọn folder, gửi yêu cầu
  agent-bridge requests         xem & chấp nhận yêu cầu kết nối đang chờ
  agent-bridge peers            danh sách kết nối
  agent-bridge note <tên>       in lại đoạn hướng dẫn để dán cho Claude Code
  agent-bridge folders <tên>    đổi folder người đó được đọc
  agent-bridge remove <tên>     ngắt kết nối
  agent-bridge status           kiểm tra daemon, Tailscale, từng kết nối
  agent-bridge uninstall        tắt daemon, gỡ MCP (giữ ~/.agent-bridge)
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
        throw new Error('hết input');
    }
    if (!process.stdin.isTTY)
        process.stdout.write(`${line}\n`);
    return line.trim() || fallback || '';
}
async function confirm(question, defaultYes = true) {
    const a = (await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`)).toLowerCase();
    return a ? a.startsWith('y') || a === 'có' || a === 'co' : defaultYes;
}
async function askFolders(question) {
    for (;;) {
        const raw = await ask(`${question} — đường dẫn, cách nhau bởi dấu phẩy`, process.cwd());
        const folders = raw.split(',').map((f) => f.trim()).filter(Boolean).map((f) => expandPath(f));
        const missing = folders.filter((f) => !existsSync(f) || !statSync(f).isDirectory());
        if (folders.length && missing.length === 0)
            return [...new Set(folders)];
        console.log(`  ✗ không tồn tại: ${missing.join(', ') || '(trống)'}`);
    }
}
function sh(bin, args, input) {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).trim();
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
    console.log(`\n${line}\nGửi đoạn dưới đây cho Claude Code của bạn:\n${line}\n${note}\n${line}`);
    if (process.platform === 'darwin' && tryRun('pbcopy', [], note) !== undefined)
        console.log('(đã copy vào clipboard)');
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
        throw new Error('daemon chưa chạy. Chạy: agent-bridge setup');
    }
    const json = (await res.json());
    if (!res.ok)
        throw new Error(json.error ?? `daemon responded ${res.status}`);
    return json;
}
const hostOf = (url) => new URL(url).hostname;
// ── setup ──────────────────────────────────────────────────────────────────
function detectClaudeBin() {
    // Keep the launcher path (not its realpath): Claude Code's auto-updater swaps the versioned target behind it.
    return tryRun('/bin/sh', ['-c', 'command -v claude']) ?? tryRun('/bin/zsh', ['-lc', 'command -v claude']);
}
function serviceInstalled() {
    return process.platform === 'darwin' && existsSync(PLIST_PATH);
}
function installService() {
    const cfg = loadConfig();
    const claudeDir = cfg.claudeBin.includes('/') ? dirname(cfg.claudeBin) : '';
    const path = [dirname(process.execPath), claudeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const args = [process.execPath, '--disable-warning=ExperimentalWarning', CLI_PATH, 'daemon'];
    const env = { PATH: path, HOME: homedir(), ...(process.env.BRIDGE_HOME ? { BRIDGE_HOME } : {}) };
    mkdirSync(dirname(PLIST_PATH), { recursive: true });
    mkdirSync(BRIDGE_HOME, { recursive: true });
    writeFileSync(PLIST_PATH, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict>
  <key>WorkingDirectory</key><string>${esc(BRIDGE_HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_PATH)}</string>
</dict>
</plist>
`);
    const domain = `gui/${process.getuid?.()}`;
    tryRun('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]);
    sh('launchctl', ['bootstrap', domain, PLIST_PATH]);
}
function registerMcp(claudeBin) {
    tryRun(claudeBin, ['mcp', 'remove', '-s', 'user', 'agent-bridge']);
    sh(claudeBin, ['mcp', 'add', '-s', 'user', 'agent-bridge', '--', process.execPath, '--disable-warning=ExperimentalWarning', CLI_PATH, 'channel']);
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
async function cmdSetup(argv) {
    const { values } = parseArgs({ args: argv, options: { name: { type: 'string' } } });
    if (CLI_PATH.includes('/_npx/')) {
        throw new Error(`agent-bridge cần chạy nền nên phải cài global, không chạy qua npx:\n  ${INSTALL_CMD}\n  agent-bridge`);
    }
    const ts = await tailscaleStatus();
    const selfIp = ts ? parseTailscaleStatus(ts).selfIp : undefined;
    if (!selfIp)
        throw new Error('Tailscale chưa cài/chưa đăng nhập. Cài https://tailscale.com/download, đăng nhập, rồi chạy lại.');
    const claudeBin = detectClaudeBin();
    if (!claudeBin)
        throw new Error('không tìm thấy lệnh `claude`. Cài Claude Code trước: https://claude.com/claude-code');
    const existing = existsSync(CONFIG_PATH) ? readRawConfig() : undefined;
    const suggested = (existing?.name ?? userInfo().username).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    let name = values.name ?? (await ask('Tên của bạn (đồng nghiệp sẽ thấy; chữ thường, không dấu)', suggested));
    while (!/^[a-z0-9_-]{1,50}$/.test(name))
        name = await ask('Tên chỉ gồm a-z 0-9 _ -', suggested);
    const raw = { ...existing, name, listenHost: selfIp, claudeBin };
    writeRawConfig(raw);
    console.log(`✓ tên: ${name} · Tailscale ${selfIp}`);
    if (process.platform === 'darwin') {
        installService();
        console.log(`✓ daemon chạy nền, tự bật khi đăng nhập (log: ${LOG_PATH})`);
    }
    else {
        console.log('! Linux: tự chạy `agent-bridge daemon` dưới systemd/tmux để daemon luôn bật');
    }
    registerMcp(claudeBin);
    console.log('✓ đã đăng ký MCP "agent-bridge" cho Claude Code');
    if (!(await waitForDaemon(raw.localPort ?? 8791)))
        console.log(`! daemon chưa phản hồi — xem log ${LOG_PATH}`);
    console.log('  Nếu macOS hỏi "Allow node to accept incoming connections" → bấm Allow.');
}
// ── connect / requests ─────────────────────────────────────────────────────
async function cmdConnect(argv) {
    const cfg = loadConfig();
    if (argv[0])
        return connectTo(await bridgeAt(argv[0], cfg.peerPort));
    console.log('Đang tìm máy có agent-bridge trên Tailscale…');
    const ts = await tailscaleStatus();
    if (!ts)
        throw new Error('không đọc được Tailscale (app có đang chạy không?)');
    const { peers: online } = parseTailscaleStatus(ts);
    const connected = new Set((await api('/local/peers')).peers.map((p) => p.name));
    const found = (await findBridges(online, { port: cfg.peerPort })).filter((b) => b.name !== cfg.name);
    if (found.length === 0) {
        console.log(`\nChưa thấy ai. Máy đang online trong Tailscale của bạn: ${online.map((p) => p.host).join(', ') || '(không có)'}`);
        console.log(`- Không thấy máy đồng nghiệp ở trên → chưa share Tailscale:\n\n${TAILSCALE_GUIDE}\n`);
        console.log('- Có máy họ nhưng vẫn không thấy → họ chưa cài/chưa chạy `agent-bridge setup`, hoặc firewall chặn node.');
        if (process.platform === 'darwin' && (await confirm('Mở trang Tailscale admin để share máy?')))
            tryRun('open', ['https://login.tailscale.com/admin/machines']);
        return;
    }
    console.log('');
    found.forEach((b, i) => console.log(`  ${i + 1}) ${b.name}  — máy ${b.host} (${b.ip})${connected.has(b.name) ? '  [đã kết nối]' : ''}`));
    let pick;
    do
        pick = Number(await ask('Kết nối với số', found.length === 1 ? '1' : undefined));
    while (!(pick >= 1 && pick <= found.length));
    await connectTo(found[pick - 1]);
}
/** Direct target (`agent-bridge connect 100.x.y.z`) when scanning can't see the machine. */
async function bridgeAt(arg, port) {
    const url = arg.includes('://') ? arg.replace(/\/$/, '') : /:\d+$/.test(arg) ? `http://${arg}` : `http://${arg}:${port}`;
    const [hit] = await findBridges([{ ip: hostOf(url), host: hostOf(url) }], { port: Number(new URL(url).port) || port });
    if (!hit)
        throw new Error(`${url} không chạy agent-bridge (hoặc không tới được qua Tailscale)`);
    return hit;
}
async function connectTo(target) {
    const folders = await askFolders(`Folder ${target.name} được ĐỌC (chỉ đọc; đọc được cả .env trong đó)`);
    if (!(await confirm(`Gửi yêu cầu kết nối tới ${target.name}, cho họ đọc ${folders.join(', ')}?`)))
        return;
    const { request_id } = await api('/local/connect', { url: target.url, folders });
    console.log(`⏳ Đã gửi. Đang chờ ${target.name} chấp nhận — máy họ hiện thông báo, họ chạy "agent-bridge" để chấp nhận.`);
    console.log('   (Ctrl+C để thoát; nếu họ chấp nhận sau, chạy "agent-bridge note ' + target.name + '" để lấy hướng dẫn)');
    const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await api(`/local/requests/${request_id}`);
        if (r.status === 'declined')
            return console.log(`✗ ${target.name} đã từ chối.`);
        if (r.status === 'accepted') {
            console.log(`✓ Đã kết nối với ${target.name}. Bạn hỏi được họ về: ${(r.remote_folders ?? []).join(', ')}`);
            const identity = await tailscaleWhois(target.ip);
            printNote(buildAgentNote({ peer: target.name, identity, theirFolders: r.remote_folders ?? [], myFolders: folders }));
            return;
        }
    }
    console.log('Hết thời gian chờ. Yêu cầu vẫn còn — khi họ chấp nhận, chạy "agent-bridge note ' + target.name + '".');
}
async function handleRequests() {
    const { incoming } = await api('/local/requests');
    for (const r of incoming) {
        console.log(`\n📨 ${r.name}${r.identity ? ` (${r.identity})` : ''} muốn kết nối.`);
        console.log(`   ${r.name} cho bạn hỏi về: ${r.folders.join(', ') || '(không có folder)'}`);
        if (!(await confirm('Chấp nhận?'))) {
            await api('/local/requests/answer', { request_id: r.id, accept: false });
            console.log('   ✗ đã từ chối');
            continue;
        }
        const folders = await askFolders(`Folder ${r.name} được ĐỌC (chỉ đọc; đọc được cả .env trong đó)`);
        await api('/local/requests/answer', { request_id: r.id, accept: true, folders });
        console.log(`✓ Đã kết nối với ${r.name}.`);
        printNote(buildAgentNote({ peer: r.name, identity: r.identity, theirFolders: r.folders, myFolders: folders }));
    }
    return incoming.length;
}
async function cmdRequests() {
    if ((await handleRequests()) === 0)
        console.log('Không có yêu cầu kết nối nào đang chờ.');
}
// ── peers ──────────────────────────────────────────────────────────────────
async function cmdPeers() {
    const { peers } = await api('/local/peers');
    if (!peers.length)
        return console.log('Chưa kết nối với ai. Chạy: agent-bridge connect');
    for (const p of peers) {
        console.log(`${p.name}  (${hostOf(p.url)})`);
        console.log(`  bạn hỏi được về: ${p.remote_folders.join(', ') || '?'}`);
        console.log(`  họ đọc được:     ${p.folders.join(', ')}`);
    }
}
async function cmdNote(argv) {
    const { peers } = await api('/local/peers');
    const p = peers.find((x) => x.name === argv[0]);
    if (!p)
        throw new Error(`không có kết nối "${argv[0] ?? ''}". Xem: agent-bridge peers`);
    const identity = await tailscaleWhois(hostOf(p.url));
    printNote(buildAgentNote({ peer: p.name, identity, theirFolders: p.remote_folders, myFolders: p.folders }));
}
async function cmdFolders(argv) {
    if (!argv[0])
        throw new Error('usage: agent-bridge folders <tên>');
    const folders = await askFolders(`Folder ${argv[0]} được ĐỌC`);
    await api('/local/peers/folders', { name: argv[0], folders });
    console.log(`✓ ${argv[0]} giờ chỉ đọc được: ${folders.join(', ')}`);
}
async function cmdRemove(argv) {
    await api('/local/peers/remove', { name: argv[0] });
    console.log(`✓ đã ngắt kết nối với ${argv[0]}`);
}
async function cmdStatus() {
    const cfg = loadConfig();
    console.log(`agent-bridge ${VERSION} · ${cfg.name} · http://${cfg.listenHost}:${cfg.peerPort}`);
    console.log(`service: ${serviceInstalled() ? `launchd (log ${LOG_PATH})` : 'chưa cài'}`);
    let peers = [];
    try {
        const s = await api('/local/status');
        peers = (await api('/local/peers')).peers;
        console.log(`daemon:  đang chạy · session live ${s.live} · tin chờ gửi ${s.outbox}`);
    }
    catch {
        console.log('daemon:  KHÔNG chạy → agent-bridge setup');
    }
    for (const p of peers) {
        let state = 'offline / không tới được';
        try {
            const h = (await (await fetch(`${p.url}/health`, { signal: AbortSignal.timeout(4000) })).json());
            state = h.name === p.name ? 'online' : `online nhưng tự nhận là "${h.name}"`;
        }
        catch {
            // stays offline
        }
        console.log(`${p.name}: ${state}`);
    }
}
function cmdUninstall() {
    tryRun('launchctl', ['bootout', `gui/${process.getuid?.()}/${SERVICE_LABEL}`]);
    rmSync(PLIST_PATH, { force: true });
    const claudeBin = existsSync(CONFIG_PATH) ? loadConfig().claudeBin : 'claude';
    tryRun(claudeBin, ['mcp', 'remove', '-s', 'user', 'agent-bridge']);
    console.log(`✓ đã tắt daemon và gỡ MCP. Dữ liệu còn ở ${BRIDGE_HOME} (xoá thư mục đó để quên mọi kết nối).`);
}
async function cmdHome() {
    if (!existsSync(CONFIG_PATH)) {
        await cmdSetup([]);
        console.log('');
    }
    if ((await handleRequests()) > 0)
        return;
    const { peers } = await api('/local/peers');
    if (peers.length) {
        console.log(`Đã kết nối: ${peers.map((p) => p.name).join(', ')}`);
        if (!(await confirm('Kết nối với người mới?')))
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
        case 'status':
            return cmdStatus();
        case 'uninstall':
            return cmdUninstall();
        case 'daemon':
            return (await import("./daemon-main.js")).runDaemon();
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
