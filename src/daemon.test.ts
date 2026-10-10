import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, type Daemon } from './daemon.ts';
import { BridgeStore } from './store.ts';
import type { ClaudeRunOptions, ClaudeRunner } from './claude-runner.ts';
import type { PeerMessage } from './protocol.ts';
import type { SessionCandidate } from './sessions.ts';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const pairToken = (a: string, b: string) => `tok-${[a, b].sort().join('-')}`.padEnd(32, '0');

interface Side {
  name: string;
  daemon: Daemon;
  store: BridgeStore;
  calls: ClaudeRunOptions[];
  sessions: SessionCandidate[];
  sessionQueries: string[][];
  notifications: string[];
  classifierAnswer: string;
  runnerError?: Error;
  down: boolean;
}

describe('agent-bridge daemon', () => {
  let dir: string;
  const net = new Map<string, Side>();

  function makeRunner(side: Side): ClaudeRunner {
    let n = 0;
    return async (opts) => {
      side.calls.push(opts);
      if (opts.noTools) return { sessionId: 'classifier', result: side.classifierAnswer, isError: false };
      if (side.runnerError) throw side.runnerError;
      const sessionId = opts.resumeSessionId && !opts.fork ? opts.resumeSessionId : `${side.name}-new-${++n}`;
      return { sessionId, result: `${side.name}#${n}`, isError: false };
    };
  }

  function addSide(name: string, peers: { name: string; folders?: string[] }[]): Side {
    const side = {
      name,
      store: new BridgeStore(join(dir, `${name}.db`)),
      calls: [],
      sessions: [],
      sessionQueries: [],
      notifications: [],
      classifierAnswer: '{"session_id":null}',
      down: false,
    } as unknown as Side;
    for (const p of peers) {
      side.store.upsertPeer({
        name: p.name,
        url: `http://${p.name}.test`,
        token: pairToken(name, p.name),
        folders: p.folders ?? ['/w/shared'],
        remoteFolders: [],
      });
    }
    side.daemon = createDaemon({
      name,
      publicUrl: `http://${name}.test`,
      store: side.store,
      runner: makeRunner(side),
      listSessions: (allowedDirs) => {
        side.sessionQueries.push(allowedDirs);
        return side.sessions;
      },
      headlessTimeoutMs: 1000,
      activeWindowMs: 10 * 60_000,
      now: () => NOW,
      log: () => {},
      notify: (title: string) => side.notifications.push(title),
      fetchImpl: async (url, init) => {
        if (side.down) throw new Error('ECONNREFUSED');
        const target = net.get(new URL(url).hostname.replace(/\.test$/, ''));
        if (!target || target.down) throw new Error('ECONNREFUSED');
        return target.daemon.peerApp.request(new URL(url).pathname, init);
      },
    });
    net.set(name, side);
    return side;
  }

  let a: Side;
  let b: Side;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-daemon-'));
    net.clear();
    a = addSide('anh', [{ name: 'cu' }]);
    b = addSide('cu', [{ name: 'anh', folders: ['/w/shared', '/w/extra'] }]);
  });
  afterEach(() => {
    for (const s of net.values()) s.store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = async () => {
    for (let i = 0; i < 3; i++) for (const s of net.values()) await s.daemon.idle();
  };
  const liveInbox = (side: Side, connId: string, sessionId?: string, cwd = '/w/shared') => {
    const got: (PeerMessage & { folders?: string[] })[] = [];
    side.daemon.registerLive({ connId, sessionId, cwd, push: (m, ctx) => (got.push({ ...m, ...ctx }), true) });
    return got;
  };
  const work = (s: Side) => s.calls.filter((c) => !c.noTools);

  describe('peer endpoint', () => {
    const post = (side: Side, token: string, body: unknown) =>
      side.daemon.peerApp.request('/inbox', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const msg = (over: Partial<PeerMessage> = {}) => ({ id: 'x1', thread_id: 't', from: 'anh', kind: 'reply', text: 'hi', sent_at: 'now', ...over });

    it('rejects an unknown token', async () => {
      expect((await post(b, 'nope'.padEnd(32, '0'), msg())).status).toBe(401);
    });

    it('rejects a sender claiming another identity than its token', async () => {
      expect((await post(b, pairToken('anh', 'cu'), msg({ from: 'minh' }))).status).toBe(403);
    });

    it('rejects a malformed message', async () => {
      expect((await post(b, pairToken('anh', 'cu'), { text: 'x' })).status).toBe(400);
    });

    it('accepts once and acknowledges duplicates without reprocessing', async () => {
      expect((await post(b, pairToken('anh', 'cu'), msg())).status).toBe(202);
      const dup = await post(b, pairToken('anh', 'cu'), msg());
      expect(dup.status).toBe(200);
      expect(await dup.json()).toMatchObject({ duplicate: true });
    });
  });

  it('new ask with nothing related → new headless session in the peer-scoped workdir; reply reaches the asking live session', async () => {
    const got = liveInbox(a, 'a-conn', 'a-sess');
    const sent = await a.daemon.send({ kind: 'ask', text: 'does orders have a provider_id column?', connId: 'a-conn', sessionId: 'a-sess' });
    expect(sent.status).toBe('sent');
    await settle();

    expect(b.sessionQueries).toEqual([['/w/shared', '/w/extra']]);
    expect(work(b)).toHaveLength(1);
    expect(work(b)[0]).toMatchObject({ resumeSessionId: undefined, readOnlyDirs: ['/w/shared', '/w/extra'], cwd: '/w/shared' });
    expect(work(b)[0].prompt).toContain('does orders have a provider_id column?');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'reply', thread_id: sent.thread_id, from: 'cu', text: 'cu#1' });
  });

  it('follow-up on the same thread resumes the session that answered, in its cwd', async () => {
    liveInbox(a, 'a-conn');
    b.sessions = [{ sessionId: 'proj', cwd: '/w/extra/app', title: 'x', mtimeMs: NOW - 3600_000 }];
    b.classifierAnswer = '{"session_id":"proj"}';
    const first = await a.daemon.send({ kind: 'ask', text: 'q1', connId: 'a-conn' });
    await settle();
    await a.daemon.send({ kind: 'ask', text: 'q2', threadId: first.thread_id, connId: 'a-conn' });
    await settle();
    expect(work(b).map((c) => [c.resumeSessionId, c.cwd])).toEqual([
      ['proj', '/w/extra/app'],
      ['proj', '/w/extra/app'],
    ]);
    expect(b.calls.filter((c) => c.noTools)).toHaveLength(1);
  });

  it('classifier picks the peer live session → pushed there, and its reply goes back', async () => {
    const gotA = liveInbox(a, 'a-conn');
    const gotB = liveInbox(b, 'b-conn', 'b-sess');
    b.classifierAnswer = '{"session_id":"b-sess"}';

    const sent = await a.daemon.send({ kind: 'ask', text: 'schema?', connId: 'a-conn' });
    await settle();
    expect(gotB).toHaveLength(1);
    expect(gotB[0].folders).toEqual(['/w/shared', '/w/extra']);
    expect(work(b)).toHaveLength(0);

    await b.daemon.send({ kind: 'reply', text: 'yes it does', threadId: sent.thread_id, connId: 'b-conn' });
    await settle();
    expect(gotA.map((m) => m.text)).toEqual(['yes it does']);
  });

  it('never offers a live session outside the folders shared with the asking peer', async () => {
    liveInbox(a, 'a-conn');
    const gotB = liveInbox(b, 'b-conn', 'b-private', '/w/private');
    b.classifierAnswer = '{"session_id":"b-private"}';
    await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn' });
    await settle();
    expect(gotB).toHaveLength(0);
    expect(b.calls.filter((c) => c.noTools)).toHaveLength(0);
    expect(work(b)).toHaveLength(1);
  });

  it('classifier picks a recent idle session → resumed in place; a recently active one is forked', async () => {
    liveInbox(a, 'a-conn');
    b.sessions = [
      { sessionId: 'idle', cwd: '/w/shared', title: 'old work', mtimeMs: NOW - 60 * 60_000 },
      { sessionId: 'busy', cwd: '/w/shared', title: 'open in desktop', mtimeMs: NOW - 60_000 },
    ];
    b.classifierAnswer = '{"session_id":"idle"}';
    await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn' });
    await settle();
    b.classifierAnswer = '{"session_id":"busy"}';
    await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn' });
    await settle();
    expect(work(b).map((c) => [c.resumeSessionId, Boolean(c.fork)])).toEqual([
      ['idle', false],
      ['busy', true],
    ]);
  });

  it('queues when the peer is down and delivers on flush', async () => {
    b.down = true;
    const sent = await a.daemon.send({ kind: 'ask', text: 'later', connId: 'a-conn' });
    expect(sent.status).toBe('queued');
    expect(a.store.outbox()).toHaveLength(1);
    b.down = false;
    await a.daemon.flushOutbox();
    await settle();
    expect(a.store.outbox()).toHaveLength(0);
    expect(work(b)).toHaveLength(1);
  });

  it('headless failure still answers the peer', async () => {
    const got = liveInbox(a, 'a-conn');
    b.runnerError = new Error('claude exited 1');
    await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn' });
    await settle();
    expect(got[0].text).toMatch(/claude exited 1/);
  });

  it('parks a reply when the asking session closed, and hands it over when that session reconnects', async () => {
    const unregister = a.daemon.registerLive({ connId: 'a-conn', sessionId: 'a-sess', push: () => true });
    await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn', sessionId: 'a-sess' });
    unregister();
    await settle();
    expect(a.store.undeliveredReplies('a-sess')).toHaveLength(1);
    const got = liveInbox(a, 'a-conn-2', 'a-sess');
    expect(got.map((m) => m.text)).toEqual(['cu#1']);
    expect(a.store.undeliveredReplies()).toHaveLength(0);
  });

  describe('several peers', () => {
    let m: Side;
    beforeEach(() => {
      net.get('anh')!.store.close();
      a = addSide('anh', [{ name: 'cu' }, { name: 'minh' }]);
      m = addSide('minh', [{ name: 'anh' }]);
    });

    it('requires `to` when more than one peer is connected, and rejects unknown peers', async () => {
      await expect(a.daemon.send({ kind: 'ask', text: 'q' })).rejects.toThrow(/to/);
      await expect(a.daemon.send({ kind: 'ask', text: 'q', to: 'ghost' })).rejects.toThrow(/ghost/);
    });

    it('routes each thread to its own peer, including replies to their asks', async () => {
      const gotA = liveInbox(a, 'a-conn');
      await a.daemon.send({ kind: 'ask', text: 'cho minh', to: 'minh', connId: 'a-conn' });
      await settle();
      expect(work(m)).toHaveLength(1);
      expect(work(b)).toHaveLength(0);
      expect(gotA.map((x) => [x.from, x.text])).toEqual([['minh', 'minh#1']]);

      a.classifierAnswer = '{"session_id":"live-a-conn"}';
      const fromMinh = await m.daemon.send({ kind: 'ask', text: 'minh asks anh' });
      await settle();
      expect(work(a)).toHaveLength(0);
      expect(gotA.at(-1)).toMatchObject({ from: 'minh', thread_id: fromMinh.thread_id, kind: 'ask' });
      await a.daemon.send({ kind: 'reply', text: 'anh answers', threadId: fromMinh.thread_id, connId: 'a-conn' });
      await settle();
      expect(m.store.undeliveredReplies().map((x) => x.text)).toEqual(['anh answers']);
    });
  });
  describe('connecting', () => {
    let fa: string;
    let fb: string;
    const call = async (side: Side, path: string, body?: unknown) => {
      const res = await side.daemon.localApp.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    beforeEach(() => {
      for (const s of net.values()) s.store.close();
      net.clear();
      fa = realpathSync(mkdtempSync(join(dir, 'fa-')));
      fb = realpathSync(mkdtempSync(join(dir, 'fb-')));
      mkdirSync(join(fb, 'sub'));
      a = addSide('anh', []);
      b = addSide('cu', []);
      a.store.removePeer('cu'); // the outer beforeEach pre-connected them in the same db files
      b.store.removePeer('anh');
    });

    const requestFromA = async () => {
      const r = await call(a, '/local/connect', { url: 'http://cu.test', folders: [fa] });
      expect(r.status).toBe(200);
      expect(r.body.peer).toBe('cu');
      return String(r.body.request_id);
    };

    it('request → notify → accept connects both sides with the folders each user chose', async () => {
      const id = await requestFromA();
      expect(b.notifications.join()).toMatch(/anh/);

      const incoming = await call(b, '/local/requests');
      expect(incoming.body.incoming).toEqual([expect.objectContaining({ id, name: 'anh', folders: [fa] })]);
      expect(JSON.stringify(incoming.body)).not.toMatch(/secret/);

      const ok = await call(b, '/local/requests/answer', { request_id: id, accept: true, folders: [fb, join(fb, 'sub/')] });
      expect(ok).toMatchObject({ status: 200, body: { peer: 'anh' } });

      expect((await call(a, `/local/requests/${id}`)).body).toMatchObject({ status: 'accepted', name: 'cu', remote_folders: [fb, join(fb, 'sub')] });
      expect(a.store.getPeer('cu')).toMatchObject({ url: 'http://cu.test', folders: [fa], remoteFolders: [fb, join(fb, 'sub')] });
      expect(b.store.getPeer('anh')).toMatchObject({ url: 'http://anh.test', folders: [fb, join(fb, 'sub')], remoteFolders: [fa] });
      expect(a.store.getPeer('cu')!.token).toBe(b.store.getPeer('anh')!.token);
      expect(a.notifications.join()).toMatch(/cu/);

      const got = liveInbox(a, 'a-conn', undefined, fa);
      await a.daemon.send({ kind: 'ask', text: 'hello', connId: 'a-conn' });
      await settle();
      expect(work(b)[0]).toMatchObject({ cwd: fb, readOnlyDirs: [fb, join(fb, 'sub')] });
      expect(got.map((m) => m.text)).toEqual(['cu#1']);
    });

    it('decline leaves both sides unconnected', async () => {
      const id = await requestFromA();
      expect((await call(b, '/local/requests/answer', { request_id: id, accept: false })).status).toBe(200);
      expect((await call(a, `/local/requests/${id}`)).body.status).toBe('declined');
      expect(a.store.listPeers()).toEqual([]);
      expect(b.store.listPeers()).toEqual([]);
    });

    it('accepting while the requester is offline fails and keeps the request pending for a retry', async () => {
      const id = await requestFromA();
      a.down = true;
      expect((await call(b, '/local/requests/answer', { request_id: id, accept: true, folders: [fb] })).status).toBe(502);
      expect(b.store.listPeers()).toEqual([]);
      a.down = false;
      expect((await call(b, '/local/requests/answer', { request_id: id, accept: true, folders: [fb] })).status).toBe(200);
      expect(a.store.getPeer('cu')).toBeDefined();
    });

    it('rejects an answer that does not carry the request secret', async () => {
      const id = await requestFromA();
      const forged = await a.daemon.peerApp.request('/connect/answer', {
        method: 'POST',
        body: JSON.stringify({ request_id: id, secret: 'f'.repeat(64), accepted: true, name: 'cu', folders: [] }),
      });
      expect(forged.status).toBe(403);
      expect(a.store.listPeers()).toEqual([]);
    });

    it('refuses bad folders, yourself, and hosts that are not agent-bridge', async () => {
      expect((await call(a, '/local/connect', { url: 'http://cu.test', folders: [join(fa, 'missing')] })).status).toBe(400);
      expect((await call(a, '/local/connect', { url: 'http://anh.test', folders: [fa] })).status).toBe(400);
      expect((await call(a, '/local/connect', { url: 'http://nobody.test', folders: [fa] })).status).toBe(502);
    });

    it('lists, re-scopes and removes peers', async () => {
      const id = await requestFromA();
      await call(b, '/local/requests/answer', { request_id: id, accept: true, folders: [fb] });
      expect((await call(a, '/local/peers')).body).toEqual({ peers: [{ name: 'cu', url: 'http://cu.test', folders: [fa], remote_folders: [fb] }] });
      expect((await call(a, '/local/peers/folders', { name: 'cu', folders: [fb] })).status).toBe(200);
      expect(a.store.getPeer('cu')!.folders).toEqual([fb]);
      expect((await call(a, '/local/peers/remove', { name: 'cu' })).status).toBe(200);
      expect(a.store.listPeers()).toEqual([]);
    });
  });
});
