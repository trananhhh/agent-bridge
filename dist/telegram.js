import { shortThreadId } from "./protocol.js";
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from "./telegram-format.js";
const API = 'https://api.telegram.org';
const CALL_TIMEOUT_MS = 15_000;
/** Telegram caps a message at 4096 characters: Markdown source per part, and the most its HTML may grow to before re-splitting. */
const CHUNK_CHARS = 3500;
const HTML_CHARS = 3900;
const CURSOR_KEY = 'telegram_cursor';
const BATCH = 20;
const PARSE_ERROR = /parse entities/i;
/** 400s caused by the message itself. Anything else (wrong chat, missing rights) is a setup problem: stop and retry. */
const MESSAGE_SPECIFIC_400 = /parse entities|too long|text must be non-empty/i;
export class TelegramError extends Error {
    status;
    retryAfterS;
    constructor(message, status, retryAfterS) {
        super(message);
        this.status = status;
        this.retryAfterS = retryAfterS;
    }
}
/** The token is part of the URL — never log the URL, only Telegram's description. */
export async function telegramCall(token, method, body, fetchImpl = fetch, timeoutMs = CALL_TIMEOUT_MS) {
    const res = await fetchImpl(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({})));
    if (!res.ok || !json.ok)
        throw new TelegramError(json.description ?? `HTTP ${res.status}`, res.status, json.parameters?.retry_after);
    return json.result;
}
function renderParts(markdown, max = CHUNK_CHARS) {
    return splitMarkdown(markdown, max).flatMap((plain) => {
        const html = markdownToTelegramHtml(plain);
        return html.length <= HTML_CHARS || max < 500 ? [{ html, plain }] : renderParts(plain, Math.floor(max / 2));
    });
}
/** Header, then the body; later parts are numbered. Every part carries the thread id, which is how a reply to it finds its thread. */
function withHeader(head, body, code) {
    const parts = renderParts(body);
    return parts.map((p, i) => {
        const h = i === 0 ? head : { html: `<i>(${i + 1}/${parts.length})</i>  <code>${escapeHtml(code)}</code>`, plain: `(${i + 1}/${parts.length})  ${code}` };
        return { html: `${h.html}\n\n${p.html}`, plain: `${h.plain}\n\n${p.plain}` };
    });
}
export function formatPosts(m, to) {
    const icon = m.via ? '👤' : m.kind === 'ask' ? '❓' : '💬';
    const code = shortThreadId(m.thread_id);
    return withHeader({ html: `<b>${icon} ${escapeHtml(m.from)} → ${escapeHtml(to)}</b>  <code>${escapeHtml(code)}</code>`, plain: `${icon} ${m.from} → ${to}  ${code}` }, m.text, code);
}
const OVERTAKEN = 'You answered first; the agent had also written this.';
const REPLY_HINT = 'Reply to this message to answer in your own words.';
/** What the shared chat sees of a held answer: that one is waiting — never its content or the question to the owner. */
export function formatHeldNotice(d, self, owners) {
    const code = shortThreadId(d.thread_id);
    return [
        {
            html: `🙋 <b>${escapeHtml(self)} → ${escapeHtml(d.peer)}</b>: an answer is waiting for ${escapeHtml(owners)} to check  <code>${escapeHtml(code)}</code>`,
            plain: `🙋 ${self} → ${d.peer}: an answer is waiting for ${owners} to check  ${code}`,
        },
    ];
}
export function formatDraft(d, self, owners) {
    const code = shortThreadId(d.thread_id);
    const note = d.question ?? OVERTAKEN;
    const head = {
        html: `<b>🙋 For ${escapeHtml(owners)} to check</b> · ${escapeHtml(self)} → ${escapeHtml(d.peer)}  <code>${escapeHtml(code)}</code>\n<i>${escapeHtml(note)}</i>`,
        plain: `🙋 For ${owners} to check · ${self} → ${d.peer}  ${code}\n${note}`,
    };
    const parts = withHeader(head, d.text || '—', code);
    const last = parts.at(-1);
    parts[parts.length - 1] = { html: `${last.html}\n\n<i>${REPLY_HINT}</i>`, plain: `${last.plain}\n\n${REPLY_HINT}` };
    return parts;
}
function unshowable(d, owners) {
    const text = `🙋 An answer is waiting for ${owners} to check, but Telegram could not show it. Read it with: agent-bridge log ${shortThreadId(d.thread_id)}`;
    return { html: escapeHtml(text), plain: text };
}
const draftButtons = (d) => ({
    inline_keyboard: [
        [
            ...(d.text ? [{ text: '✅ Send', callback_data: `d:${d.id}:send` }] : []),
            { text: "🚫 Don't send", callback_data: `d:${d.id}:drop` },
        ],
    ],
});
const OUTCOME = {
    sent: (by) => `✅ Sent by ${by}`,
    dropped: (by) => `🚫 Not sent (${by})`,
    replaced: (by) => `✍️ ${by} answered instead`,
    superseded: () => '↪️ Replaced by a newer draft',
};
const outcomeButton = (d) => ({
    inline_keyboard: [[{ text: d.status === 'pending' ? '…' : OUTCOME[d.status](d.resolved_by ?? '?'), callback_data: 'noop' }]],
});
/** The offset that confirms these updates, so the next poll returns only newer ones. */
export const nextOffset = (updates, current = 0) => Math.max(current, ...updates.map((u) => (u.update_id ?? -1) + 1));
/**
 * Who opened the setup link `t.me/<bot>?start=<code>`: a private "/start <code>" carrying the code printed in the terminal.
 * Only someone at this machine has the code, and opening the private chat lets the bot send them held answers.
 */
