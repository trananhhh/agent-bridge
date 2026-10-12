import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from './store.ts';
import { createTelegramInbox } from './telegram-inbox.ts';
import { fakeTelegram } from './test-support/fake-telegram.ts';
import type { DraftOutcome, OwnerActions, OwnerReplyInput } from './daemon.ts';

const THREAD = 'cu-35c42200-8133-42d7-a7a9-6e7204d05aa0';
const CHAT = -1001;
const OWNER = { id: 42, name: 'Anh' };
const BOT = { id: 7, is_bot: true, first_name: 'bridge' };

const bridgePost = (messageId: number, code = 'cu-35c42200') => {
  const text = `❓ cu → anh  ${code}\n\nquestion`;
  return { message_id: messageId, from: BOT, chat: { id: CHAT }, text, entities: [{ type: 'code', offset: text.indexOf(code), length: code.length }] };
};

describe('telegram inbox', () => {
  let dir: string;
  let store: BridgeStore;
  let tg: ReturnType<typeof fakeTelegram>;
  let logs: string[];
  let replies: OwnerReplyInput[];
  let decisions: [string, string, string][];
  let outcome: DraftOutcome;
  let actionsRun: number;
  let updateId = 0;

  let actions: OwnerActions;
  const makeActions = (): OwnerActions => ({
    ownerReply: async (input) => {
      replies.push(input);
      return { id: 'm', thread_id: input.threadId, to: 'cu', status: 'sent' };
    },
    resolveDraft: async (id, action, owner) => {
      decisions.push([id, action, owner]);
      return outcome;
    },
  });
  const inbox = () =>
    createTelegramInbox({
      store,
      target: { botToken: '123:secret', chatId: CHAT },
      owners: [OWNER],
      actions,
      fetchImpl: tg.fetchImpl,
      log: (event) => logs.push(event),
      afterAction: () => actionsRun++,
    });
  const deliver = (...updates: Record<string, unknown>[]) => tg.respond(updates.map((u) => ({ update_id: ++updateId, ...u })));
  const ownerMessage = (over: Record<string, unknown>) => ({
    message: { message_id: 500 + updateId, from: { id: OWNER.id, is_bot: false, first_name: 'Anh' }, chat: { id: CHAT }, text: 'Đúng rồi', ...over },
  });
  const calls = (method: string) => tg.sent.filter((s) => s.method === method).map((s) => s.body);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-inbox-'));
    store = new BridgeStore(join(dir, 'bridge.db'));
    store.insertMessage({ id: 'q', thread_id: THREAD, from: 'cu', kind: 'ask', text: 'q', sent_at: 'now' }, 'in');
    store.setKv('telegram_update_offset', '0');
    tg = fakeTelegram();
    logs = [];
    replies = [];
    decisions = [];
    outcome = 'sent';
    actionsRun = 0;
    actions = makeActions();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends the owner's reply to a bridge post — by either side's bot — into that post's thread, and marks it 👍", async () => {
    deliver(ownerMessage({ reply_to_message: bridgePost(90) }));
    expect(await inbox().pollOnce(0)).toBe(0);
    expect(replies).toEqual([{ threadId: THREAD, text: 'Đúng rồi', owner: 'Anh', seenInChat: true }]);
    expect(calls('setMessageReaction')).toEqual([{ chat_id: CHAT, message_id: 500, reaction: [{ type: 'emoji', emoji: '👍' }] }]);
    expect(actionsRun).toBe(1);
  });

  it('takes a reply to a held answer in the private chat for that answer, and finds a plain-text post by the id in its text', async () => {
    store.insertDraft({ id: 'd1', thread_id: THREAD, peer: 'cu', question: 'ok?', text: 'x' });
    store.setDraftPosted('d1', 91);
    const dm = { id: OWNER.id, type: 'private' };
    deliver(
      ownerMessage({ chat: dm, reply_to_message: { message_id: 91, from: BOT, chat: dm, text: 'whatever' } }),
      ownerMessage({ reply_to_message: { message_id: 92, from: BOT, chat: { id: CHAT }, text: '💬 anh → cu  cu-35c42200\n\nanswer' } }),
    );
    await inbox().pollOnce(0);
    expect(replies.map((r) => [r.threadId, r.seenInChat])).toEqual([
      [THREAD, false],
      [THREAD, true],
    ]);
  });

  it("never mistakes a shared-chat message for a private held answer that happens to have the same id", async () => {
    store.insertDraft({ id: 'd1', thread_id: THREAD, peer: 'cu', question: 'ok?', text: 'x' });
    store.setDraftPosted('d1', 91);
    deliver(
      ownerMessage({ reply_to_message: { message_id: 91, from: { id: 99, is_bot: false }, chat: { id: CHAT }, text: 'hi' } }),
      ownerMessage({ reply_to_message: { message_id: 91, from: BOT, chat: { id: CHAT }, text: 'agent-bridge: anh posts here' } }),
    );
    await inbox().pollOnce(0);
    expect(replies).toEqual([]);
  });

  it('ignores other people, other chats, non-replies, replies to people, unknown threads and non-text', async () => {
    deliver(
      ownerMessage({ from: { id: 99, is_bot: false, first_name: 'Cừ' }, reply_to_message: bridgePost(90) }),
      ownerMessage({ chat: { id: -2002 }, reply_to_message: bridgePost(90) }),
      ownerMessage({}),
      ownerMessage({ reply_to_message: { ...bridgePost(90), from: { id: 99, is_bot: false } } }),
      ownerMessage({ reply_to_message: bridgePost(90, 'cu-ffffffff') }),
      ownerMessage({ text: undefined, photo: [{}], reply_to_message: bridgePost(90) }),
    );
    await inbox().pollOnce(0);
    expect(replies).toEqual([]);
    expect(calls('setMessageReaction')).toEqual([]);
  });

  it('acts on draft buttons pressed by an owner and tells them what happened', async () => {
    deliver({ callback_query: { id: 'cb1', from: { id: OWNER.id }, message: { message_id: 91, chat: { id: OWNER.id } }, data: 'd:ab12cd34:send' } });
    await inbox().pollOnce(0);
    expect(decisions).toEqual([['ab12cd34', 'send', 'Anh']]);
    expect(calls('answerCallbackQuery')).toEqual([{ callback_query_id: 'cb1', text: 'Sent' }]);
    expect(actionsRun).toBe(1);

    outcome = 'already handled';
    deliver({ callback_query: { id: 'cb2', from: { id: OWNER.id }, message: { message_id: 91, chat: { id: CHAT } }, data: 'd:ab12cd34:drop' } });
    await inbox().pollOnce(0);
    expect(calls('answerCallbackQuery')[1]).toEqual({ callback_query_id: 'cb2', text: 'Already handled' });
  });

  it('says so when the answer could not be sent', async () => {
    actions.resolveDraft = async () => {
      throw new Error('not connected to cu any more');
    };
    deliver({ callback_query: { id: 'cb1', from: { id: OWNER.id }, message: { message_id: 91, chat: { id: OWNER.id } }, data: 'd:ab12cd34:send' } });
    await inbox().pollOnce(0);
    expect(calls('answerCallbackQuery')).toEqual([{ callback_query_id: 'cb1', text: 'Not sent: not connected to cu any more', show_alert: true }]);
  });

  it('refuses buttons pressed by anyone else', async () => {
    deliver({ callback_query: { id: 'cb1', from: { id: 99 }, message: { message_id: 91, chat: { id: CHAT } }, data: 'd:ab12cd34:send' } });
    await inbox().pollOnce(0);
    expect(decisions).toEqual([]);
    expect(calls('answerCallbackQuery')).toEqual([{ callback_query_id: 'cb1', text: 'Only Anh can decide this.', show_alert: true }]);
  });

  it('when first switched on, skips whatever was already waiting — old replies must not act now', async () => {
    store.close();
    store = new BridgeStore(join(dir, 'fresh.db'));
    store.insertMessage({ id: 'q', thread_id: THREAD, from: 'cu', kind: 'ask', text: 'q', sent_at: 'now' }, 'in');
    tg.respond([{ update_id: 70, ...ownerMessage({ reply_to_message: bridgePost(90) }) }]);
    deliver(ownerMessage({ reply_to_message: bridgePost(90) }));
    await inbox().pollOnce(0);
    const polls = calls('getUpdates');
    expect(polls[0]).toMatchObject({ offset: -1, timeout: 0 });
    expect(polls[1]).toMatchObject({ offset: 71, timeout: 0, allowed_updates: ['message', 'callback_query'] });
    expect(replies).toHaveLength(1);
  });

  it('resumes after the last update it took, even across restarts', async () => {
    deliver(ownerMessage({ reply_to_message: bridgePost(90) }));
    await inbox().pollOnce(0);
    await inbox().pollOnce(25);
    const polls = calls('getUpdates');
    expect(polls[0]).toMatchObject({ offset: 0, timeout: 0, allowed_updates: ['message', 'callback_query'] });
    expect(polls[1]).toMatchObject({ offset: updateId + 1, timeout: 25 });
  });

  it('backs off when another program polls the same bot, and on other failures', async () => {
    tg.fail(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running');
    expect(await inbox().pollOnce(0)).toBe(30_000);
    expect(logs).toEqual(['telegram_poll_conflict']);
    tg.fail(502, 'Bad Gateway');
    expect(await inbox().pollOnce(0)).toBe(5_000);
  });

  it('warns the chat once when another machine keeps reading the same bot', async () => {
    const ib = inbox();
    for (let i = 0; i < 5; i++) {
      tg.fail(409, 'Conflict: terminated by other getUpdates request');
      await ib.pollOnce(0);
    }
    const warnings = calls('sendMessage');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ chat_id: CHAT });
    expect(String(warnings[0].text)).toMatch(/own bot/);
  });
});
