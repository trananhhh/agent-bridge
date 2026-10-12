import { shortThreadId } from './protocol.ts';
import type { BridgeStore, Draft, DraftStatus, LoggedMessage } from './store.ts';
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from './telegram-format.ts';

export interface TelegramTarget {
  botToken: string;
  chatId: string | number;
}

type Fetch = typeof fetch;

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
  readonly status: number;
  readonly retryAfterS?: number;
  constructor(message: string, status: number, retryAfterS?: number) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

/** The token is part of the URL — never log the URL, only Telegram's description. */
export async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: Fetch = fetch,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<T> {
  const res = await fetchImpl(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (!res.ok || !json.ok) throw new TelegramError(json.description ?? `HTTP ${res.status}`, res.status, json.parameters?.retry_after);
  return json.result as T;
}

/** One Telegram message: HTML, and the plain text to fall back to if Telegram rejects the HTML. */
export interface Post {
  html: string;
  plain: string;
}

function renderParts(markdown: string, max = CHUNK_CHARS): Post[] {
  return splitMarkdown(markdown, max).flatMap((plain) => {
    const html = markdownToTelegramHtml(plain);
    return html.length <= HTML_CHARS || max < 500 ? [{ html, plain }] : renderParts(plain, Math.floor(max / 2));
  });
}

/** Header, then the body; later parts are numbered. Every part carries the thread id, which is how a reply to it finds its thread. */
function withHeader(head: Post, body: string, code: string): Post[] {
  const parts = renderParts(body);
  return parts.map((p, i) => {
    const h = i === 0 ? head : { html: `<i>(${i + 1}/${parts.length})</i>  <code>${escapeHtml(code)}</code>`, plain: `(${i + 1}/${parts.length})  ${code}` };
    return { html: `${h.html}\n\n${p.html}`, plain: `${h.plain}\n\n${p.plain}` };
  });
}

export function formatPosts(m: LoggedMessage, to: string): Post[] {
  const icon = m.via ? '👤' : m.kind === 'ask' ? '❓' : '💬';
  const code = shortThreadId(m.thread_id);
  return withHeader(
    { html: `<b>${icon} ${escapeHtml(m.from)} → ${escapeHtml(to)}</b>  <code>${escapeHtml(code)}</code>`, plain: `${icon} ${m.from} → ${to}  ${code}` },
    m.text,
    code,
  );
}

const OUTCOME: Partial<Record<DraftStatus, (by: string) => string>> = {
  answering: (by) => `⏳ ${by} answered — the reply is being written`,
  answered: (by) => `✅ Answered by ${by}`,
  superseded: () => '↪️ Replaced by a newer question',
};

/** The agent's question to its owner, and how to answer it: reply here, or continue the session in Claude. */
export function formatQuestion(d: Draft, self: string, owners: string): Post {
  const code = shortThreadId(d.thread_id);
  // Run on this machine, so in this machine's shell (PowerShell 5 has no &&).
  const resume = d.session_id ? `${d.cwd ? `cd "${d.cwd}"${process.platform === 'win32' ? ';' : ' &&'} ` : ''}claude --resume ${d.session_id}` : undefined;
  const question = d.question ?? '';
  const status = OUTCOME[d.status]?.(d.resolved_by ?? '?');
  return {
    html: [
      `🙋 <b>${escapeHtml(self)} asks ${escapeHtml(owners)}</b>  <code>${escapeHtml(code)}</code>`,
      `Before answering ${escapeHtml(d.peer)}:`,
      `${markdownToTelegramHtml(question)}`,
      '',
      resume
        ? `<i>Reply to this message to answer, or continue in Claude:</i> <code>${escapeHtml(resume)}</code>`
        : '<i>Reply to this message to answer.</i>',
      ...(status ? ['', status] : []),
    ].join('\n'),
    plain: [
      `🙋 ${self} asks ${owners}  ${code}`,
      `Before answering ${d.peer}:`,
      question,
      '',
      resume ? `Reply to this message to answer, or continue in Claude: ${resume}` : 'Reply to this message to answer.',
      ...(status ? ['', status] : []),
    ].join('\n'),
  };
}

interface ChatEvent {
  chat?: { id: number; title?: string; type?: string };
  new_chat_member?: { status?: string };
  from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: ChatEvent;
  channel_post?: ChatEvent;
  my_chat_member?: ChatEvent;
}

/** The offset that confirms these updates, so the next poll returns only newer ones. */
export const nextOffset = (updates: TelegramUpdate[], current = 0) => Math.max(current, ...updates.map((u) => (u.update_id ?? -1) + 1));

const POSTABLE_STATUS: Record<string, string[]> = {
  channel: ['administrator', 'creator'],
  group: ['member', 'administrator', 'creator'],
  supergroup: ['member', 'administrator', 'creator'],
};

/** Channels/groups the bot was just added to, or saw a post or mention in — how `agent-bridge telegram` finds the chat id. */
export function channelsFromUpdates(updates: TelegramUpdate[]): { id: number; title: string; type: string }[] {
  const found = new Map<number, { id: number; title: string; type: string }>();
  for (const u of updates) {
    const member = u.my_chat_member;
    const chat = member?.chat ?? u.channel_post?.chat ?? u.message?.chat;
    const allowed = chat?.type ? POSTABLE_STATUS[chat.type] : undefined;
    if (!chat || !allowed) continue;
    if (member && !allowed.includes(member.new_chat_member?.status ?? '')) continue;
    found.set(chat.id, { id: chat.id, title: chat.title ?? String(chat.id), type: chat.type! });
  }
  return [...found.values()];
}

/** Whether a bot with this membership can post in a chat of this type. */
export const canPost = (chatType: string, status: string, canPostMessages?: boolean) =>
  (POSTABLE_STATUS[chatType] ?? []).includes(status) && !(chatType === 'channel' && canPostMessages === false);

export interface TelegramMirror {
  /** Posts every message stored since the last successful post, then held answers and their outcomes. Safe to call often; concurrent calls no-op. */
  tick: () => Promise<void>;
}

/**
 * Mirror of this machine's agent-bridge log into a Telegram chat.
 * Every message lands exactly once: its sender posts it, unless the sender has no mirror to this chat, in which case the receiver does.
 * What the owner typed or approved in Telegram is already there, so it is not posted again.
 * Progress is a cursor in the store, so a crash, restart or Telegram outage never drops or reorders messages.
 */
export function createTelegramMirror(opts: {
  store: BridgeStore;
  selfName: string;
  target: TelegramTarget;
  /** Who the agent's questions are for, as shown on them. */
  owners?: () => string | undefined;
  fetchImpl?: Fetch;
  log: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}): TelegramMirror {
  const { store, target } = opts;
  const now = opts.now ?? Date.now;
  if (store.getKv(CURSOR_KEY) === undefined) store.setKv(CURSOR_KEY, String(store.latestSeq()));
  let running = false;
  let pausedUntil = 0;
  let lastError: string | undefined;
  const call = <T>(method: string, body: Record<string, unknown>) =>
    telegramCall<T>(target.botToken, method, { chat_id: target.chatId, ...body }, opts.fetchImpl);

  /** Returns the id of the last Telegram message sent. */
  const sendAll = async (posts: Post[], where: { chat?: string | number; lastExtra?: Record<string, unknown> } = {}): Promise<number> => {
    let id = 0;
    for (const [i, post] of posts.entries()) {
      const extra = { chat_id: where.chat ?? target.chatId, link_preview_options: { is_disabled: true }, ...(i === posts.length - 1 ? where.lastExtra : {}) };
      try {
        id = (await call<{ message_id: number }>('sendMessage', { text: post.html, parse_mode: 'HTML', ...extra })).message_id;
      } catch (err) {
        if (!(err instanceof TelegramError && err.status === 400 && PARSE_ERROR.test(err.message))) throw err;
        opts.log('telegram_plain_fallback', { error: err.message });
        id = (await call<{ message_id: number }>('sendMessage', { text: post.plain, ...extra })).message_id;
      }
    }
    return id;
  };

  /** Runs one post; false means stop this tick and retry later. */
  const attempt = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      lastError = undefined;
      return true;
    } catch (err) {
      const e = err as Error;
      if (e instanceof TelegramError && e.status === 400 && MESSAGE_SPECIFIC_400.test(e.message)) {
        opts.log('telegram_skipped', { what, error: e.message });
        return true;
      }
      if (e.message !== lastError) opts.log('telegram_failed', { error: e.message });
      lastError = e.message;
      if (e instanceof TelegramError && e.retryAfterS) pausedUntil = now() + e.retryAfterS * 1000;
      return false;
    }
  };

  const postMessages = async (): Promise<boolean> => {
    for (;;) {
      const batch = store.messagesAfter(Number(store.getKv(CURSOR_KEY)), BATCH);
      if (!batch.length) return true;
      for (const m of batch) {
        // Each side posts what it sends; an incoming message is posted here only if its sender doesn't mirror to this chat.
        const theirs = m.direction === 'in' && m.mirror === String(target.chatId);
        if (!theirs && m.via !== 'owner-in-chat') {
          const to = m.direction === 'in' ? opts.selfName : (store.getThread(m.thread_id)?.peer ?? '?');
          if (!(await attempt(m.id, async () => void (await sendAll(formatPosts(m, to)))))) return false;
        }
        store.setKv(CURSOR_KEY, String(m.seq));
      }
    }
  };

  const postQuestions = async (): Promise<boolean> => {
    const owners = opts.owners?.() || 'the owner';
    for (const d of store.unpostedDrafts()) {
      let posted = 0;
      // A question replaced before it went out is never posted (0 marks it done).
      if (d.status === 'pending' && !(await attempt(d.id, async () => void (posted = await sendAll([formatQuestion(d, opts.selfName, owners)]))))) return false;
      store.setDraftPosted(d.id, posted);
      if (!posted) store.setDraftShown(d.id, d.status);
    }
    for (const d of store.draftsToRefresh()) {
      const q = formatQuestion(d, opts.selfName, owners);
      const ok = await attempt(d.id, async () => {
        try {
          await call('editMessageText', { message_id: d.posted_message_id, text: q.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        } catch (err) {
          // Already showing it, or the post is gone: nothing left to update.
          if (!(err instanceof TelegramError && err.status === 400)) throw err;
        }
      });
      if (!ok) return false;
      store.setDraftShown(d.id, d.status);
    }
    return true;
  };

  async function tick(): Promise<void> {
    if (running || now() < pausedUntil) return;
    running = true;
    try {
      if (await postMessages()) await postQuestions();
    } finally {
      running = false;
    }
  }

  return { tick };
}
