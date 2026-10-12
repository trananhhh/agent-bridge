import type { OwnerActions } from './daemon.ts';
import type { BridgeStore } from './store.ts';
import { TelegramError, telegramCall, type TelegramTarget } from './telegram.ts';

type Fetch = typeof fetch;

export interface TelegramOwner {
  id: number;
  name: string;
}

interface User {
  id: number;
  is_bot?: boolean;
}

interface Message {
  message_id: number;
  from?: User;
  chat: { id: number; type?: string };
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
  reply_to_message?: Message;
}

interface Update {
  update_id: number;
  message?: Message;
  callback_query?: { id: string; from: User; message?: Message; data?: string };
}

const OFFSET_KEY = 'telegram_update_offset';
const CONFLICT_BACKOFF_MS = 30_000;
/** Consecutive 409s after which another machine is clearly reading this bot too. */
const CONFLICTS_BEFORE_WARNING = 3;
const ERROR_BACKOFF_MS = 5_000;
/** Thread ids as posted ("<asker>-<first 8 of uuid>"), for posts that fell back to plain text. */
const SHORT_THREAD = /\b[a-z0-9_-]+-[0-9a-f]{8}\b/g;
const BUTTON = /^d:([0-9a-f]+):(send|drop)$/;

const OUTCOME_TEXT = {
  sent: 'Sent',
  dropped: 'Not sent',
  'already handled': 'Already handled',
  'nothing to send': 'Nothing to send — reply to the post with your answer',
  'not found': 'This draft no longer exists',
};

export interface TelegramInbox {
  /** One long poll. Resolves to how long to wait before the next one. Never throws. */
  pollOnce: (timeoutS?: number) => Promise<number>;
}

/**
 * Lets this machine's owners act from Telegram: replying to any bridge post in the shared chat answers in its thread;
 * in their private chat with the bot, the buttons under a held answer send or drop it, and replying to it answers instead.
 * Everyone else is ignored.
 * Each update is taken at most once (the offset is saved before acting), so a crash never sends an owner's words twice.
 */
export function createTelegramInbox(opts: {
  store: BridgeStore;
  target: TelegramTarget;
  owners: TelegramOwner[];
  actions: OwnerActions;
  fetchImpl?: Fetch;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** After an owner acted, so the chat reflects it without waiting for the next mirror tick. */
  afterAction?: () => void;
}): TelegramInbox {
  const { store, target, actions } = opts;
  const chat = String(target.chatId);
  const ownerNames = opts.owners.map((o) => o.name).join(' or ');
  const ownerOf = (user?: User) => (user && !user.is_bot ? opts.owners.find((o) => o.id === user.id) : undefined);
  /** The shared chat, or this owner's private chat with the bot. */
  const where = (c: Message['chat'] | undefined, owner: TelegramOwner) =>
    String(c?.id) === chat ? 'shared' : c?.id === owner.id ? 'private' : undefined;
  const call = <T>(method: string, body: Record<string, unknown>, timeoutMs?: number) =>
    telegramCall<T>(target.botToken, method, body, opts.fetchImpl, timeoutMs);
  let lastError: string | undefined;
  let conflicts = 0;
  let warned = false;

  function threadOf(post: Message, place: 'shared' | 'private'): string | undefined {
    if (!post.from?.is_bot) return undefined;
    // Held answers are posted privately; message ids are only unique within a chat.
    if (place === 'private') return store.draftByPost(post.message_id)?.thread_id;
    if (!post.text) return undefined;
    const coded = (post.entities ?? []).filter((e) => e.type === 'code').map((e) => post.text!.slice(e.offset, e.offset + e.length));
    for (const candidate of coded.length ? coded : (post.text.match(SHORT_THREAD) ?? [])) {
      const ids = store.findThreadIds(candidate);
      if (ids.length === 1) return ids[0];
    }
    return undefined;
  }

  async function onMessage(m: Message): Promise<void> {
    const owner = ownerOf(m.from);
    const place = owner && where(m.chat, owner);
    if (!owner || !place || !m.text || !m.reply_to_message) return;
    const threadId = threadOf(m.reply_to_message, place);
    if (!threadId) return;
    try {
      await actions.ownerReply({ threadId, text: m.text, owner: owner.name, seenInChat: place === 'shared' });
    } catch (err) {
      opts.log('owner_reply_failed', { thread: threadId, error: (err as Error).message });
      await call('sendMessage', { chat_id: m.chat.id, reply_parameters: { message_id: m.message_id }, text: `⚠️ Not sent: ${(err as Error).message}` });
      return;
    }
    await call('setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {});
    opts.afterAction?.();
  }

  async function onButton(q: NonNullable<Update['callback_query']>): Promise<void> {
    const button = BUTTON.exec(q.data ?? '');
    const owner = ownerOf(q.from);
    if (!button) return void (await call('answerCallbackQuery', { callback_query_id: q.id }));
    if (!owner || !where(q.message?.chat, owner)) {
      await call('answerCallbackQuery', { callback_query_id: q.id, text: `Only ${ownerNames} can decide this.`, show_alert: true });
      return;
    }
    let text: string;
    try {
      text = OUTCOME_TEXT[await actions.resolveDraft(button[1], button[2] as 'send' | 'drop', owner.name)];
    } catch (err) {
      await call('answerCallbackQuery', { callback_query_id: q.id, text: `Not sent: ${(err as Error).message}`, show_alert: true });
      return;
    }
    await call('answerCallbackQuery', { callback_query_id: q.id, text });
    opts.afterAction?.();
  }

  async function pollOnce(timeoutS = 25): Promise<number> {
    let updates: Update[];
    try {
      if (store.getKv(OFFSET_KEY) === undefined) {
        // First time on: what was waiting predates this feature (or this owner) and must not act now.
        const [latest] = await call<Update[]>('getUpdates', { offset: -1, timeout: 0 });
        store.setKv(OFFSET_KEY, String(latest ? latest.update_id + 1 : 0));
      }
      updates = await call<Update[]>(
        'getUpdates',
        { offset: Number(store.getKv(OFFSET_KEY) ?? 0), timeout: timeoutS, allowed_updates: ['message', 'callback_query'] },
        (timeoutS + 15) * 1000,
      );
      lastError = undefined;
      conflicts = 0;
    } catch (err) {
      const e = err as Error;
      const conflict = e instanceof TelegramError && e.status === 409;
      if (e.message !== lastError) opts.log(conflict ? 'telegram_poll_conflict' : 'telegram_poll_failed', { error: e.message });
      lastError = e.message;
      conflicts = conflict ? conflicts + 1 : 0;
      if (conflicts >= CONFLICTS_BEFORE_WARNING && !warned) {
        warned = true;
        await call('sendMessage', {
          chat_id: target.chatId,
          text: "⚠️ agent-bridge: another machine is reading this bot's updates too, so replies and buttons here can get lost. Each machine needs its own bot: create one with @BotFather and run `agent-bridge telegram` again on one of them.",
        }).catch(() => {});
      }
      return conflict ? CONFLICT_BACKOFF_MS : ERROR_BACKOFF_MS;
    }
    for (const u of updates) {
      store.setKv(OFFSET_KEY, String(u.update_id + 1));
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onButton(u.callback_query);
      } catch (err) {
        opts.log('telegram_update_failed', { update: u.update_id, error: (err as Error).message });
      }
    }
    return 0;
  }

  return { pollOnce };
}
