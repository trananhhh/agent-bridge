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

  it('tracks outbox retries per peer', () => {
    store.enqueueOutbox(msg({ id: 'o1' }), 'cu', 'ECONNREFUSED');
    expect(store.outbox().map((o) => [o.message.id, o.peer])).toEqual([['o1', 'cu']]);
    store.bumpOutbox('o1', 'timeout');
    expect(store.outbox()[0]).toMatchObject({ attempts: 2, last_error: 'timeout' });
    store.removeOutbox('o1');
    expect(store.outbox()).toEqual([]);
  });

  it('stores peers with what each side may read, and replaces on reconnect', () => {
    store.upsertPeer({ name: 'cu', url: 'http://a:8790', token: 't1', folders: ['/w/a'], remoteFolders: ['/c/x'] });
    store.upsertPeer({ name: 'minh', url: 'http://b:8790', token: 't2', folders: ['/w/b', '/w/c'], remoteFolders: [] });
    store.upsertPeer({ name: 'cu', url: 'http://a2:8790', token: 't3', folders: ['/w/a'], remoteFolders: ['/c/y'] });
    expect(store.listPeers()).toEqual([
      { name: 'cu', url: 'http://a2:8790', token: 't3', folders: ['/w/a'], remoteFolders: ['/c/y'] },
      { name: 'minh', url: 'http://b:8790', token: 't2', folders: ['/w/b', '/w/c'], remoteFolders: [] },
    ]);
    expect(store.setPeerFolders('minh', ['/w/z'])).toBe(true);
    expect(store.getPeer('minh')?.folders).toEqual(['/w/z']);
    expect(store.removePeer('cu')).toBe(true);
    expect(store.removePeer('cu')).toBe(false);
    expect(store.listPeers().map((p) => p.name)).toEqual(['minh']);
  });

  it('tracks connect requests; a new incoming request from the same name replaces the pending one', () => {
    const base = { url: 'http://x:8790', secret: 's', folders: ['/f'], status: 'pending' as const };
    store.saveRequest({ ...base, id: 'r1', direction: 'in', name: 'cu', identity: 'cu@gmail.com' });
    store.saveRequest({ ...base, id: 'r2', direction: 'in', name: 'cu' });
    store.saveRequest({ ...base, id: 'r3', direction: 'out', name: 'minh' });
    expect(store.listRequests('in', 'pending').map((r) => r.id)).toEqual(['r2']);
    expect(store.getRequest('r3')).toMatchObject({ direction: 'out', name: 'minh', folders: ['/f'], status: 'pending' });
    store.setRequestStatus('r3', 'accepted');
    expect(store.getRequest('r3')?.status).toBe('accepted');
    expect(store.listRequests('out', 'pending')).toEqual([]);
  });
});
