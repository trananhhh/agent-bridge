import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
const CHUNK_BYTES = 256 * 1024;
const FIELD_MAX = 300;
// `claude -p --resume` only accepts a session UUID. Subagent transcripts (agent-<hex>.jsonl) sit next to sessions but are not resumable.
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export function isWithin(path, dirs) {
    if (!path)
        return false;
    // Windows paths are case-insensitive and drive letters come back in either case.
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const target = norm(path);
    return dirs.map(norm).some((d) => target === d || target.startsWith(d.endsWith(sep) ? d : d + sep));
}
/** Scans every Claude Code project transcript (~/.claude/projects/*\/*.jsonl), newest first, keeping sessions whose cwd is inside allowedDirs. */
export function listRecentSessions(projectsRoot, opts) {
    if (!existsSync(projectsRoot))
        return [];
    const cutoff = opts.now - opts.sinceHours * 3600_000;
    const files = [];
    for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!project.isDirectory())
            continue;
        const dir = join(projectsRoot, project.name);
        for (const f of readdirSync(dir, { withFileTypes: true })) {
            const sessionId = f.isFile() ? SESSION_FILE.exec(f.name)?.[1] : undefined;
            if (!sessionId)
                continue;
            const file = join(dir, f.name);
            const mtimeMs = statSync(file).mtimeMs;
            if (mtimeMs >= cutoff)
                files.push({ file, sessionId, mtimeMs });
        }
    }
    files.sort((x, y) => y.mtimeMs - x.mtimeMs);
    const out = [];
    for (const { file, sessionId, mtimeMs } of files) {
        if (out.length >= opts.limit)
            break;
        const summary = summarize(file);
        if (isWithin(summary.cwd, opts.allowedDirs))
            out.push({ sessionId, mtimeMs, ...summary });
    }
    return out;
}
function summarize(file) {
    const { head, tail } = readHeadTail(file);
    const headEntries = parseLines(head);
    const out = {};
    for (const entry of headEntries) {
        if (!out.cwd && typeof entry.cwd === 'string')
            out.cwd = entry.cwd;
        const prompt = userPromptText(entry);
        if (prompt && !out.firstPrompt)
            out.firstPrompt = clip(prompt);
        if (out.cwd && out.firstPrompt)
            break;
    }
    for (const entry of [...headEntries, ...parseLines(tail)]) {
        const title = entry.customTitle ?? entry.aiTitle ?? (entry.type === 'summary' ? entry.summary : undefined);
        if (typeof title === 'string' && title.trim())
            out.title = clip(title);
        if (entry.type === 'last-prompt' && typeof entry.lastPrompt === 'string')
            out.lastPrompt = clip(entry.lastPrompt);
        const prompt = userPromptText(entry);
        if (prompt)
            out.lastPrompt = clip(prompt);
    }
    return out;
}
function readHeadTail(file) {
    const fd = openSync(file, 'r');
    try {
        const size = fstatSync(fd).size;
        const read = (start, len) => {
            const buf = Buffer.alloc(len);
            const n = readSync(fd, buf, 0, len, start);
            return buf.subarray(0, n).toString('utf8');
        };
        if (size <= CHUNK_BYTES * 2)
            return { head: read(0, size), tail: '' };
        const tail = read(size - CHUNK_BYTES, CHUNK_BYTES);
        return { head: read(0, CHUNK_BYTES), tail: tail.slice(tail.indexOf('\n') + 1) };
    }
    finally {
        closeSync(fd);
    }
}
function parseLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.startsWith('{'))
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // truncated chunk boundary or corrupt line
        }
    }
    return out;
}
function userPromptText(entry) {
    if (entry.type !== 'user' || entry.isMeta)
        return undefined;
    const content = entry.message?.content;
    let text;
    if (typeof content === 'string')
        text = content;
    else if (Array.isArray(content)) {
        const block = content.find((b) => b && typeof b === 'object' && b.type === 'text');
        text = block?.text;
    }
    text = text?.trim();
    if (!text || text.startsWith('<'))
        return undefined;
    return text;
}
function clip(s) {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > FIELD_MAX ? `${flat.slice(0, FIELD_MAX)}…` : flat;
}
