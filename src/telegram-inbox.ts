import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { OwnerActions } from './daemon.ts';
import type { BridgeStore, PeerRecord } from './store.ts';
import { TelegramError, chatForPeer, configuredChats, telegramCall, type TelegramTarget } from './telegram.ts';

type Fetch = typeof fetch;

/** This machine's Telegram settings. `hub` names the connected machine that reads the shared bot; absent = this machine reads it. */
export interface TelegramSettings extends TelegramTarget {
  chatTitle?: string;
  hub?: string;
}

interface User {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
}

interface Message {
  message_id: number;
  from?: User;
  chat: { id: number; type?: string };
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
  reply_to_message?: Message;
}

interface Tap {
  id: string;
  from: User;
  message?: Message;
  data?: string;
}

interface Update {
  update_id: number;
  message?: Message;
  callback_query?: Tap;
}

const SEND_BUTTON = /^c:([0-9a-f]{1,32})$/;
const TAP_RESULT: Record<string, string> = {
  sent: 'Sent',
  'already answered': 'Already answered',
  'nothing to send': 'Nothing to send — reply to the post instead',
  'not found': 'This answer no longer exists',
};

const OFFSET_KEY = 'telegram_update_offset';
const CONFLICT_BACKOFF_MS = 30_000;
const ERROR_BACKOFF_MS = 5_000;
const PEER_TIMEOUT_MS = 10_000;
/** Consecutive 409s after which another program is clearly reading this bot too. */
const CONFLICTS_BEFORE_WARNING = 3;
const CLAIM_TTL_MS = 15 * 60_000;
/** Thread ids as posted ("<asker>-<first 8 of uuid>"), for posts that fell back to plain text. */
const SHORT_THREAD = /\b[a-z0-9_-]+-[0-9a-f]{8}\b/g;
const START = /^\/start\s+(\S+)$/;

const UpdateSchema = z.object({ update_id: z.number(), message: z.unknown().optional(), callback_query: z.unknown().optional() }).passthrough();
const OwnerSchema = z.object({ id: z.number().int(), name: z.string().min(1).max(100) });
const OwnersSchema = z.object({ owners: z.array(OwnerSchema).max(20) });

const fullName = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.id);

export interface TelegramInbox {
  /** Hub only: one long poll, each update acted on here or forwarded to its owner's machine. Resolves to how long to wait. Never throws. */
  pollOnce: (timeoutS?: number) => Promise<number>;
  /** Adds the peer and local endpoints for joining the shared bot, registering owners and receiving forwarded updates. */
  mount: (peerApp: Hono, localApp: Hono) => void;
  /** Resolves once forwarded updates being acted on are done. */
  idle: () => Promise<void>;
}

/**
 * Lets people act from the shared Telegram chat. Replying to a bridge post answers in its thread; replying to an
 * agent's question to its owner answers that question. Each machine's owners are registered by a one-time link.
 *
 * One bot can serve several machines: Telegram lets only one program read a bot, so one machine (the hub) reads it,
 * acts for its own owners, and forwards what other machines' owners do to those machines over agent-bridge.
 * Each update is taken at most once (the offset is saved before acting), so a crash never sends an owner's words twice.
 */
