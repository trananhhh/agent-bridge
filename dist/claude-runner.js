import { spawn } from 'node:child_process';
import { claudeInvocation } from "./platform.js";
const STDOUT_CAP = 5 * 1024 * 1024;
export const READ_ONLY_TOOLS = 'Read,Grep,Glob,WebSearch';
const WRITE_TOOLS = 'Edit,Write,NotebookEdit';
// Child must not think it is nested inside the session that spawned the daemon.
const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'BRIDGE_LIVE'];
export function buildClaudeArgs(opts) {
    // --restricted: no shell/code tools, user/project settings and hooks ignored, file tools confined to cwd + --add-dir.
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--restricted', '--strict-mcp-config'];
    if (opts.resumeSessionId)
        args.push('--resume', opts.resumeSessionId);
    if (opts.resumeSessionId && opts.fork)
        args.push('--fork-session');
    if (opts.model)
        args.push('--model', opts.model);
    if (opts.noTools)
        args.push('--tools=');
    if (opts.readOnlyDirs) {
        args.push('--tools', READ_ONLY_TOOLS, '--allowedTools', READ_ONLY_TOOLS, '--disallowedTools', WRITE_TOOLS);
        for (const d of opts.readOnlyDirs)
            args.push('--add-dir', d);
    }
    if (opts.appendSystemPrompt)
        args.push('--append-system-prompt', opts.appendSystemPrompt);
    return args;
}
export function parseClaudeJson(stdout) {
    const lines = stdout.trim().split('\n').reverse();
    for (const line of lines) {
        try {
            const o = JSON.parse(line);
            if (o && typeof o === 'object' && ('session_id' in o || 'result' in o)) {
                return { sessionId: String(o.session_id ?? ''), result: String(o.result ?? ''), isError: Boolean(o.is_error) };
            }
        }
        catch {
            // not the result line
        }
    }
    throw new Error(`unparseable claude output: ${stdout.slice(-300)}`);
}
export function createClaudeRunner(bin = 'claude') {
    return (opts) => new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const k of STRIPPED_ENV)
            delete env[k];
        const inv = claudeInvocation(bin);
        const child = spawn(inv.command, [...inv.args, ...buildClaudeArgs(opts)], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = opts.timeoutMs
            ? setTimeout(() => {
                child.kill('SIGTERM');
                reject(new Error(`claude timed out after ${opts.timeoutMs}ms`));
            }, opts.timeoutMs)
            : undefined;
        child.stdout.on('data', (d) => {
            if (stdout.length < STDOUT_CAP)
                stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d) => {
            stderr = (stderr + d.toString('utf8')).slice(-4000);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            try {
                resolve(parseClaudeJson(stdout));
            }
            catch (err) {
                reject(new Error(`claude exited ${code}: ${stderr.trim().slice(-500) || err.message}`));
            }
        });
        child.stdin.end(opts.prompt);
    });
}
