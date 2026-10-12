import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from './store.ts';
import { channelsFromUpdates, createTelegramMirror, findStart, nextOffset } from './telegram.ts';
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
  const mirror = () =>
    createTelegramMirror({
      store,
      selfName: 'anh',
      target: { botToken: '123:secret', chatId: -1001 },
      owners: 'Anh',
      reviewChat: 42,
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

  it('sends a held answer privately to the owner, with Send / Don\'t send buttons; the shared chat only learns that one is waiting', async () => {
    const m = mirror();
    store.insertDraft({ id: 'ab12cd34', thread_id: THREAD, peer: 'cu', question: 'Chốt 2.400.388 chưa?', text: 'Số chốt: **2.400.388**' });
    await m.tick();
    const [draft, notice] = tg.sent.map((x) => x.body);
    expect(notice).toMatchObject({ chat_id: -1001, text: '🙋 <b>anh → cu</b>: an answer is waiting for Anh to check  <code>cu-35c42200</code>' });
    expect(JSON.stringify(notice)).not.toContain('2.400.388');
    expect(draft).toMatchObject({
      chat_id: 42,
      text: '<b>🙋 For Anh to check</b> · anh → cu  <code>cu-35c42200</code>\n<i>Chốt 2.400.388 chưa?</i>\n\nSố chốt: <b>2.400.388</b>\n\n<i>Reply to this message to answer in your own words.</i>',
      reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: 'd:ab12cd34:send' }, { text: "🚫 Don't send", callback_data: 'd:ab12cd34:drop' }]] },
    });
    expect(store.draftByPost(101)?.id).toBe('ab12cd34');

    await m.tick();
    expect(tg.sent).toHaveLength(2);
    store.resolveDraft('ab12cd34', 'sent', 'Anh');
    await m.tick();
    expect(tg.sent[2]).toEqual({
      method: 'editMessageReplyMarkup',
      body: { chat_id: 42, message_id: 101, reply_markup: { inline_keyboard: [[{ text: '✅ Sent by Anh', callback_data: 'noop' }]] } },
    });
    await m.tick();
    expect(tg.sent).toHaveLength(3);
  });

  it('offers only to drop a held answer that has no draft, and says when the owner had answered first', async () => {
    const m = mirror();
    store.insertDraft({ id: 'aa', thread_id: THREAD, peer: 'cu', question: 'Chỉ anh biết: thoả thuận 150tr?', text: '' });
    store.insertDraft({ id: 'bb', thread_id: THREAD, peer: 'cu', text: 'late answer' });
    await m.tick();
    const privately = tg.sent.filter((x) => x.body.chat_id === 42).map((x) => x.body);
    expect(privately[0].reply_markup).toEqual({ inline_keyboard: [[{ text: "🚫 Don't send", callback_data: 'd:aa:drop' }]] });
    expect(privately[1].text).toContain('<i>You answered first; the agent had also written this.</i>');
  });

  it('still offers the buttons when Telegram refuses to show a held answer', async () => {
    const m = mirror();
    store.insertDraft({ id: 'cc', thread_id: THREAD, peer: 'cu', question: 'q', text: 'x' });
    tg.fail(400, 'Bad Request: message is too long');
    await m.tick();
    const last = tg.sent.filter((x) => x.body.chat_id === 42).at(-1)!.body;
    expect(last).toMatchObject({ chat_id: 42, reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: 'd:cc:send' }, { text: "🚫 Don't send", callback_data: 'd:cc:drop' }]] } });
    expect(last.text).toContain('agent-bridge log cu-35c42200');
    expect(store.draftByPost(101)?.id).toBe('cc');
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

describe('findStart', () => {
  it('finds who opened the setup link in a private chat with the bot — only with the exact code', () => {
    const dm = (id: number) => ({ id, type: 'private' });
    const updates = [
      { message: { chat: dm(41), from: { id: 41, first_name: 'Cừ' }, text: '/start' } },
      { message: { chat: dm(43), from: { id: 43, first_name: 'Lan' }, text: '/start wrongcode' } },
      { message: { chat: { id: -4001, type: 'group' }, from: { id: 44, first_name: 'X' }, text: '/start a1b2c3d4' } },
      { message: { chat: dm(42), from: { id: 42, first_name: 'Trần', last_name: 'Anh' }, text: '/start a1b2c3d4' } },
    ];
    expect(findStart(updates, 'a1b2c3d4')).toEqual({ id: 42, name: 'Trần Anh' });
    expect(findStart(updates.slice(0, 3), 'a1b2c3d4')).toBeUndefined();
  });
});

describe('nextOffset', () => {
  it('moves past the newest update seen, never backwards', () => {
    expect(nextOffset([{ update_id: 5 }, { update_id: 9 }])).toBe(10);
    expect(nextOffset([], 3)).toBe(3);
    expect(nextOffset([{ update_id: 1 }], 3)).toBe(3);
  });
});