export function createTelegramInbox(opts: {
  store: BridgeStore;
  selfName: string;
  settings: () => TelegramSettings | undefined;
  actions: OwnerActions;
  authenticate: (authorization: string | undefined) => PeerRecord | undefined;
  fetchImpl?: Fetch;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** After an owner acted, so the chat reflects it without waiting for the next mirror tick. */
  afterAction?: () => void;
  now?: () => number;
}): TelegramInbox {
  const { store, selfName, actions } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const working = new Set<Promise<unknown>>();
  let botName: string | undefined;
  let lastError: string | undefined;
  let conflicts = 0;
  let warned = false;

  const settings = () => {
    const s = opts.settings();
    if (!s) throw new Error('Telegram is not set up on this machine');
    return s;
  };
  const isHub = () => Boolean(opts.settings() && !opts.settings()!.hub);
  const call = <T>(method: string, body: Record<string, unknown>, timeoutMs?: number) =>
    telegramCall<T>(settings().botToken, method, body, fetchImpl, timeoutMs);
  const say = (chatId: number | string, text: string, replyTo?: number) =>
    call('sendMessage', { chat_id: chatId, text, ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}) }).catch(() => {});

  async function toPeer<T>(machine: string, path: string, body: unknown): Promise<T> {
    const peer = store.getPeer(machine);
    if (!peer) throw new Error(`not connected to ${machine}`);
    const res = await fetchImpl(`${peer.url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `${machine} responded ${res.status}`);
    return json;
  }

  async function bot(): Promise<string> {
    botName ??= (await call<{ username: string }>('getMe', {})).username;
    return botName;
  }

  /** One-time codes live in the store, so a restart of the hub (an update, say) does not expire open links. */
  function claim(machine: string): string {
    const code = randomBytes(6).toString('hex');
    store.setKv(`claim:${code}`, JSON.stringify({ machine, expires: now() + CLAIM_TTL_MS }));
    return code;
  }

  function takeClaim(code: string): string | undefined {
    if (!/^[0-9a-f]{12}$/.test(code)) return undefined;
    const raw = store.getKv(`claim:${code}`);
    if (!raw) return undefined;
    store.setKv(`claim:${code}`, '{}');
    const { machine, expires } = JSON.parse(raw) as { machine?: string; expires?: number };
    return machine && (expires ?? 0) >= now() ? machine : undefined;
  }

  /** Any chat this machine posts to (the default or a colleague's own), or this owner's private chat with the bot: the only places an owner acts from. */
  const where = (chat: Message['chat'] | undefined, owner: { id: number }) =>
    configuredChats(settings()).includes(String(chat?.id)) ? 'shared' : chat?.id === owner.id ? 'private' : undefined;
  /** A colleague's thread or question is acted on in that colleague's chat only, never in another colleague's. */
  const routedTo = (chat: Message['chat'] | undefined, owner: { id: number }, peer: string | undefined) =>
    where(chat, owner) !== 'shared' || String(chatForPeer(settings(), peer)) === String(chat?.id);
  /** A text reply to a post by the bot, where this owner acts: the only messages anyone acts on. */
  const actionable = (m: Message, owner: { id: number }) => Boolean(m.text && m.reply_to_message?.from?.is_bot && where(m.chat, owner));

  function threadOf(post: Message): string | undefined {
    if (!post.text) return undefined;
    const coded = (post.entities ?? []).filter((e) => e.type === 'code').map((e) => post.text!.slice(e.offset, e.offset + e.length));
    for (const candidate of coded.length ? coded : (post.text.match(SHORT_THREAD) ?? [])) {
      const ids = store.findThreadIds(candidate);
      if (ids.length === 1) return ids[0];
    }
    return undefined;
  }

  /** Acts on a message from one of this machine's owners (`known`: as the hub vouches for them). */
  async function act(m: Message, known?: { id: number; name: string }): Promise<void> {
    const owner = known ? { ...known, machine: selfName } : m.from && !m.from.is_bot ? store.telegramOwner(m.from.id) : undefined;
    const post = m.reply_to_message;
    if (!owner || owner.machine !== selfName || !post || !actionable(m, owner)) return;
    const question = store.draftByPost(m.chat.id, post.message_id);
    // In the private chat, the bot only posts questions; anything else there is not about a thread.
    if (!question && where(m.chat, owner) === 'private') return;
    if (question && !routedTo(m.chat, owner, question.peer)) return;
    try {
      if (question) {
        const outcome = await actions.answerOwnerQuestion(question.id, m.text!, owner.name);
        if (outcome !== 'answered') return void (await say(m.chat.id, 'This question was already answered.', m.message_id));
      } else {
        const threadId = threadOf(post);
        if (!threadId || !routedTo(m.chat, owner, store.getThread(threadId)?.peer)) return;
        await actions.ownerReply({ threadId, text: m.text!, owner: owner.name, seenInChat: true });
      }
    } catch (err) {
      opts.log('owner_action_failed', { error: (err as Error).message });
      return void (await say(m.chat.id, `⚠️ Not sent: ${(err as Error).message}`, m.message_id));
    }
    await call('setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {});
    opts.afterAction?.();
  }

  /** ✅ Send under a draft, tapped by one of this machine's owners (`known`: as the hub vouches for them). */
  async function tap(q: Tap, known?: { id: number; name: string }): Promise<void> {
    const draftId = SEND_BUTTON.exec(q.data ?? '')?.[1];
    const owner = known ? { ...known, machine: selfName } : store.telegramOwner(q.from.id);
    if (!draftId) return void (await call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {}));
    // The draft must be this machine's: the same bot carries other machines' drafts too.
    const draft = draftId ? store.getDraft(draftId) : undefined;
    if (!owner || owner.machine !== selfName || !where(q.message?.chat, owner) || !draft || !routedTo(q.message?.chat, owner, draft.peer)) {
      await call('answerCallbackQuery', { callback_query_id: q.id, text: 'Only the owner of this answer can send it.', show_alert: true }).catch(() => {});
      return;
    }
    let text: string;
    try {
      text = TAP_RESULT[await actions.confirmOwnerDraft(draftId, owner.name)] ?? 'Done';
    } catch (err) {
      await call('answerCallbackQuery', { callback_query_id: q.id, text: `Not sent: ${(err as Error).message}`, show_alert: true }).catch(() => {});
      return;
    }
    await call('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
    opts.afterAction?.();
  }

  async function register(user: User, code: string): Promise<void> {
    const machine = takeClaim(code);
    if (!machine) return void (await say(user.id, '⚠️ This link has expired. Run `agent-bridge telegram` again for a new one.'));
    store.setTelegramOwner({ id: user.id, name: fullName(user), machine });
    opts.log('owner_registered', { machine, name: fullName(user) });
    // Best effort: a member also learns its owners when it asks, and from every reply forwarded to it.
    if (machine !== selfName) {
      await toPeer(machine, '/telegram/owners', { owners: ownersOf(machine) }).catch((err) => opts.log('owner_push_failed', { machine, error: (err as Error).message }));
    }
    const chat = settings().chatTitle ? `"${settings().chatTitle}"` : 'the group';
    await say(user.id, `✓ You answer for ${machine}'s agent in ${chat}: reply to its posts there.`);
  }

  const ownersOf = (machine: string) => store.telegramOwners(machine).map(({ id, name }) => ({ id, name }));

  /** Hub: the setup link, this machine's own owners, or another machine's owners (forwarded to their machine). */
  async function route(u: Update): Promise<void> {
    const q = u.callback_query;
    const m = u.message;
    const from = q?.from ?? m?.from;
    if (!from || from.is_bot) return;
    const code = m?.chat.type === 'private' ? START.exec(m.text?.trim() ?? '')?.[1] : undefined;
    if (code) return register(from, code);
    const owner = store.telegramOwner(from.id);
    if (!owner) return q ? tap(q) : undefined;
    if (m && !actionable(m, owner)) return;
    if (owner.machine === selfName) return q ? tap(q) : act(m!);
    try {
      await toPeer(owner.machine, '/telegram/update', { update: u, owner: { id: owner.id, name: owner.name } });
    } catch (err) {
      opts.log('telegram_forward_failed', { machine: owner.machine, error: (err as Error).message });
      const text = `⚠️ Could not reach ${owner.machine}'s machine, so this was not delivered. Try again when it is online.`;
      if (q) await call('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: true }).catch(() => {});
      else await say(m!.chat.id, text, m!.message_id);
    }
  }

  async function pollOnce(timeoutS = 25): Promise<number> {
    let updates: Update[];
    try {
      if (store.getKv(OFFSET_KEY) === undefined) {
        // First time on: what was waiting predates this machine reading the bot and must not act now.
        const [latest] = await call<Update[]>('getUpdates', { offset: -1, timeout: 0 });
        store.setKv(OFFSET_KEY, String(latest ? latest.update_id + 1 : 0));
      }
      updates = await call<Update[]>(
        'getUpdates',
        { offset: Number(store.getKv(OFFSET_KEY)), timeout: timeoutS, allowed_updates: ['message', 'callback_query'] },
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
        await say(
          settings().chatId,
          "⚠️ agent-bridge: another program is reading this bot's updates too, so replies here can get lost. Only one machine may read a bot: " +
            'the others join through it with `agent-bridge telegram --hub=<that machine>`.',
        );
      }
      return conflict ? CONFLICT_BACKOFF_MS : ERROR_BACKOFF_MS;
    }
    for (const u of updates) {
      store.setKv(OFFSET_KEY, String(u.update_id + 1));
      try {
        await route(u);
      } catch (err) {
        opts.log('telegram_update_failed', { update: u.update_id, error: (err as Error).message });
      }
    }
    return 0;
  }

  function mount(peerApp: Hono, localApp: Hono): void {
    /** The connected machine named as this machine's hub, or an HTTP error. */
    const fromHub = (authorization: string | undefined): PeerRecord | 401 | 403 => {
      const peer = opts.authenticate(authorization);
      if (!peer) return 401;
      return opts.settings()?.hub === peer.name ? peer : 403;
    };

    peerApp.post('/telegram/join', async (c) => {
      const peer = opts.authenticate(c.req.header('authorization'));
      if (!peer) return c.json({ error: 'unauthorized' }, 401);
      if (!isHub()) return c.json({ error: `${selfName} does not read a Telegram bot` }, 404);
      const s = settings();
      // The chat routed for the joining machine, never another colleague's.
      const own = Object.hasOwn(s.peerChats ?? {}, peer.name) ? s.peerChats![peer.name] : undefined;
      return c.json({ botToken: s.botToken, chatId: own?.chatId ?? s.chatId, chatTitle: own ? own.chatTitle : s.chatTitle, bot: await bot(), code: claim(peer.name) });
    });
    peerApp.post('/telegram/owners', async (c) => {
      const hub = fromHub(c.req.header('authorization'));
      if (typeof hub === 'number') return c.json({ error: hub === 401 ? 'unauthorized' : 'not my hub' }, hub);
      const parsed = OwnersSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid owners' }, 400);
      store.replaceTelegramOwners(selfName, parsed.data.owners);
      opts.log('owners_updated', { by: hub.name, owners: parsed.data.owners.map((o) => o.name) });
      return c.json({ ok: true });
    });
    peerApp.post('/telegram/update', async (c) => {
      const hub = fromHub(c.req.header('authorization'));
      if (typeof hub === 'number') return c.json({ error: hub === 401 ? 'unauthorized' : 'not my hub' }, hub);
      const parsed = z.object({ update: UpdateSchema, owner: OwnerSchema }).safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid update' }, 400);
      const { message: m, callback_query: q } = parsed.data.update as Update;
      // The hub vouches for who this is; remember it, and answer the hub at once (acting may take a while).
      store.setTelegramOwner({ ...parsed.data.owner, machine: selfName });
      if (m || q) {
        const job = (q ? tap(q, parsed.data.owner) : act(m!, parsed.data.owner)).catch((err) => opts.log('telegram_update_failed', { error: (err as Error).message }));
        working.add(job);
        void job.finally(() => working.delete(job));
      }
      return c.json({ accepted: true }, 202);
    });
    peerApp.post('/telegram/owners/mine', async (c) => {
      const peer = opts.authenticate(c.req.header('authorization'));
      if (!peer) return c.json({ error: 'unauthorized' }, 401);
      return c.json({ owners: ownersOf(peer.name) });
    });

    localApp.post('/local/telegram/claim', async (c) => {
      const body = z.object({ hub: z.string().max(50).optional() }).safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: 'invalid' }, 400);
      try {
        if (body.data.hub) return c.json(await toPeer<Record<string, unknown>>(body.data.hub, '/telegram/join', {}));
        if (!isHub()) return c.json({ error: 'Telegram is not set up on this machine' }, 400);
        return c.json({ code: claim(selfName), bot: await bot() });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });
    localApp.get('/local/telegram/owners', async (c) => {
      const hub = opts.settings()?.hub;
      if (hub) {
        await toPeer<{ owners: { id: number; name: string }[] }>(hub, '/telegram/owners/mine', {})
          .then(({ owners }) => store.replaceTelegramOwners(selfName, owners))
          .catch((err) => opts.log('owner_sync_failed', { hub, error: (err as Error).message }));
      }
      return c.json({ owners: store.telegramOwners(selfName) });
    });
  }

  return {
    pollOnce,
    mount,
    idle: async () => {
      while (working.size) await Promise.allSettled([...working]);
    },
  };
}
