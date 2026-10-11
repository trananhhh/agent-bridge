import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from './store.ts';
import { channelsFromUpdates, createTelegramMirror, splitText } from './telegram.ts';
import type { PeerMessage } from './protocol.ts';

const THREAD = 'cu-35c42200-8133-42d7-a7a9-6e7204d05aa0';

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

function fakeTelegram() {
  const sent: Sent[] = [];
  const queue: { status: number; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    const next = queue.shift() ?? { status: 200, body: { ok: true, result: {} } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  const fail = (status: number, description: string, retry_after?: number) =>
    queue.push({ status, body: { ok: false, description, parameters: retry_after ? { retry_after } : undefined } });
  return { sent, fetchImpl, fail };
}

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
    expect(out[1]).toBe(`<i>(2/2)</i>\n\n${'b'.repeat(3000)}`);
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

  it('skips a message Telegram rejects as malformed, but stops on a wrong chat or a removed bot', async () => {
    const m = mirror();
    add({ text: 'bad' }, 'in');
    add({ text: 'good' }, 'in');
    tg.fail(400, "Bad Request: can't parse entities");
    await m.tick();
    expect(logs).toEqual(['telegram_skipped']);
    expect(posts().map((p) => p.split('\n\n')[1])).toEqual(['bad', 'good']);

    add({ text: 'next' }, 'in');
    tg.fail(400, 'Bad Request: chat not found');
    await m.tick();
    expect(logs.at(-1)).toBe('telegram_failed');
    await m.tick();
    expect(posts().map((p) => p.split('\n\n')[1]).slice(-2)).toEqual(['next', 'next']);
  });
});

describe('splitText', () => {
  it('prefers line breaks and never exceeds the limit', () => {
    expect(splitText('abc\ndef\nghi', 8)).toEqual(['abc\ndef', 'ghi']);
    expect(splitText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(splitText('short', 10)).toEqual(['short']);
  });
});

describe('channelsFromUpdates', () => {
  it('finds channels the bot was made admin of, or that posted, once each', () => {
    const chat = { id: -1001, title: 'Bridge log', type: 'channel' };
    expect(
      channelsFromUpdates([
        { my_chat_member: { chat, new_chat_member: { status: 'administrator' } } },
        { channel_post: { chat } },
        { my_chat_member: { chat: { id: -1002, title: 'Left', type: 'channel' }, new_chat_member: { status: 'left' } } },
        { message: { chat: { id: 5, type: 'private' } } },
      ]),
    ).toEqual([{ id: -1001, title: 'Bridge log' }]);
  });
});
