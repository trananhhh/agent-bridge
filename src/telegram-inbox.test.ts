import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { BridgeStore, type PeerRecord } from './store.ts';
import { createTelegramInbox, type TelegramSettings } from './telegram-inbox.ts';
import { fakeTelegram } from './test-support/fake-telegram.ts';
import type { AnswerOutcome, OwnerActions, OwnerReplyInput } from './daemon.ts';

const THREAD = 'cu-35c42200-8133-42d7-a7a9-6e7204d05aa0';
const CHAT = -1001;
const ANH = { id: 42, is_bot: false, first_name: 'Trần', last_name: 'Anh' };
const CU = { id: 7, is_bot: false, first_name: 'Cừ' };
const BOT = { id: 5, is_bot: true, first_name: 'bridge' };
const TOKEN = '123:secret';

const bridgePost = (messageId: number, code = 'cu-35c42200') => {
  const text = `❓ cu → anh  ${code}\n\nquestion`;
  return { message_id: messageId, from: BOT, chat: { id: CHAT }, text, entities: [{ type: 'code', offset: text.indexOf(code), length: code.length }] };
};

interface Machine {
  name: string;
  store: BridgeStore;
  settings: TelegramSettings | undefined;
  replies: OwnerReplyInput[];
  answers: [string, string, string][];
  confirms: [string, string][];
  outcome: AnswerOutcome;
  peerApp: Hono;
  localApp: Hono;
  inbox: ReturnType<typeof createTelegramInbox>;
}

