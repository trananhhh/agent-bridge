import { shortThreadId } from './protocol.ts';
import type { BridgeStore, LoggedMessage } from './store.ts';

export interface TelegramTarget {
  botToken: string;
  chatId: string | number;
}

type Fetch = typeof fetch;

const API = 'https://api.telegram.org';
const CALL_TIMEOUT_MS = 15_000;
/** Telegram caps a message at 4096 characters; leave room for the header. */
const CHUNK_CHARS = 3800;
const CURSOR_KEY = 'telegram_cursor';
const BATCH = 20;
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
export async function telegramCall<T>(token: string, method: string, body: Record<string, unknown>, fetchImpl: Fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
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

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function splitText(text: string, max = CHUNK_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const newline = rest.lastIndexOf('\n', max);
    const cut = newline > max / 2 ? newline : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  parts.push(rest);
  return parts;
}

export function formatPosts(m: LoggedMessage, to: string): string[] {
  const icon = m.kind === 'ask' ? '❓' : '💬';
  const header = `<b>${icon} ${escapeHtml(m.from)} → ${escapeHtml(to)}</b>  <code>${escapeHtml(shortThreadId(m.thread_id))}</code>`;
  const parts = splitText(m.text);
  return parts.map((p, i) => `${i === 0 ? header : `<i>(${i + 1}/${parts.length})</i>`}\n\n${escapeHtml(p)}`);
}

export type TelegramUpdate = Record<string, { chat?: { id: number; title?: string; type?: string }; new_chat_member?: { status?: string } } | undefined>;

/** Channels where the bot was just made admin, or which posted something — how `agent-bridge telegram` finds the chat id. */
export function channelsFromUpdates(updates: TelegramUpdate[]): { id: number; title: string }[] {
  const found = new Map<number, string>();
  for (const u of updates) {
    const member = u.my_chat_member;
    const post = u.channel_post;
    const chat = member?.chat ?? post?.chat;
    if (!chat || chat.type !== 'channel') continue;
    if (member && !['administrator', 'creator'].includes(member.new_chat_member?.status ?? '')) continue;
    found.set(chat.id, chat.title ?? String(chat.id));
  }
  return [...found].map(([id, title]) => ({ id, title }));
}

export interface TelegramMirror {
  /** Posts every message stored since the last successful post. Safe to call often; concurrent calls no-op. */
  tick: () => Promise<void>;
}

/**
 * Read-only mirror of this machine's agent-bridge log into a Telegram channel.
 * Progress is a cursor in the store, so a crash, restart or Telegram outage never drops or reorders messages.
 */
export function createTelegramMirror(opts: {
  store: BridgeStore;
  selfName: string;
  target: TelegramTarget;
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

  const post = async (m: LoggedMessage) => {
    const to = m.direction === 'in' ? opts.selfName : (store.getThread(m.thread_id)?.peer ?? '?');
    for (const text of formatPosts(m, to)) {
      await telegramCall(target.botToken, 'sendMessage', { chat_id: target.chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, opts.fetchImpl);
    }
  };

  async function tick(): Promise<void> {
    if (running || now() < pausedUntil) return;
    running = true;
    try {
      for (;;) {
        const batch = store.messagesAfter(Number(store.getKv(CURSOR_KEY)), BATCH);
        if (!batch.length) return;
        for (const m of batch) {
          try {
            await post(m);
            lastError = undefined;
          } catch (err) {
            const e = err as Error;
            if (e instanceof TelegramError && e.status === 400 && MESSAGE_SPECIFIC_400.test(e.message)) {
              opts.log('telegram_skipped', { id: m.id, error: e.message });
            } else {
              if (e.message !== lastError) opts.log('telegram_failed', { error: e.message });
              lastError = e.message;
              if (e instanceof TelegramError && e.retryAfterS) pausedUntil = now() + e.retryAfterS * 1000;
              return;
            }
          }
          store.setKv(CURSOR_KEY, String(m.seq));
        }
      }
    } finally {
      running = false;
    }
  }

  return { tick };
}
