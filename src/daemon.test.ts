import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, type Daemon, type DaemonOptions } from './daemon.ts';
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
  resumeError?: Error;
  /** What the answering agent says instead of "<side>#<n>". */
  answerText?: string;
  /** Answering runs wait for this before finishing. */
  gate?: Promise<void>;
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
      if (opts.resumeSessionId && side.resumeError) throw side.resumeError;
      const sessionId = opts.resumeSessionId && !opts.fork ? opts.resumeSessionId : `${side.name}-new-${++n}`;
      await side.gate;
      return { sessionId, result: side.answerText ?? `${side.name}#${n}`, isError: false };
    };
  }

  function addSide(name: string, peers: { name: string; folders?: string[] }[], extra: Partial<Pick<DaemonOptions, 'mirrorChat' | 'answerModel' | 'answerEffort' | 'classifierModel' | 'ownerReview' | 'coalesceMs'>> = {}): Side {
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
      coalesceMs: 0,
      ...extra,
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
    expect(work(b)[0].appendSystemPrompt).not.toContain('[[ASK_OWNER]]');
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

  it('a session that can no longer be resumed falls back to a fresh session instead of failing', async () => {
    const got = liveInbox(a, 'a-conn');
    b.sessions = [{ sessionId: 'gone', cwd: '/w/shared', title: 'deleted', mtimeMs: NOW - 60 * 60_000 }];
    b.classifierAnswer = '{"session_id":"gone"}';
    b.resumeError = new Error('No conversation found with session ID: gone');
    await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn' });
    await settle();
    expect(work(b).map((c) => c.resumeSessionId)).toEqual(['gone', undefined]);
    expect(got[0].text).toBe(`${b.name}#1`);
  });

  it('names fresh and forked answering sessions after the asker and question, never a session resumed in place', async () => {
    liveInbox(a, 'a-conn');
    b.sessions = [
      { sessionId: 'idle', cwd: '/w/shared', title: 'old work', mtimeMs: NOW - 60 * 60_000 },
      { sessionId: 'busy', cwd: '/w/shared', title: 'open in desktop', mtimeMs: NOW - 60_000 },
    ];
    for (const [choice, text] of [
      ['null', '\n  Does orders have a provider_id column? It matters for the import\nsecond line'],
      ['"busy"', 'q2'],
      ['"idle"', 'q3'],
    ]) {
      b.classifierAnswer = `{"session_id":${choice}}`;
      await a.daemon.send({ kind: 'ask', text, connId: 'a-conn' });
      await settle();
    }
    expect(work(b).map((c) => c.name)).toEqual([`⇄ ${a.name}: Does orders have a provider_id column? It matters for the…`, `⇄ ${a.name}: q2`, undefined]);
  });

  it('answers with the configured model and effort whatever model the resumed session last used; the classifier stays on its own model', async () => {
    const m = addSide('minh', [{ name: 'cu' }], { answerModel: 'opus', answerEffort: 'xhigh', classifierModel: 'haiku' });
    b.store.upsertPeer({ name: 'minh', url: 'http://minh.test', token: pairToken('cu', 'minh'), folders: ['/w/shared'], remoteFolders: [] });
    m.sessions = [{ sessionId: 'desktop-fable', cwd: '/w/shared', title: 'x', mtimeMs: NOW - 3600_000 }];
    m.classifierAnswer = '{"session_id":"desktop-fable"}';
    liveInbox(b, 'b-conn');
    await b.daemon.send({ kind: 'ask', text: 'q', connId: 'b-conn', to: 'minh' });
    await settle();
    expect(m.calls.map((c) => [c.noTools ?? false, c.model, c.effort, c.resumeSessionId])).toEqual([
      [true, 'haiku', undefined, undefined],
      [false, 'opus', 'xhigh', 'desktop-fable'],
    ]);
  });

  it('answers a burst of asks on one thread once, with every part, instead of once per part', async () => {
    const c = addSide('chi', [{ name: 'anh' }], { coalesceMs: 30 });
    c.sessions = [{ sessionId: 'old', cwd: '/w/shared', title: 'x', mtimeMs: NOW - 3600_000 }];
    a.store.upsertPeer({ name: 'chi', url: 'http://chi.test', token: pairToken('anh', 'chi'), folders: ['/w/shared'], remoteFolders: [] });
    const got = liveInbox(a, 'a-conn');
    const first = await a.daemon.send({ kind: 'ask', text: 'part 1: fund', connId: 'a-conn', to: 'chi' });
    await a.daemon.send({ kind: 'ask', text: 'part 2: profit', threadId: first.thread_id, connId: 'a-conn' });
    await a.daemon.send({ kind: 'ask', text: 'part 3: 150tr', threadId: first.thread_id, connId: 'a-conn' });
    await settle();
    expect(work(c)).toHaveLength(1);
    expect(work(c)[0].prompt).toMatch(/part 1: fund[^]*part 2: profit[^]*part 3: 150tr/);
    expect(c.calls.filter((x) => x.noTools)).toHaveLength(1);
    expect(got.map((m) => m.kind)).toEqual(['reply']);
  });

  it('a part arriving while the answer is being written gets its own answer afterwards, in the same session', async () => {
    let release!: () => void;
    b.gate = new Promise((r) => (release = r));
    const got = liveInbox(a, 'a-conn');
    const first = await a.daemon.send({ kind: 'ask', text: 'q1', connId: 'a-conn' });
    await new Promise((r) => setTimeout(r, 5));
    await a.daemon.send({ kind: 'ask', text: 'q2', threadId: first.thread_id, connId: 'a-conn' });
    release();
    await settle();
    expect(work(b).map((c) => [c.resumeSessionId, c.prompt.includes('q2')])).toEqual([
      [undefined, false],
      [`${b.name}-new-1`, true],
    ]);
    expect(got).toHaveLength(2);
  });

  it('answers asks that arrived but were never answered before a restart', async () => {
    const thread = 'anh-99999999-0000-0000-0000-000000000000';
    b.store.insertMessage({ id: 'lost', thread_id: thread, from: 'anh', kind: 'ask', text: 'still there?', sent_at: 'now' }, 'in');
    b.store.insertMessage({ id: 'done', thread_id: 'anh-answered', from: 'anh', kind: 'ask', text: 'answered', sent_at: 'now' }, 'in');
    b.store.markDelivered(['done']);
    b.daemon.recover();
    await settle();
    expect(work(b).map((c) => c.prompt.includes('still there?'))).toEqual([true]);
    expect(a.store.threadMessages(thread).map((m) => m.kind)).toEqual(['reply']);
  });

  describe('owner review', () => {
    let o: Side;
    beforeEach(() => {
      o = addSide('owner', [{ name: 'anh' }], { ownerReview: { owners: () => 'Cừ' } });
      a.store.upsertPeer({ name: 'owner', url: 'http://owner.test', token: pairToken('anh', 'owner'), folders: ['/w/shared'], remoteFolders: [] });
    });
    const ask = async (text = 'final number?') => {
      const got = liveInbox(a, 'a-conn');
      const sent = await a.daemon.send({ kind: 'ask', text, connId: 'a-conn', to: 'owner' });
      await settle();
      return { got, thread: sent.thread_id };
    };

    it('lets the agent ask the owner first: nothing reaches the peer, and the question remembers the session to continue', async () => {
      o.answerText = '[[ASK_OWNER]] Chốt 2.400.388 chưa anh?\nSố chốt là **2.400.388**.';
      const { got, thread } = await ask();
      expect(work(o)[0].appendSystemPrompt).toContain('[[ASK_OWNER]]');
      expect(work(o)[0].appendSystemPrompt).toContain('Cừ');
      expect(got).toEqual([]);
      expect(o.store.pendingDraft(thread)).toMatchObject({
        question: 'Chốt 2.400.388 chưa anh?',
        text: 'Số chốt là **2.400.388**.',
        status: 'pending',
        peer: 'anh',
        session_id: 'owner-new-1',
        cwd: '/w/shared',
      });
    });

    it("feeds the owner's answer back into that session, which then writes the answer the peer gets", async () => {
      o.answerText = '[[ASK_OWNER]] Chốt 2.400.388 chưa anh?\ndraft';
      const { got, thread } = await ask();
      const question = o.store.pendingDraft(thread)!;
      o.answerText = 'Đã chốt: 2.400.388.';
      expect(await o.daemon.answerOwnerQuestion(question.id, 'Chốt rồi, gửi đi', 'Cừ')).toBe('answered');
      await settle();
      const resumed = work(o).at(-1)!;
      expect(resumed).toMatchObject({ resumeSessionId: 'owner-new-1', cwd: '/w/shared', readOnlyDirs: ['/w/shared'], model: undefined });
      expect(resumed.fork).toBeFalsy();
      expect(resumed.prompt).toContain('Chốt 2.400.388 chưa anh?');
      expect(resumed.prompt).toContain('Chốt rồi, gửi đi');
      expect(got.map((m) => [m.kind, m.text])).toEqual([['reply', 'Đã chốt: 2.400.388.']]);
      expect(o.store.getDraft(question.id)).toMatchObject({ status: 'answered', resolved_by: 'Cừ', answer: 'Chốt rồi, gửi đi' });
      expect(await o.daemon.answerOwnerQuestion(question.id, 'again', 'Cừ')).toBe('already answered');
    });

    it("finishes an owner's answer that was still being worked on when the daemon stopped", async () => {
      o.answerText = '[[ASK_OWNER]] ok?\nx';
      const { got, thread } = await ask();
      const question = o.store.pendingDraft(thread)!;
      o.store.resolveDraft(question.id, 'answering', 'Cừ', 'Chốt');
      o.answerText = 'Đã chốt.';
      o.daemon.recover();
      await settle();
      expect(got.map((m) => m.text)).toEqual(['Đã chốt.']);
      expect(work(o).at(-1)?.prompt).toContain('Chốt');
      expect(o.store.getDraft(question.id)?.status).toBe('answered');
    });

    it('asks again when the answer still needs the owner', async () => {
      o.answerText = '[[ASK_OWNER]] first?\nx';
      const { got, thread } = await ask();
      const first = o.store.pendingDraft(thread)!;
      o.answerText = '[[ASK_OWNER]] and the 150tr?\ny';
      await o.daemon.answerOwnerQuestion(first.id, 'yes', 'Cừ');
      await settle();
      expect(got).toEqual([]);
      expect(o.store.pendingDraft(thread)).toMatchObject({ question: 'and the 150tr?', session_id: 'owner-new-1' });
    });

    it('a reply sent from the session in Claude settles the question too', async () => {
      o.answerText = '[[ASK_OWNER]] ok?\nx';
      const { got, thread } = await ask();
      const question = o.store.pendingDraft(thread)!;
      const res = await o.daemon.localApp.request('/local/send', { method: 'POST', body: JSON.stringify({ kind: 'reply', text: 'answered in Claude', thread_id: thread }) });
      expect(res.status).toBe(200);
      await settle();
      expect(got.map((m) => m.text)).toEqual(['answered in Claude']);
      expect(o.store.getDraft(question.id)).toMatchObject({ status: 'answered', resolved_by: 'Claude' });
    });

    it('an owner answering in Claude also stops an answer still being written from going out', async () => {
      o.answerText = '[[ASK_OWNER]] ok?\nx';
      const { got, thread } = await ask();
      const question = o.store.pendingDraft(thread)!;
      let release!: () => void;
      o.gate = new Promise((r) => (release = r));
      o.answerText = 'late';
      await o.daemon.answerOwnerQuestion(question.id, 'yes', 'Cừ');
      await new Promise((r) => setTimeout(r, 5));
      await o.daemon.localApp.request('/local/send', { method: 'POST', body: JSON.stringify({ kind: 'reply', text: 'from Claude', thread_id: thread }) });
      release();
      await settle();
      expect(got.map((m) => m.text)).toEqual(['from Claude']);
    });

    it('keeps a question about something private to the owner marked private', async () => {
      o.answerText = '[[ASK_OWNER_PRIVATE]] Có nói với Cừ về khoản vay riêng không?\ndraft';
      const { got, thread } = await ask();
      expect(got).toEqual([]);
      expect(o.store.pendingDraft(thread)).toMatchObject({ question: 'Có nói với Cừ về khoản vay riêng không?', private: true });
      expect(work(o)[0].appendSystemPrompt).toContain('[[ASK_OWNER_PRIVATE]]');
    });

    it('the owner confirming the draft sends it as written, once', async () => {
      o.answerText = '[[ASK_OWNER]] Gửi được chưa?\nSố chốt là **2.400.388**.';
      const { got, thread } = await ask();
      const draft = o.store.pendingDraft(thread)!;
      expect(await o.daemon.confirmOwnerDraft(draft.id, 'Cừ')).toBe('sent');
      await settle();
      expect(got.map((m) => m.kind)).toEqual(['reply']);
      expect(got[0].text).toMatch(/Confirmed by Cừ[^]*Số chốt là \*\*2\.400\.388\*\*\./);
      expect(o.store.getDraft(draft.id)).toMatchObject({ status: 'sent', resolved_by: 'Cừ' });
      expect(await o.daemon.confirmOwnerDraft(draft.id, 'Cừ')).toBe('already answered');
      expect(got).toHaveLength(1);
    });

    it('there is nothing to confirm when the agent only asked', async () => {
      o.answerText = '[[ASK_OWNER]] Khoản 150tr là gì?';
      const { thread } = await ask();
      expect(await o.daemon.confirmOwnerDraft(o.store.pendingDraft(thread)!.id, 'Cừ')).toBe('nothing to send');
      expect(o.store.pendingDraft(thread)).toBeDefined();
    });

    it('a newer question retires the older one on the thread', async () => {
      o.answerText = '[[ASK_OWNER]] first?\ndraft 1';
      const { thread } = await ask();
      const older = o.store.pendingDraft(thread)!;
      o.answerText = '[[ASK_OWNER]] second?\ndraft 2';
      await a.daemon.send({ kind: 'ask', text: 'and this?', threadId: thread, connId: 'a-conn' });
      await settle();
      expect(o.store.pendingDraft(thread)!.id).not.toBe(older.id);
      expect(o.store.getDraft(older.id)?.status).toBe('superseded');
    });

    it('holds the answer wherever the hand-off line appears and however it is formatted', async () => {
      o.answerText = 'Đây là trả lời.\n**[[ASK_OWNER]] Chốt chưa?**\nSố chốt 2.400.388';
      const { got, thread } = await ask();
      expect(got).toEqual([]);
      expect(o.store.pendingDraft(thread)).toMatchObject({ question: 'Chốt chưa?', text: 'Đây là trả lời.\nSố chốt 2.400.388' });
    });

    it("the owner's own words to the peer answer a waiting ask and settle the question; later ones are follow-up asks", async () => {
      o.answerText = '[[ASK_OWNER]] ok?\ndraft';
      const { got, thread } = await ask();
      const question = o.store.pendingDraft(thread)!;

      await o.daemon.ownerReply({ threadId: thread, text: 'Đúng, 2.400.388.', owner: 'Cừ', seenInChat: true });
      await settle();
      expect(o.store.getDraft(question.id)).toMatchObject({ status: 'answered', resolved_by: 'Cừ' });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ kind: 'reply', thread_id: thread });
      expect(got[0].text).toMatch(/Cừ[^\n]*person[^]*Đúng, 2\.400\.388\./);
      expect(o.store.threadMessages(thread).at(-1)?.via).toBe('owner-in-chat');

      await o.daemon.ownerReply({ threadId: thread, text: 'Còn khoản 150tr thì sao?', owner: 'Cừ' });
      await settle();
      expect(got.map((m) => m.kind)).toEqual(['reply', 'ask']);
      expect(got[1].text).toContain('Còn khoản 150tr thì sao?');
    });

    it('an answer that finishes after the owner already replied is not sent too', async () => {
      o.store.upsertPeer({ name: 'zed', url: 'http://zed.test', token: pairToken('owner', 'zed'), folders: ['/w/shared'], remoteFolders: [] });
      let release!: () => void;
      o.gate = new Promise((r) => (release = r));
      const got = liveInbox(a, 'a-conn');
      const sent = await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn', to: 'owner' });
      await new Promise((r) => setTimeout(r, 5));
      await o.daemon.ownerReply({ threadId: sent.thread_id, text: 'tôi trả lời', owner: 'Cừ' });
      release();
      await settle();
      expect(got).toHaveLength(1);
      expect(got[0].text).toContain('tôi trả lời');
    });

    it('an owner reply that cannot be sent changes nothing', async () => {
      o.answerText = '[[ASK_OWNER]] ok?\ndraft';
      const { got, thread } = await ask();
      const question = o.store.pendingDraft(thread)!;
      o.store.removePeer('anh');
      await expect(o.daemon.ownerReply({ threadId: thread, text: 'x', owner: 'Cừ' })).rejects.toThrow(/anh/);
      await expect(o.daemon.answerOwnerQuestion(question.id, 'x', 'Cừ')).rejects.toThrow(/anh/);
      expect(o.store.getDraft(question.id)?.status).toBe('pending');
      expect(got).toEqual([]);
    });

    it('tells the session answering a later ask what the owner said and answered on the thread', async () => {
      o.answerText = '[[ASK_OWNER]] Số là 2.400.388?\nx';
      const { thread } = await ask();
      o.answerText = 'ok';
      await o.daemon.answerOwnerQuestion(o.store.pendingDraft(thread)!.id, 'Không, 2.401.000', 'Cừ');
      await o.daemon.ownerReply({ threadId: thread, text: 'Nhớ trừ phí ship', owner: 'Cừ' });
      await settle();
      o.store.upsertThread({ thread_id: thread, session_id: 'other-session' });
      await a.daemon.send({ kind: 'ask', text: 'confirm?', threadId: thread, connId: 'a-conn' });
      await settle();
      const prompt = work(o).at(-1)!.prompt;
      expect(prompt).toMatch(/Số là 2\.400\.388\?[^\n]*Không, 2\.401\.000/);
      expect(prompt).toContain('Nhớ trừ phí ship');
    });

    it('ignores the hand-off line when nobody reviews this machine', async () => {
      b.answerText = '[[ASK_OWNER]] ok?\ndraft';
      const got = liveInbox(a, 'a-conn');
      await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn', to: 'cu' });
      await settle();
      expect(got[0].text).toBe('[[ASK_OWNER]] ok?\ndraft');
    });
  });

  it('tags outgoing messages with the Telegram chat this side mirrors to, and the receiver keeps the tag', async () => {
    const m = addSide('minh', [{ name: 'cu' }], { mirrorChat: '-1001' });
    b.store.upsertPeer({ name: 'minh', url: 'http://minh.test', token: pairToken('cu', 'minh'), folders: ['/w/shared'], remoteFolders: [] });
    liveInbox(m, 'm-conn');
    const sent = await m.daemon.send({ kind: 'ask', text: 'q', connId: 'm-conn', to: 'cu' });
    await settle();
    expect(m.store.threadMessages(sent.thread_id)[0].mirror).toBe('-1001');
    const atCu = b.store.threadMessages(sent.thread_id);
    expect(atCu.map((x) => [x.direction, x.mirror])).toEqual([
      ['in', '-1001'],
      ['out', undefined],
    ]);
  });

  it('serves the conversation log to the local CLI', async () => {
    liveInbox(a, 'a-conn');
    await a.daemon.send({ kind: 'ask', text: 'q', connId: 'a-conn' });
    await settle();
    const get = async (side: Side, path: string) => {
      const res = await side.daemon.localApp.request(path);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const { body: list } = await get(b, '/local/threads');
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]).toMatchObject({ peer: a.name, origin: 'remote', count: 2, last_kind: 'reply' });
    const id: string = list.threads[0].thread_id;

    const { body: thread } = await get(b, `/local/threads/${id.slice(0, id.length - 28)}`);
    expect(thread.thread).toMatchObject({ thread_id: id, origin: 'remote', session_id: `${b.name}-new-1` });
    expect(thread.messages.map((m: any) => [m.direction, m.kind])).toEqual([
      ['in', 'ask'],
      ['out', 'reply'],
    ]);
    expect((await get(b, '/local/threads/nope')).status).toBe(404);

    const { body: cursor } = await get(b, '/local/messages');
    expect(cursor).toEqual({ messages: [], latest: thread.messages[1].seq });
    const { body: after } = await get(b, `/local/messages?after=${thread.messages[0].seq}`);
    expect(after.messages.map((m: any) => m.kind)).toEqual(['reply']);

    b.store.insertMessage({ id: 'early', thread_id: 'anh-1234abcd-0000-0000-0000-000000000000', from: 'anh', kind: 'ask', text: 'still being answered', sent_at: 'now' }, 'in');
    const { body: withEarly } = await get(b, '/local/threads');
    expect(withEarly.threads[0]).toMatchObject({ thread_id: 'anh-1234abcd-0000-0000-0000-000000000000', origin: 'remote', peer: 'anh' });
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
