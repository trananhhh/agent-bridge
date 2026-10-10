import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, type Daemon, type DaemonPeer } from './daemon.ts';
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

  function addSide(name: string, peers: { name: string; workdirs?: string[] }[]): Side {
    const side = {
      name,
      store: new BridgeStore(join(dir, `${name}.db`)),
      calls: [],
      sessions: [],
      sessionQueries: [],
      classifierAnswer: '{"session_id":null}',
      down: false,
    } as unknown as Side;
    const daemonPeers: DaemonPeer[] = peers.map((p) => ({
      name: p.name,
      url: `http://${p.name}.test`,
      token: pairToken(name, p.name),
      workdirs: p.workdirs ?? ['/w/shared'],
    }));
    side.daemon = createDaemon({
      name,
      peers: daemonPeers,
      store: side.store,
      runner: makeRunner(side),
      listSessions: (allowedDirs) => {
        side.sessionQueries.push(allowedDirs);
        return side.sessions;
      },
      headlessAllowedTools: ['Read'],
      headlessTimeoutMs: 1000,
      activeWindowMs: 10 * 60_000,
      now: () => NOW,
      log: () => {},
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
    b = addSide('cu', [{ name: 'anh', workdirs: ['/w/shared', '/w/extra'] }]);
  });
  afterEach(() => {
    for (const s of net.values()) s.store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = async () => {
    for (let i = 0; i < 3; i++) for (const s of net.values()) await s.daemon.idle();
  };
  const liveInbox = (side: Side, connId: string, sessionId?: string, cwd = '/w/shared') => {
    const got: PeerMessage[] = [];
    side.daemon.registerLive({ connId, sessionId, cwd, push: (m) => (got.push(m), true) });
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
    const sent = await a.daemon.send({ kind: 'ask', text: 'orders có cột provider_id?', connId: 'a-conn', sessionId: 'a-sess' });
    expect(sent.status).toBe('sent');
    await settle();

    expect(b.sessionQueries).toEqual([['/w/shared', '/w/extra']]);
    expect(work(b)).toHaveLength(1);
    expect(work(b)[0]).toMatchObject({ resumeSessionId: undefined, allowedTools: ['Read'], cwd: '/w/shared' });
    expect(work(b)[0].prompt).toContain('orders có cột provider_id?');
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
    expect(work(b)).toHaveLength(0);

    await b.daemon.send({ kind: 'reply', text: 'yes it does', threadId: sent.thread_id, connId: 'b-conn' });
    await settle();
    expect(gotA.map((m) => m.text)).toEqual(['yes it does']);
  });

  it('never offers a live session outside the asking peer workdirs', async () => {
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

    it('requires `to` when more than one peer is configured, and rejects unknown peers', async () => {
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
      const fromMinh = await m.daemon.send({ kind: 'ask', text: 'minh hỏi anh' });
      await settle();
      expect(work(a)).toHaveLength(0);
      expect(gotA.at(-1)).toMatchObject({ from: 'minh', thread_id: fromMinh.thread_id, kind: 'ask' });
      await a.daemon.send({ kind: 'reply', text: 'anh trả lời', threadId: fromMinh.thread_id, connId: 'a-conn' });
      await settle();
      expect(m.store.undeliveredReplies().map((x) => x.text)).toEqual(['anh trả lời']);
    });
  });
});