export function findStart(updates, code) {
    for (const { message: m } of updates) {
        if (m?.chat?.type !== 'private' || !m.from || m.from.is_bot || m.text?.trim() !== `/start ${code}`)
            continue;
        return { id: m.from.id, name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || String(m.from.id) };
    }
    return undefined;
}
const POSTABLE_STATUS = {
    channel: ['administrator', 'creator'],
    group: ['member', 'administrator', 'creator'],
    supergroup: ['member', 'administrator', 'creator'],
};
/** Channels/groups the bot was just added to, or saw a post or mention in — how `agent-bridge telegram` finds the chat id. */
export function channelsFromUpdates(updates) {
    const found = new Map();
    for (const u of updates) {
        const member = u.my_chat_member;
        const chat = member?.chat ?? u.channel_post?.chat ?? u.message?.chat;
        const allowed = chat?.type ? POSTABLE_STATUS[chat.type] : undefined;
        if (!chat || !allowed)
            continue;
        if (member && !allowed.includes(member.new_chat_member?.status ?? ''))
            continue;
        found.set(chat.id, { id: chat.id, title: chat.title ?? String(chat.id), type: chat.type });
    }
    return [...found.values()];
}
/** Whether a bot with this membership can post in a chat of this type. */
export const canPost = (chatType, status, canPostMessages) => (POSTABLE_STATUS[chatType] ?? []).includes(status) && !(chatType === 'channel' && canPostMessages === false);
/**
 * Mirror of this machine's agent-bridge log into a Telegram chat.
 * Every message lands exactly once: its sender posts it, unless the sender has no mirror to this chat, in which case the receiver does.
 * What the owner typed or approved in Telegram is already there, so it is not posted again.
 * Progress is a cursor in the store, so a crash, restart or Telegram outage never drops or reorders messages.
 */
