import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
const LAUNCHD_LABEL = 'com.agent-bridge.daemon';
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const WIN_STARTUP_VBS = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'agent-bridge.vbs');
function tryExec(cmd, args, input) {
    try {
        return execFileSync(cmd, args, {
            encoding: 'utf8',
            timeout: 15_000,
            input,
            windowsHide: true,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return undefined;
    }
}
/**
 * How to start Claude Code from the configured binary. npm's `claude.cmd` shim is unwrapped to
 * `node <cli.js>` at setup time, so we never need a shell (and its quoting rules) on Windows.
 */
export function claudeInvocation(bin) {
    return /\.[cm]?js$/i.test(bin) ? { command: process.execPath, args: [bin] } : { command: bin, args: [] };
}
export function findClaude() {
    if (IS_WIN) {
        const hits = (tryExec('where', ['claude']) ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const exe = hits.find((h) => /\.exe$/i.test(h));
        if (exe)
            return exe;
        const shim = hits.find((h) => /\.cmd$/i.test(h));
        const js = shim && join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        return js && existsSync(js) ? js : undefined;
    }
    // Keep the launcher path (not its realpath): Claude Code's auto-updater swaps the versioned target behind it.
    return tryExec('/bin/sh', ['-c', 'command -v claude']) ?? tryExec('/bin/zsh', ['-lc', 'command -v claude']);
}
export function copyToClipboard(text) {
    const candidates = IS_MAC
        ? [['pbcopy', []]]
        : IS_WIN
            ? [['clip', []]]
            : [
                ['wl-copy', []],
                ['xclip', ['-selection', 'clipboard']],
            ];
    return candidates.some(([cmd, args]) => tryExec(cmd, args, text) !== undefined);
}
export function openUrl(url) {
    const [cmd, args] = IS_MAC ? ['open', [url]] : IS_WIN ? ['explorer.exe', [url]] : ['xdg-open', [url]];
    execFile(cmd, args, { windowsHide: true }, () => { });
}
const WIN_NOTIFY_PS = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
    '$n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; ' +
    "$n.ShowBalloonTip(15000, $env:AB_TITLE, $env:AB_BODY, 'Info'); Start-Sleep -Seconds 15; $n.Dispose()";
/** Desktop notification; best effort. Title/body go through env vars, never into a script string. */
export function notify(title, body) {
    if (IS_MAC) {
        execFile('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => { });
    }
    else if (IS_WIN) {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_NOTIFY_PS], { env: { ...process.env, AB_TITLE: title, AB_BODY: body || ' ' }, windowsHide: true }, () => { });
    }
}
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const pidFile = (bridgeHome) => join(bridgeHome, 'daemon.pid');
export function writePidFile(bridgeHome) {
    writeFileSync(pidFile(bridgeHome), String(process.pid));
}
export function removePidFile(bridgeHome) {
    try {
        if (readFileSync(pidFile(bridgeHome), 'utf8').trim() === String(process.pid))
            rmSync(pidFile(bridgeHome));
    }
    catch {
        // already gone
    }
}
function killFromPidFile(bridgeHome) {
    try {
        const pid = Number(readFileSync(pidFile(bridgeHome), 'utf8').trim());
        if (pid > 0)
            process.kill(pid);
    }
    catch {
        // not running
    }
    rmSync(pidFile(bridgeHome), { force: true });
}
/** VBScript that starts the daemon with no console window (Windows Startup folder). */
export function windowsLauncherVbs(spec) {
    const q = (s) => `""${s}""`; // a literal quote inside a VBS string is written ""
    const command = [q(spec.nodePath), '--disable-warning=ExperimentalWarning', q(spec.cliPath), 'daemon', '--log', q(spec.logPath)].join(' ');
    return [
        'Set sh = CreateObject("WScript.Shell")',
        ...(spec.bridgeHomeEnv ? [`sh.Environment("Process")("BRIDGE_HOME") = "${spec.bridgeHomeEnv}"`] : []),
        `sh.Run "${command}", 0, False`,
        '',
    ].join('\r\n');
}
export function launchdPlist(spec) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const path = [dirname(spec.nodePath), spec.claudeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
    const env = { PATH: path, HOME: homedir(), ...(spec.bridgeHomeEnv ? { BRIDGE_HOME: spec.bridgeHomeEnv } : {}) };
    const args = [spec.nodePath, '--disable-warning=ExperimentalWarning', spec.cliPath, 'daemon'];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env)
        .map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`)
        .join('')}</dict>
  <key>WorkingDirectory</key><string>${esc(spec.bridgeHome)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(spec.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(spec.logPath)}</string>
</dict>
</plist>
`;
}
/** Installs + (re)starts the background daemon. Returns a human description, or undefined when unsupported. */
export function installService(spec) {
    mkdirSync(spec.bridgeHome, { recursive: true });
    if (IS_MAC) {
        mkdirSync(dirname(LAUNCHD_PLIST), { recursive: true });
        writeFileSync(LAUNCHD_PLIST, launchdPlist(spec));
        const domain = `gui/${process.getuid?.()}`;
        tryExec('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
        // bootout is asynchronous: bootstrapping while the old job is still tearing down fails with "5: Input/output error".
        for (let attempt = 0;; attempt++) {
            if (tryExec('launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`]) === undefined) {
                try {
                    execFileSync('launchctl', ['bootstrap', domain, LAUNCHD_PLIST], { stdio: 'ignore' });
                    break;
                }
                catch (err) {
                    if (attempt >= 20)
                        throw err;
                }
            }
            if (attempt >= 20)
                throw new Error('launchd did not release the previous agent-bridge job; try again in a few seconds');
            sleepMs(500);
        }
        return 'launchd agent (restarts on crash, starts at login)';
    }
    if (IS_WIN) {
        killFromPidFile(spec.bridgeHome);
        mkdirSync(dirname(WIN_STARTUP_VBS), { recursive: true });
        writeFileSync(WIN_STARTUP_VBS, windowsLauncherVbs(spec));
        spawn('wscript.exe', [WIN_STARTUP_VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return 'Startup-folder launcher (starts at login)';
    }
    return undefined;
}
export function uninstallService(bridgeHome) {
    if (IS_MAC) {
        tryExec('launchctl', ['bootout', `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`]);
        rmSync(LAUNCHD_PLIST, { force: true });
    }
    if (IS_WIN)
        rmSync(WIN_STARTUP_VBS, { force: true });
    killFromPidFile(bridgeHome);
}
export function serviceInstalled() {
    return (IS_MAC && existsSync(LAUNCHD_PLIST)) || (IS_WIN && existsSync(WIN_STARTUP_VBS));
}
/** npm's own script, next to this node (Windows layout) or in its lib folder (Unix layout). */
function npmCli() {
    const bin = dirname(process.execPath);
    return [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => existsSync(p));
}
/**
 * Installs (or updates) a global npm package with the npm that belongs to this node, whatever PATH the service has.
 * Runs npm's script with node directly: no shell, so paths with spaces (C:\Program Files\nodejs) are fine.
 */
export function installGlobalPackage(url) {
    const cli = npmCli();
    const args = ['install', '-g', '--prefer-online', url];
    const [command, argv, shell] = cli ? [process.execPath, [cli, ...args], false] : [IS_WIN ? 'npm.cmd' : 'npm', args, IS_WIN];
    return new Promise((resolve, reject) => {
        execFile(command, argv, { timeout: 5 * 60_000, shell }, (err, _stdout, stderr) => err ? reject(new Error(String(stderr).trim().split('\n').at(-1) || err.message)) : resolve());
    });
}
/**
 * Starts the service again after this process exits. launchd does it by itself (KeepAlive);
 * the Windows Startup launcher only runs at login, so run it now — call this once the ports are closed.
 */
export function relaunchService() {
    if (IS_WIN && existsSync(WIN_STARTUP_VBS))
        spawn('wscript.exe', [WIN_STARTUP_VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
