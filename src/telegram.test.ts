import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from './store.ts';
import { channelsFromUpdates, chatForPeer, createTelegramMirror, nextOffset, type TelegramTarget } from './telegram.ts';
import type { PeerMessage } from './protocol.ts';
import { fakeTelegram } from './test-support/fake-telegram.ts';

const THREAD = 'cu-35c42200-8133-42d7-a7a9-6e7204d05aa0';

describe('telegram mirror', () => {
  let dir: string;
  let store: BridgeStore;
  let tg: ReturnType<typeof fakeTelegram>;
  let logs: string[];
  let clock: number;
  let n = 0;

  const add = (over: Partial<PeerMessage>, direction: 'in' | 'out') =>
    store.insertMessage(
      { id: `m${++n}`, thread_id: THREAD, from: 'cu', kind: 'ask', text: 'q', sent_at: new Date().toISOString(), ...over },
      direction,
    );
  const mirror = (target: TelegramTarget = { botToken: '123:secret', chatId: -1001 }) =>
    createTelegramMirror({
      store,
      selfName: 'anh',
      target,
      owners: () => [{ id: 42, name: 'Anh' }],
      fetchImpl: tg.fetchImpl,
      log: (event) => logs.push(event),
      now: () => clock,
    });
  const posts = () => tg.sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text as string);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-tg-'));
    store = new BridgeStore(join(dir, 'bridge.db'));
    store.upsertThread({ thread_id: THREAD, origin: 'remote', peer: 'cu' });
    tg = fakeTelegram();
    logs = [];
    clock = 0;
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at the end of the log (no history replay), then posts each new message as "sender → recipient" in order', async () => {
    add({ text: 'old history' }, 'in');
    const m = mirror();
    await m.tick();
    expect(posts()).toEqual([]);

    add({ text: 'Có đồng ý cách C <không>?' }, 'in');
    add({ from: 'anh', kind: 'reply', text: 'Đồng ý & đã chốt' }, 'out');
    await m.tick();
    expect(posts()).toEqual([
      '<b>❓ cu → anh</b>  <code>cu-35c42200</code>\n\nCó đồng ý cách C &lt;không&gt;?',
      '<b>💬 anh → cu</b>  <code>cu-35c42200</code>\n\nĐồng ý &amp; đã chốt',
    ]);
    expect(tg.sent[1].body).toMatchObject({ chat_id: -1001, parse_mode: 'HTML' });

    await mirror().tick();
    expect(posts()).toHaveLength(2);
  });

  it('leaves an incoming message to its sender when the sender already posts it to this channel', async () => {
    const m = mirror();
    add({ text: 'sender posts this one', mirror: '-1001' }, 'in');
    add({ text: 'sender mirrors elsewhere', mirror: '-2002' }, 'in');
    add({ text: 'sender has no mirror' }, 'in');
    add({ from: 'anh', kind: 'reply', text: 'mine', mirror: '-1001' }, 'out');
    await m.tick();
    expect(posts().map((p) => p.split('\n\n')[1])).toEqual(['sender mirrors elsewhere', 'sender has no mirror', 'mine']);
  });

  describe('one chat per colleague', () => {
    const SILVER = 'silver-11111111-8133-42d7-a7a9-6e7204d05aa0';
    const routed: TelegramTarget = { botToken: '123:secret', chatId: -1001, peerChats: { silver: { chatId: -2002, chatTitle: 'Silver' } } };
    const toChat = () => tg.sent.filter((s) => s.method === 'sendMessage').map((s) => [s.body.chat_id, String(s.body.text).split('\n\n')[1]]);

    beforeEach(() => store.upsertThread({ thread_id: SILVER, origin: 'remote', peer: 'silver' }));

    it('resolves a peer to its own chat, and anyone else to the default', () => {
      expect(chatForPeer(routed, 'silver')).toBe(-2002);
      expect(chatForPeer(routed, 'cu')).toBe(-1001);
      expect(chatForPeer(routed, undefined)).toBe(-1001);
      expect(chatForPeer({ botToken: 'x', chatId: 5 }, 'silver')).toBe(5);
    });

    it("posts each message to the chat routed for its thread's peer", async () => {
      const m = mirror(routed);
      add({ thread_id: SILVER, from: 'silver', text: 'from silver' }, 'in');
      add({ text: 'from cu' }, 'in');
      add({ thread_id: SILVER, from: 'anh', kind: 'reply', text: 'to silver' }, 'out');
      await m.tick();
      expect(toChat()).toEqual([
        [-2002, 'from silver'],
        [-1001, 'from cu'],
        [-2002, 'to silver'],
      ]);
    });

    it("leaves an incoming message to its sender only when the sender mirrors to the chat routed for that thread's peer", async () => {
      const m = mirror(routed);
      add({ thread_id: SILVER, from: 'silver', text: 'sender posts in silver chat', mirror: '-2002' }, 'in');
      add({ thread_id: SILVER, from: 'silver', text: 'sender posts in the default chat', mirror: '-1001' }, 'in');
      add({ from: 'cu', text: 'cu posts in the default chat', mirror: '-1001' }, 'in');
      add({ from: 'cu', text: 'cu posts elsewhere', mirror: '-2002' }, 'in');
      await m.tick();
      expect(toChat()).toEqual([
        [-2002, 'sender posts in the default chat'],
        [-1001, 'cu posts elsewhere'],
      ]);
    });

    it("sends non-private questions to the peer's chat and private ones to the owners, with the notice in the peer's chat", async () => {
      const m = mirror(routed);
      store.insertDraft({ id: 'dd', thread_id: SILVER, peer: 'silver', question: 'Gửi chưa?', text: 'ok' });
      store.insertDraft({ id: 'pp', thread_id: SILVER, peer: 'silver', question: 'Riêng?', text: 'bí mật', private: true });
      store.insertDraft({ id: 'cc', thread_id: THREAD, peer: 'cu', question: 'Cho cu?', text: 'ok' });
      await m.tick();
      const sent = tg.sent.map((s) => [String(s.body.chat_id), String(s.body.text).includes('waiting for') ? 'notice' : String(s.body.text).includes('bí mật') ? 'private' : 'question']);
      expect(sent).toEqual([
        ['-2002', 'question'],
        ['42', 'private'],
        ['-2002', 'notice'],
        ['-1001', 'question'],
      ]);
      expect(store.draftByPost(-2002, 101)?.id).toBe('dd');
    });

    it("refreshes an answered question in the chat it was posted to", async () => {
      const m = mirror(routed);
      store.insertDraft({ id: 'dd', thread_id: SILVER, peer: 'silver', question: 'Gửi chưa?', text: 'ok' });
      await m.tick();
      store.resolveDraft('dd', 'answering', 'Anh', 'ok');
      store.finishDraft('dd');
      await m.tick();
      expect(tg.sent.map((s) => [s.method, String(s.body.chat_id)])).toEqual([
        ['sendMessage', '-2002'],
        ['editMessageText', '-2002'],
      ]);
    });
  });

  it('splits long messages into numbered parts', async () => {
    const m = mirror();
    add({ text: `${'a'.repeat(3000)}\n${'b'.repeat(3000)}` }, 'in');
    await m.tick();
    const out = posts();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^<b>❓ cu → anh<\/b>.*\n\na{3000}$/s);
    expect(out[1]).toBe(`<i>(2/2)</i>  <code>cu-35c42200</code>\n\n${'b'.repeat(3000)}`);
  });

  it("renders the agents' Markdown", async () => {
    const m = mirror();
    add({ from: 'anh', kind: 'reply', text: '## Chốt\n- **Lãi T9**: 8.519.298' }, 'out');
    await m.tick();
    expect(posts()[0].split('\n\n')[1]).toBe('<b>Chốt</b>\n• <b>Lãi T9</b>: 8.519.298');
  });

  it('does not repost what the owner typed in the shared chat, but posts what they wrote or approved privately', async () => {
    const m = mirror();
    store.insertMessage({ id: 'o1', thread_id: THREAD, from: 'anh', kind: 'reply', text: 'typed in the group', sent_at: 'now' }, 'out', 'owner-in-chat');
    store.insertMessage({ id: 'o2', thread_id: THREAD, from: 'anh', kind: 'reply', text: 'approved in private', sent_at: 'now' }, 'out', 'owner');
    await m.tick();
    expect(posts()).toEqual(['<b>👤 anh → cu</b>  <code>cu-35c42200</code>\n\napproved in private']);
  });

  it("posts the agent's draft and question in the chat with a Send button, and marks it once decided", async () => {
    const m = mirror();
    store.insertDraft({ id: 'ab12cd34', thread_id: THREAD, peer: 'cu', question: 'Gửi số **2.400.388** được chưa?', text: 'Số chốt: **2.400.388**', session_id: 'sess-1', cwd: '/w/tap' });
    await m.tick();
    const body =
      '🙋 <b>anh asks Anh</b>  <code>cu-35c42200</code>\nBefore answering cu:\nGửi số <b>2.400.388</b> được chưa?\n\n' +
      '<b>Draft answer:</b>\nSố chốt: <b>2.400.388</b>\n\n' +
      '<i>✅ Send sends it as written. Or reply to this message: your reply goes to the agent, which answers again.</i>\n' +
      '<i>Or continue in Claude:</i> <code>cd "/w/tap" &amp;&amp; claude --resume sess-1</code>';
    expect(tg.sent).toEqual([
      {
        method: 'sendMessage',
        body: {
          chat_id: -1001,
          text: body,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: 'c:ab12cd34' }]] },
        },
      },
    ]);
    expect(store.draftByPost(-1001, 101)?.id).toBe('ab12cd34');

    await m.tick();
    expect(tg.sent).toHaveLength(1);
    store.resolveDraft('ab12cd34', 'sent', 'Anh');
    await m.tick();
    expect(tg.sent[1]).toEqual({
      method: 'editMessageText',
      body: { chat_id: '-1001', message_id: 101, text: `${body}\n\n✅ Sent as written, confirmed by Anh`, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    });
    await m.tick();
    expect(tg.sent).toHaveLength(2);
  });

  it('a question with no draft has no Send button; its status follows the answer', async () => {
    const m = mirror();
    store.insertDraft({ id: 'aa', thread_id: THREAD, peer: 'cu', question: 'Khoản 150tr là gì?', text: '' });
    await m.tick();
    expect(tg.sent[0].body.reply_markup).toBeUndefined();
    expect(tg.sent[0].body.text).toContain('<i>Reply to this message to answer.</i>');
    store.resolveDraft('aa', 'answering', 'Anh', 'là tiền cọc');
    await m.tick();
    expect(String(tg.sent[1].body.text)).toMatch(/⏳ Anh answered — the reply is being written$/);
    store.finishDraft('aa');
    await m.tick();
    expect(String(tg.sent[2].body.text)).toMatch(/✅ Answered by Anh$/);
  });

  it('sends a private question to the owner alone; the chat only learns an answer is waiting, never what', async () => {
    const m = mirror();
    store.insertDraft({ id: 'pp', thread_id: THREAD, peer: 'cu', question: 'Khoản vay riêng 50tr?', text: 'Không có khoản vay.', private: true });
    await m.tick();
    const [toOwner, notice] = tg.sent.map((x) => x.body);
    expect(toOwner).toMatchObject({ chat_id: 42, reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: 'c:pp' }]] } });
    expect(String(toOwner.text)).toContain('Khoản vay riêng 50tr?');
    expect(notice).toMatchObject({ chat_id: -1001, text: '⏳ <b>anh → cu</b>: waiting for Anh to answer  <code>cu-35c42200</code>' });
    expect(JSON.stringify(notice)).not.toMatch(/50tr|vay/);
    expect(store.draftByPost(42, 101)?.id).toBe('pp');
    expect(store.draftByPost(-1001, 102)).toBeUndefined();

    store.resolveDraft('pp', 'answering', 'Anh', 'ok');
    store.finishDraft('pp');
    await m.tick();
    expect(tg.sent.slice(2).map((x) => [x.body.chat_id, String(x.body.text).split('\n').at(-1)])).toEqual([
      ['42', '✅ Answered by Anh'],
      ['-1001', '✅ Answered by Anh'],
    ]);
  });

  it('never posts a question replaced before it went out, and marks one replaced afterwards', async () => {
    const m = mirror();
    store.insertDraft({ id: 'aa', thread_id: THREAD, peer: 'cu', question: 'first?', text: '' });
    store.resolveDraft('aa', 'superseded', 'agent');
    store.insertDraft({ id: 'bb', thread_id: THREAD, peer: 'cu', question: 'second?', text: '' });
    await m.tick();
    expect(tg.sent.map((x) => String(x.body.text))).toEqual([expect.stringContaining('second?')]);
    store.resolveDraft('bb', 'superseded', 'agent');
    await m.tick();
    expect(String(tg.sent[1].body.text)).toMatch(/↪️ Replaced by a newer question$/);
  });

  it('puts the Send button under the last part of a long draft, and a reply to any part finds it', async () => {
    const m = mirror();
    store.insertDraft({ id: 'll', thread_id: THREAD, peer: 'cu', question: 'q', text: `${'a'.repeat(3000)}\n${'b'.repeat(3000)}` });
    await m.tick();
    expect(tg.sent).toHaveLength(2);
    expect(tg.sent[0].body.reply_markup).toBeUndefined();
    expect(tg.sent[1].body.reply_markup).toEqual({ inline_keyboard: [[{ text: '✅ Send', callback_data: 'c:ll' }]] });
    expect([store.draftByPost(-1001, 101)?.id, store.draftByPost(-1001, 102)?.id]).toEqual(['ll', 'll']);
  });

  it('keeps its place on a transient failure and resumes from the same message', async () => {
    const m = mirror();
    add({ text: 'one' }, 'in');
    add({ text: 'two' }, 'in');
    tg.fail(502, 'Bad Gateway');
    await m.tick();
    expect(logs).toEqual(['telegram_failed']);
    await m.tick();
    expect(posts().map((p) => p.split('\n\n')[1])).toEqual(['one', 'one', 'two']);
  });

  it('waits out a rate limit before posting again', async () => {
    const m = mirror();
    add({ text: 'one' }, 'in');
    tg.fail(429, 'Too Many Requests: retry after 30', 30);
    await m.tick();
    clock = 10_000;
    await m.tick();
    expect(posts()).toHaveLength(1);
    clock = 31_000;
    await m.tick();
    expect(posts()).toHaveLength(2);
  });

  it('falls back to plain text when Telegram rejects the formatting, skips what it still rejects, but stops on a wrong chat or a removed bot', async () => {
    const m = mirror();
    add({ text: 'bad **one**' }, 'in');
    add({ text: 'worse' }, 'in');
    add({ text: 'good' }, 'in');
    tg.fail(400, "Bad Request: can't parse entities");
    tg.respond({ message_id: 1 });
    tg.fail(400, "Bad Request: can't parse entities");
    tg.fail(400, 'Bad Request: message is too long');
    await m.tick();
    expect(logs).toEqual(['telegram_plain_fallback', 'telegram_plain_fallback', 'telegram_skipped']);
    expect(tg.sent[1].body).toMatchObject({ text: '❓ cu → anh  cu-35c42200\n\nbad **one**' });
    expect(tg.sent[1].body.parse_mode).toBeUndefined();
    expect(posts().map((p) => p.split('\n\n')[1])).toEqual(['bad <b>one</b>', 'bad **one**', 'worse', 'worse', 'good']);

    add({ text: 'next' }, 'in');
    tg.fail(400, 'Bad Request: chat not found');
    await m.tick();
    expect(logs.at(-1)).toBe('telegram_failed');
    await m.tick();
    expect(posts().map((p) => p.split('\n\n')[1]).slice(-2)).toEqual(['next', 'next']);
  });
});