export function createTelegramMirror(opts) {
    const { store, target } = opts;
    const now = opts.now ?? Date.now;
    if (store.getKv(CURSOR_KEY) === undefined)
        store.setKv(CURSOR_KEY, String(store.latestSeq()));
    let running = false;
    let pausedUntil = 0;
    let lastError;
    const reviewChat = opts.reviewChat ?? target.chatId;
    const call = (method, body) => telegramCall(target.botToken, method, { chat_id: target.chatId, ...body }, opts.fetchImpl);
    /** Returns the id of the last Telegram message sent. */
    const sendAll = async (posts, where = {}) => {
        let id = 0;
        for (const [i, post] of posts.entries()) {
            const extra = { chat_id: where.chat ?? target.chatId, link_preview_options: { is_disabled: true }, ...(i === posts.length - 1 ? where.lastExtra : {}) };
            try {
                id = (await call('sendMessage', { text: post.html, parse_mode: 'HTML', ...extra })).message_id;
            }
            catch (err) {
                if (!(err instanceof TelegramError && err.status === 400 && PARSE_ERROR.test(err.message)))
                    throw err;
                opts.log('telegram_plain_fallback', { error: err.message });
                id = (await call('sendMessage', { text: post.plain, ...extra })).message_id;
            }
        }
        return id;
    };
    /** Runs one post; false means stop this tick and retry later. */
    const attempt = async (what, fn) => {
        try {
            await fn();
            lastError = undefined;
            return true;
        }
        catch (err) {
            const e = err;
            if (e instanceof TelegramError && e.status === 400 && MESSAGE_SPECIFIC_400.test(e.message)) {
                opts.log('telegram_skipped', { what, error: e.message });
                return true;
            }
            if (e.message !== lastError)
                opts.log('telegram_failed', { error: e.message });
            lastError = e.message;
            if (e instanceof TelegramError && e.retryAfterS)
                pausedUntil = now() + e.retryAfterS * 1000;
            return false;
        }
    };
    const postMessages = async () => {
        for (;;) {
            const batch = store.messagesAfter(Number(store.getKv(CURSOR_KEY)), BATCH);
            if (!batch.length)
                return true;
            for (const m of batch) {
                // Each side posts what it sends; an incoming message is posted here only if its sender doesn't mirror to this chat.
                const theirs = m.direction === 'in' && m.mirror === String(target.chatId);
                if (!theirs && m.via !== 'owner-in-chat') {
                    const to = m.direction === 'in' ? opts.selfName : (store.getThread(m.thread_id)?.peer ?? '?');
                    if (!(await attempt(m.id, async () => void (await sendAll(formatPosts(m, to))))))
                        return false;
                }
                store.setKv(CURSOR_KEY, String(m.seq));
            }
        }
    };
    const postDrafts = async () => {
        const owners = opts.owners ?? 'the owner';
        for (const d of store.unpostedDrafts()) {
            const where = { chat: reviewChat, lastExtra: { reply_markup: draftButtons(d) } };
            let posted = 0;
            if (!(await attempt(d.id, async () => void (posted = await sendAll(formatDraft(d, opts.selfName, owners), where)))))
                return false;
            // Telegram refused to show it: the owner can still decide, and read it with `agent-bridge log`.
            if (!posted && !(await attempt(d.id, async () => void (posted = await sendAll([unshowable(d, owners)], where)))))
                return false;
            store.setDraftPosted(d.id, posted);
            if (reviewChat !== target.chatId && !(await attempt(d.id, async () => void (await sendAll(formatHeldNotice(d, opts.selfName, owners))))))
                return false;
        }
        for (const d of store.draftsToRefresh()) {
            const ok = await attempt(d.id, async () => {
                try {
                    await call('editMessageReplyMarkup', { chat_id: reviewChat, message_id: d.posted_message_id, reply_markup: outcomeButton(d) });
                }
                catch (err) {
                    // Already showing it, or the post is gone: nothing left to update.
                    if (!(err instanceof TelegramError && err.status === 400))
                        throw err;
                }
            });
            if (!ok)
                return false;
            store.setDraftShown(d.id, d.status);
        }
        return true;
    };
    async function tick() {
        if (running || now() < pausedUntil)
            return;
        running = true;
        try {
            if (await postMessages())
                await postDrafts();
        }
        finally {
            running = false;
        }
    }
    return { tick };
}
