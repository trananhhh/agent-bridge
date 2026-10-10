import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from './store.ts';
import type { PeerMessage } from './protocol.ts';

const msg = (over: Partial<PeerMessage> = {}): PeerMessage => ({
  id: `m-${Math.random()}`,
  thread_id: 't1',
  from: 'cu',
  kind: 'ask',
  text: 'hello',
  sent_at: new Date().toISOString(),
  ...over,
});

describe('BridgeStore', () => {
  let dir: string;
  let store: BridgeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-store-'));
    store = new BridgeStore(join(dir, 'bridge.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects duplicate message ids so peer retries are idempotent', () => {
    const m = msg({ id: 'dup' });
    expect(store.insertMessage(m, 'in')).toBe(true);
    expect(store.insertMessage(m, 'in')).toBe(false);
  });

  it('merges thread updates without dropping earlier fields', () => {
    store.upsertThread({ thread_id: 't1', origin: 'remote', peer: 'cu', session_id: 's1', cwd: '/w' });
    store.upsertThread({ thread_id: 't1', conn_id: 'c1' });
    expect(store.getThread('t1')).toMatchObject({ thread_id: 't1', origin: 'remote', peer: 'cu', session_id: 's1', cwd: '/w', conn_id: 'c1' });
    expect(store.getThread('missing')).toBeUndefined();
  });

  it('returns undelivered inbound replies, optionally scoped to a session, then marks them delivered', () => {
    store.upsertThread({ thread_id: 'ta', origin: 'local', session_id: 'sa' });
    store.upsertThread({ thread_id: 'tb', origin: 'local', session_id: 'sb' });
    store.insertMessage(msg({ id: 'r1', thread_id: 'ta', kind: 'reply' }), 'in');
    store.insertMessage(msg({ id: 'r2', thread_id: 'tb', kind: 'reply' }), 'in');
    store.insertMessage(msg({ id: 'a1', thread_id: 'ta', kind: 'ask' }), 'in');

    expect(store.undeliveredReplies('sa').map((m) => m.id)).toEqual(['r1']);
    expect(store.undeliveredReplies().map((m) => m.id).sort()).toEqual(['r1', 'r2']);
    store.markDelivered(['r1']);
    expect(store.undeliveredReplies().map((m) => m.id)).toEqual(['r2']);
  });

  it('tracks outbox retries', () => {
    const m = msg({ id: 'o1' });
    store.enqueueOutbox(m, 'cu', 'ECONNREFUSED');
    expect(store.outbox().map((o) => [o.message.id, o.peer])).toEqual([['o1', 'cu']]);
    store.bumpOutbox('o1', 'timeout');
    expect(store.outbox()[0]).toMatchObject({ attempts: 2, last_error: 'timeout' });
    store.removeOutbox('o1');
    expect(store.outbox()).toEqual([]);
  });
});