describe('channelsFromUpdates', () => {
  it('also finds groups the bot joined or was mentioned in', () => {
    const group = { id: -4001, title: 'TAP BOD', type: 'supergroup' };
    expect(
      channelsFromUpdates([
        { my_chat_member: { chat: group, new_chat_member: { status: 'member' } } },
        { message: { chat: group } },
        { message: { chat: { id: 5, type: 'private' } } },
      ]),
    ).toEqual([{ id: -4001, title: 'TAP BOD', type: 'supergroup' }]);
  });

  it('finds channels the bot was made admin of, or that posted, once each', () => {
    const chat = { id: -1001, title: 'Bridge log', type: 'channel' };
    expect(
      channelsFromUpdates([
        { my_chat_member: { chat, new_chat_member: { status: 'administrator' } } },
        { channel_post: { chat } },
        { my_chat_member: { chat: { id: -1002, title: 'Left', type: 'channel' }, new_chat_member: { status: 'left' } } },
        { message: { chat: { id: 5, type: 'private' } } },
      ]),
    ).toEqual([{ id: -1001, title: 'Bridge log', type: 'channel' }]);
  });
});

describe('nextOffset', () => {
  it('moves past the newest update seen, never backwards', () => {
    expect(nextOffset([{ update_id: 5 }, { update_id: 9 }])).toBe(10);
    expect(nextOffset([], 3)).toBe(3);
    expect(nextOffset([{ update_id: 1 }], 3)).toBe(3);
  });
});