describe('telegram inbox', () => {
  let dir: string;
  let tg: ReturnType<typeof fakeTelegram>;
  let logs: string[];
  let updateId = 0;
  let messageId = 500;
  const machines = new Map<string, Machine>();
  const peerCalls: string[] = [];

  /** Telegram calls go to the fake; peer calls go to that machine's peer app. */
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://api.telegram.org/')) return tg.fetchImpl(url, init);
    const target = machines.get(new URL(url).hostname.replace(/\.test$/, ''));
    peerCalls.push(`${new URL(url).hostname} ${new URL(url).pathname}`);
    if (!target) throw new Error('ECONNREFUSED');
    return target.peerApp.request(new URL(url).pathname, init);
  }) as typeof fetch;

  function addMachine(name: string, settings: TelegramSettings | undefined, peers: string[]): Machine {
    const store = new BridgeStore(join(dir, `${name}.db`));
    store.setKv('telegram_update_offset', '0');
    for (const p of peers) store.upsertPeer({ name: p, url: `http://${p}.test`, token: `tok-${[name, p].sort().join('-')}`, folders: ['/w'], remoteFolders: [] });
    const m = { name, store, settings, replies: [], answers: [], confirms: [], outcome: 'answered', peerApp: new Hono(), localApp: new Hono() } as unknown as Machine;
    const actions: OwnerActions = {
      ownerReply: async (input) => {
        m.replies.push(input);
        return { id: 'x', thread_id: input.threadId, to: 'cu', status: 'sent' };
      },
      answerOwnerQuestion: async (id, text, owner) => {
        m.answers.push([id, text, owner]);
        return m.outcome;
      },
      confirmOwnerDraft: async (id, owner) => {
        m.confirms.push([id, owner]);
        return m.outcome === 'answered' ? 'sent' : m.outcome;
      },
    };
    m.inbox = createTelegramInbox({
      store,
      selfName: name,
      settings: () => m.settings,
      actions,
      authenticate: (header) => store.listPeers().find((p: PeerRecord) => header === `Bearer ${p.token}`),
      fetchImpl,
      log: (event) => logs.push(event),
    });
    m.inbox.mount(m.peerApp, m.localApp);
    machines.set(name, m);
    return m;
  }

  const deliver = (...updates: Record<string, unknown>[]) => tg.respond(updates.map((u) => ({ update_id: ++updateId, ...u })));
  const say = (from: { id: number; is_bot: boolean; first_name: string; last_name?: string }, over: Record<string, unknown>) => ({
    message: { message_id: ++messageId, from, chat: { id: CHAT, type: 'group' }, text: 'Đúng rồi', ...over },
  });
  const calls = (method: string) => tg.sent.filter((s) => s.method === method).map((s) => s.body);
  const post = (app: Hono, path: string, body: unknown, token?: string) =>
    app.request(path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

  let hub: Machine;
  let member: Machine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-inbox-'));
    tg = fakeTelegram();
    logs = [];
    peerCalls.length = 0;
    machines.clear();
    hub = addMachine('anh', { botToken: TOKEN, chatId: CHAT, chatTitle: 'TAP BOD' }, ['cu']);
    member = addMachine('cu', { botToken: TOKEN, chatId: CHAT, chatTitle: 'TAP BOD', hub: 'anh' }, ['anh']);
    for (const m of [hub, member]) m.store.insertMessage({ id: 'q', thread_id: THREAD, from: 'cu', kind: 'ask', text: 'q', sent_at: 'now' }, m.name === 'anh' ? 'in' : 'out');
    hub.store.setTelegramOwner({ id: ANH.id, name: 'Trần Anh', machine: 'anh' });
  });
  afterEach(() => {
    for (const m of machines.values()) m.store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('acting for this machine', () => {
    it("sends the owner's reply to a bridge post — by either side — into that post's thread, and marks it 👍", async () => {
      deliver(say(ANH, { reply_to_message: bridgePost(90) }));
      expect(await hub.inbox.pollOnce(0)).toBe(0);
      expect(hub.replies).toEqual([{ threadId: THREAD, text: 'Đúng rồi', owner: 'Trần Anh', seenInChat: true }]);
      expect(calls('setMessageReaction')).toEqual([{ chat_id: CHAT, message_id: messageId, reaction: [{ type: 'emoji', emoji: '👍' }] }]);
    });

    it("answers the agent's question when the owner replies to its notification", async () => {
      hub.store.insertDraft({ id: 'q1', thread_id: THREAD, peer: 'cu', question: 'ok?', text: 'x', session_id: 's' });
      hub.store.addDraftPost('q1', CHAT, 91, 'full');
      deliver(say(ANH, { reply_to_message: { message_id: 91, from: BOT, chat: { id: CHAT }, text: '🙋 anh needs Trần Anh' } }));
      await hub.inbox.pollOnce(0);
      expect(hub.answers).toEqual([['q1', 'Đúng rồi', 'Trần Anh']]);
      expect(hub.replies).toEqual([]);
      expect(calls('setMessageReaction')).toHaveLength(1);

      hub.outcome = 'already answered';
      deliver(say(ANH, { reply_to_message: { message_id: 91, from: BOT, chat: { id: CHAT }, text: '🙋' } }));
      await hub.inbox.pollOnce(0);
      expect(String(calls('sendMessage').at(-1)?.text)).toMatch(/already answered/);
    });

    it("answers a private question when the owner replies to it in their private chat with the bot", async () => {
      hub.store.insertDraft({ id: 'q2', thread_id: THREAD, peer: 'cu', question: 'private?', text: 'x', private: true });
      hub.store.addDraftPost('q2', ANH.id, 93, 'full');
      const dm = { id: ANH.id, type: 'private' };
      deliver(
        say(ANH, { chat: dm, reply_to_message: { message_id: 93, from: BOT, chat: dm, text: '🙋' } }),
        say(ANH, { chat: dm, reply_to_message: { message_id: 90, from: BOT, chat: dm, text: '🙋' } }),
      );
      await hub.inbox.pollOnce(0);
      expect(hub.answers).toEqual([['q2', 'Đúng rồi', 'Trần Anh']]);
    });

    it('sends the draft when its owner taps ✅ Send, and tells anyone else it is not theirs to send', async () => {
      hub.store.insertDraft({ id: 'ab12cd34', thread_id: THREAD, peer: 'cu', question: 'ok?', text: 'x' });
      const tap = (from: { id: number }, data = 'c:ab12cd34') => ({ callback_query: { id: `cb${from.id}`, from, message: { message_id: 91, chat: { id: CHAT } }, data } });
      deliver(tap(ANH), tap({ id: 99 }));
      await hub.inbox.pollOnce(0);
      expect(hub.confirms).toEqual([['ab12cd34', 'Trần Anh']]);
      expect(calls('answerCallbackQuery')).toEqual([
        { callback_query_id: 'cb42', text: 'Sent' },
        { callback_query_id: 'cb99', text: 'Only the owner of this answer can send it.', show_alert: true },
      ]);
    });

    it('finds a plain-text post by the thread id in its text', async () => {
      deliver(say(ANH, { reply_to_message: { message_id: 92, from: BOT, chat: { id: CHAT }, text: '💬 anh → cu  cu-35c42200\n\nanswer' } }));
      await hub.inbox.pollOnce(0);
      expect(hub.replies.map((r) => r.threadId)).toEqual([THREAD]);
    });

    it('ignores strangers, other chats, non-replies, replies to people, unknown threads and non-text', async () => {
      deliver(
        say({ id: 99, is_bot: false, first_name: 'X' }, { reply_to_message: bridgePost(90) }),
        say(ANH, { chat: { id: -2002, type: 'group' }, reply_to_message: bridgePost(90) }),
        say(ANH, {}),
        say(ANH, { reply_to_message: { ...bridgePost(90), from: { id: 99, is_bot: false } } }),
        say(ANH, { reply_to_message: bridgePost(90, 'cu-ffffffff') }),
        say(ANH, { text: undefined, photo: [{}], reply_to_message: bridgePost(90) }),
      );
      await hub.inbox.pollOnce(0);
      expect(hub.replies).toEqual([]);
      expect(calls('setMessageReaction')).toEqual([]);
    });
  });

  describe('one shared bot: the hub reads it for everyone', () => {
    it("registers whoever opens a machine's one-time link as that machine's owner", async () => {
      tg.respond({ id: 5, username: 'test_bot' });
      const res = await post(hub.localApp, '/local/telegram/claim', {});
      const { code, bot } = (await res.json()) as { code: string; bot: string };
      expect(bot).toBe('test_bot');
      deliver(
        { message: { message_id: 1, from: { id: 43, first_name: 'Lan' }, chat: { id: 43, type: 'private' }, text: '/start wrong' } },
        { message: { message_id: 2, from: { id: 44, first_name: 'Minh' }, chat: { id: 44, type: 'private' }, text: `/start ${code}` } },
      );
      await hub.inbox.pollOnce(0);
      expect(hub.store.telegramOwners('anh').map((o) => o.name)).toEqual(['Trần Anh', 'Minh']);
      expect(hub.store.telegramOwner(43)).toBeUndefined();
      expect(calls('sendMessage').map((m) => [m.chat_id, String(m.text).slice(0, 2)])).toEqual([
        [43, '⚠️'],
        [44, '✓ '],
      ]);
      const listed = (await (await hub.localApp.request('/local/telegram/owners')).json()) as { owners: unknown[] };
      expect(listed.owners).toHaveLength(2);
    });

    it('lets a connected machine join: it gets the bot and a link, and its owner is registered for it and reported back to it', async () => {
      tg.respond({ id: 5, username: 'test_bot' });
      const res = await post(member.localApp, '/local/telegram/claim', { hub: 'anh' });
      expect(res.status).toBe(200);
      const joined = (await res.json()) as Record<string, string | number>;
      expect(joined).toMatchObject({ botToken: TOKEN, chatId: CHAT, chatTitle: 'TAP BOD', bot: 'test_bot' });
      deliver({ message: { message_id: 3, from: CU, chat: { id: CU.id, type: 'private' }, text: `/start ${joined.code}` } });
      await hub.inbox.pollOnce(0);
      expect(hub.store.telegramOwner(CU.id)).toEqual({ id: CU.id, name: 'Cừ', machine: 'cu' });
      expect(member.store.telegramOwners('cu')).toEqual([{ id: CU.id, name: 'Cừ', machine: 'cu' }]);
    });

    it("forwards another machine's owner's replies to that machine, which acts on them even if it never heard of that owner", async () => {
      hub.store.setTelegramOwner({ id: CU.id, name: 'Cừ', machine: 'cu' });
      deliver(say(CU, { reply_to_message: bridgePost(90) }), say(CU, { text: 'chatting, not a reply' }), say(CU, { chat: { id: -2002, type: 'group' }, reply_to_message: bridgePost(90) }));
      await hub.inbox.pollOnce(0);
      await member.inbox.idle();
      expect(peerCalls).toEqual(['cu.test /telegram/update']);
      expect(hub.replies).toEqual([]);
      expect(member.replies).toEqual([{ threadId: THREAD, text: 'Đúng rồi', owner: 'Cừ', seenInChat: true }]);
      expect(member.store.telegramOwners('cu')).toEqual([{ id: CU.id, name: 'Cừ', machine: 'cu' }]);
    });

    it("forwards another machine's owner tapping ✅ Send to that machine", async () => {
      hub.store.setTelegramOwner({ id: CU.id, name: 'Cừ', machine: 'cu' });
      member.store.insertDraft({ id: 'feed0001', thread_id: THREAD, peer: 'anh', question: 'ok?', text: 'x' });
      deliver({ callback_query: { id: 'cb7', from: CU, message: { message_id: 95, chat: { id: CHAT } }, data: 'c:feed0001' } });
      await hub.inbox.pollOnce(0);
      await member.inbox.idle();
      expect(peerCalls).toEqual(['cu.test /telegram/update']);
      expect(member.confirms).toEqual([['feed0001', 'Cừ']]);
      expect(calls('answerCallbackQuery')).toEqual([{ callback_query_id: 'cb7', text: 'Sent' }]);
    });

    it('a member learns its owners from the hub when asked, even if the hub could not tell it at the time', async () => {
      hub.store.setTelegramOwner({ id: CU.id, name: 'Cừ', machine: 'cu' });
      const res = (await (await member.localApp.request('/local/telegram/owners')).json()) as { owners: unknown[] };
      expect(res.owners).toEqual([{ id: CU.id, name: 'Cừ', machine: 'cu' }]);
    });

    it('a link stays valid across a restart of the hub', async () => {
      tg.respond({ id: 5, username: 'test_bot' });
      const { code } = (await (await post(hub.localApp, '/local/telegram/claim', {})).json()) as { code: string };
      const restarted = createTelegramInbox({
        store: hub.store,
        selfName: 'anh',
        settings: () => hub.settings,
        actions: {
          ownerReply: async () => ({ id: 'x', thread_id: THREAD, to: 'cu', status: 'sent' }),
          answerOwnerQuestion: async () => 'answered',
          confirmOwnerDraft: async () => 'sent',
        },
        authenticate: () => undefined,
        fetchImpl,
        log: () => {},
      });
      deliver({ message: { message_id: 4, from: { id: 45, first_name: 'Lan' }, chat: { id: 45, type: 'private' }, text: `/start ${code}` } });
      await restarted.pollOnce(0);
      expect(hub.store.telegramOwner(45)?.machine).toBe('anh');
    });

    it('tells the owner when their machine cannot be reached', async () => {
      hub.store.setTelegramOwner({ id: 9, name: 'Zed', machine: 'zed' });
      deliver(say({ id: 9, is_bot: false, first_name: 'Zed' }, { reply_to_message: bridgePost(90) }));
      await hub.inbox.pollOnce(0);
      expect(String(calls('sendMessage').at(-1)?.text)).toMatch(/zed/);
    });

    it('only the hub may push updates or owners to a member, and only a connected machine may join', async () => {
      const update = { update_id: 1, message: say(CU, { reply_to_message: bridgePost(90) }).message };
      expect((await post(member.peerApp, '/telegram/update', { update })).status).toBe(401);
      member.store.upsertPeer({ name: 'zed', url: 'http://zed.test', token: 'tok-cu-zed', folders: [], remoteFolders: [] });
      expect((await post(member.peerApp, '/telegram/update', { update }, 'tok-cu-zed')).status).toBe(403);
      expect((await post(member.peerApp, '/telegram/owners', { owners: [{ id: 1, name: 'evil' }] }, 'tok-cu-zed')).status).toBe(403);
      expect(member.store.telegramOwners()).toEqual([]);
      expect((await post(hub.peerApp, '/telegram/join', {})).status).toBe(401);
      expect((await post(member.peerApp, '/telegram/join', {}, 'tok-cu-zed')).status).toBe(404);
      expect(member.replies).toEqual([]);
    });
  });

  describe('one chat per colleague', () => {
    const SILVER_THREAD = 'silver-11111111-8133-42d7-a7a9-6e7204d05aa0';
    const SILVER_CHAT = -2002;
    const silverPost = (messageId: number, chat: number) => {
      const code = 'silver-11111111';
      const text = `❓ silver → anh  ${code}\n\nquestion`;
      return { message_id: messageId, from: BOT, chat: { id: chat }, text, entities: [{ type: 'code', offset: text.indexOf(code), length: code.length }] };
    };
    const inChat = (chat: number, over: Record<string, unknown>) => say(ANH, { chat: { id: chat, type: 'group' }, ...over });

    beforeEach(() => {
      hub.settings = { botToken: TOKEN, chatId: CHAT, chatTitle: 'TAP BOD', peerChats: { silver: { chatId: SILVER_CHAT, chatTitle: 'Silver' } } };
      hub.store.upsertPeer({ name: 'silver', url: 'http://silver.test', token: 'tok-anh-silver', folders: ['/w'], remoteFolders: [] });
      hub.store.upsertThread({ thread_id: THREAD, origin: 'remote', peer: 'cu' });
      hub.store.upsertThread({ thread_id: SILVER_THREAD, origin: 'remote', peer: 'silver' });
      hub.store.insertMessage({ id: 's', thread_id: SILVER_THREAD, from: 'silver', kind: 'ask', text: 'q', sent_at: 'now' }, 'in');
    });

    it("lets a reply in a peer's own chat act on that peer's thread only", async () => {
      deliver(inChat(SILVER_CHAT, { reply_to_message: silverPost(90, SILVER_CHAT) }));
      await hub.inbox.pollOnce(0);
      expect(hub.replies.map((r) => r.threadId)).toEqual([SILVER_THREAD]);
    });

    it("does not let a reply in one peer's chat act on another peer's thread", async () => {
      deliver(
        inChat(SILVER_CHAT, { reply_to_message: { ...bridgePost(91), chat: { id: SILVER_CHAT } } }),
        inChat(CHAT, { reply_to_message: silverPost(92, CHAT) }),
        inChat(-3003, { reply_to_message: silverPost(93, -3003) }),
      );
      await hub.inbox.pollOnce(0);
      expect(hub.replies).toEqual([]);
      expect(calls('setMessageReaction')).toEqual([]);
    });

    it("ignores a reply to a question about a peer when it is made in a different configured chat", async () => {
      hub.store.insertDraft({ id: 'dd', thread_id: SILVER_THREAD, peer: 'silver', question: 'q?', text: 'a' });
      hub.store.addDraftPost('dd', CHAT, 70, 'full');
      hub.store.addDraftPost('dd', SILVER_CHAT, 71, 'full');
      deliver(
        inChat(CHAT, { reply_to_message: { message_id: 70, from: BOT, chat: { id: CHAT }, text: 'x' } }),
        inChat(SILVER_CHAT, { reply_to_message: { message_id: 71, from: BOT, chat: { id: SILVER_CHAT }, text: 'x' } }),
      );
      await hub.inbox.pollOnce(0);
      expect(hub.answers.map((a) => a[0])).toEqual(['dd']);
      expect(hub.answers).toHaveLength(1);
      expect(calls('setMessageReaction')).toEqual([{ chat_id: SILVER_CHAT, message_id: messageId, reaction: [{ type: 'emoji', emoji: '👍' }] }]);
    });

    it("only honours ✅ Send tapped in the chat routed for the draft's peer", async () => {
      hub.store.insertDraft({ id: 'dd', thread_id: SILVER_THREAD, peer: 'silver', question: 'q?', text: 'a' });
      const tapIn = (chat: number) => ({ callback_query: { id: `cb${chat}`, from: ANH, data: 'c:dd', message: { message_id: 1, chat: { id: chat }, from: BOT } } });
      deliver(tapIn(CHAT));
      await hub.inbox.pollOnce(0);
      expect(hub.confirms).toEqual([]);
      expect(calls('answerCallbackQuery')[0]).toMatchObject({ show_alert: true });
      deliver(tapIn(SILVER_CHAT));
      await hub.inbox.pollOnce(0);
      expect(hub.confirms).toEqual([['dd', 'Trần Anh']]);
    });

    it('hands a joining machine the chat routed for it, and the default chat to one without a route', async () => {
      tg.respond({ id: 5, username: 'test_bot' });
      const silver = await post(hub.peerApp, '/telegram/join', {}, 'tok-anh-silver');
      expect(await silver.json()).toMatchObject({ botToken: TOKEN, chatId: SILVER_CHAT, chatTitle: 'Silver' });
      const cu = await post(hub.peerApp, '/telegram/join', {}, 'tok-anh-cu');
      const body = (await cu.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ chatId: CHAT, chatTitle: 'TAP BOD' });
      expect(JSON.stringify(body)).not.toContain(String(SILVER_CHAT));
    });
  });

  describe('polling', () => {
    it('when first switched on, skips whatever was already waiting — old replies must not act now', async () => {
      const store = new BridgeStore(join(dir, 'fresh.db'));
      const inbox = createTelegramInbox({
        store,
        selfName: 'anh',
        settings: () => ({ botToken: TOKEN, chatId: CHAT }),
        actions: {
          ownerReply: async () => ({ id: 'x', thread_id: THREAD, to: 'cu', status: 'sent' }),
          answerOwnerQuestion: async () => 'answered',
          confirmOwnerDraft: async () => 'sent',
        },
        authenticate: () => undefined,
        fetchImpl,
        log: () => {},
      });
      tg.respond([{ update_id: 70 }]);
      deliver();
      await inbox.pollOnce(0);
      store.close();
      expect(calls('getUpdates').slice(0, 2)).toMatchObject([
        { offset: -1, timeout: 0 },
        { offset: 71, timeout: 0, allowed_updates: ['message', 'callback_query'] },
      ]);
    });

    it('resumes after the last update it took', async () => {
      deliver(say(ANH, { reply_to_message: bridgePost(90) }));
      await hub.inbox.pollOnce(0);
      await hub.inbox.pollOnce(25);
      expect(calls('getUpdates')[1]).toMatchObject({ offset: updateId + 1, timeout: 25 });
    });

    it('backs off on failures, and warns the chat once when another program keeps reading the same bot', async () => {
      tg.fail(502, 'Bad Gateway');
      expect(await hub.inbox.pollOnce(0)).toBe(5_000);
      for (let i = 0; i < 5; i++) {
        tg.fail(409, 'Conflict: terminated by other getUpdates request');
        expect(await hub.inbox.pollOnce(0)).toBe(30_000);
      }
      const warnings = calls('sendMessage');
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0].text)).toMatch(/only one machine/i);
    });
  });
});
