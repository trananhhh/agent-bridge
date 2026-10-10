import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ClaudeRunner } from './claude-runner.ts';
import { expandPath } from './config.ts';
import { PeerMessageSchema, type MessageKind, type PeerMessage } from './protocol.ts';
import { buildClassifierPrompt, parseClassifierOutput, resolveTarget, routeInbound, type ClassifierCandidate, type Target } from './router.ts';
import { isWithin, type SessionCandidate } from './sessions.ts';
import type { BridgeStore, ConnectRequest, PeerRecord } from './store.ts';

/** Peer `folders`: the only directories this peer's questions may be answered from (read-only). First one hosts new sessions. */
type DaemonPeer = PeerRecord;

export interface DaemonOptions {
  name: string;
  /** How peers reach this daemon: http://<tailscale-ip>:<port>. */
  publicUrl: string;
  version?: string;
  /** Tailscale identity of a tailnet IP (login + machine), shown when someone asks to connect. */
  whois?: (ip: string) => Promise<string | undefined>;
  /** Desktop notification for the owner (connect requests / acceptances). */
  notify?: (title: string, body: string) => void;
  store: BridgeStore;
  runner: ClaudeRunner;
  listSessions: (allowedDirs: string[]) => SessionCandidate[];
  headlessTimeoutMs: number;
  activeWindowMs: number;
  classifierModel?: string;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface LiveConn {
  connId: string;
  sessionId?: string;
  cwd?: string;
  push: (msg: PeerMessage, ctx: { folders?: string[] }) => boolean;
}

export interface SendInput {
  kind: MessageKind;
  text: string;
  to?: string;
  threadId?: string;
  connId?: string;
  sessionId?: string;
  cwd?: string;
}

export interface SendResult {
  id: string;
  thread_id: string;
  to: string;
  status: 'sent' | 'queued';
}

export interface Daemon {
  peerApp: Hono;
  localApp: Hono;
  registerLive: (conn: LiveConn) => () => void;
  send: (input: SendInput) => Promise<SendResult>;
  flushOutbox: () => Promise<void>;
  idle: () => Promise<void>;
}

const PEER_TIMEOUT_MS = 10_000;
const MAX_PENDING_REQUESTS = 20;
const PEER_NAME = /^[a-z0-9_-]{1,50}$/;
const CLASSIFIER_TIMEOUT_MS = 120_000;

const headlessSystemPrompt = (peer: string) =>
  `Bạn đang trả lời tin nhắn từ bot Claude Code của "${peer}" qua agent-bridge; không có người ngồi trước màn hình. ` +
  'Bạn chỉ có quyền ĐỌC trong các thư mục được chia sẻ với người này. Không ghi được gì; nếu yêu cầu cần ghi/sửa/chạy lệnh, ' +
  'trả lời rõ cần làm gì và rằng chủ máy phải tự duyệt (mở session để làm). Câu trả lời cuối cùng được gửi nguyên văn cho bot bên kia.';

const LocalSendSchema = z.object({
  kind: z.enum(['ask', 'reply']),
  text: z.string().min(1).max(32_000),
  to: z.string().max(50).optional(),
  thread_id: z.string().min(1).max(100).optional(),
  conn_id: z.string().max(100).optional(),
  session_id: z.string().max(100).optional(),
  cwd: z.string().max(1000).optional(),
});

export function createDaemon(opts: DaemonOptions): Daemon {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((event, data) => console.error(JSON.stringify({ t: new Date().toISOString(), event, ...data })));
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const { store } = opts;
  const peerNames = () => store.listPeers().map((p) => p.name);
  const live = new Map<string, LiveConn>();
  const pending = new Set<Promise<unknown>>();
  const queues = new Map<string, Promise<unknown>>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  };

  const serialize = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
    queues.set(key, next);
    next.finally(() => queues.get(key) === next && queues.delete(key)).catch(() => {});
    return next;
  };

  function resolvePeer(input: SendInput): DaemonPeer {
    const fromThread = input.threadId ? store.getThread(input.threadId)?.peer : undefined;
    const names = peerNames();
    const name = fromThread ?? input.to ?? (names.length === 1 ? names[0] : undefined);
    if (!name) throw new Error(names.length ? `"to" is required: pick one of ${names.join(', ')}` : 'chưa kết nối với ai (chạy `agent-bridge connect` trong terminal)');
    const peer = store.getPeer(name);
    if (!peer) throw new Error(`unknown peer "${name}"; connected: ${names.join(', ') || '(none)'}`);
    return peer;
  }

  async function postToPeer(peer: DaemonPeer, msg: PeerMessage): Promise<void> {
    const res = await fetchImpl(`${peer.url.replace(/\/$/, '')}/inbox`, {
      method: 'POST',
      headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`peer ${peer.name} responded ${res.status}`);
  }

  async function send(input: SendInput): Promise<SendResult> {
    const peer = resolvePeer(input);
    const msg: PeerMessage = {
      id: randomUUID(),
      thread_id: input.threadId ?? `${opts.name}-${randomUUID()}`,
      from: opts.name,
      kind: input.kind,
      text: input.text,
      sent_at: new Date(now()).toISOString(),
    };
    store.insertMessage(msg, 'out');
    store.upsertThread({
      thread_id: msg.thread_id,
      origin: input.threadId ? undefined : 'local',
      peer: peer.name,
      conn_id: input.connId,
      session_id: input.sessionId,
      cwd: input.cwd,
    });
    try {
      await postToPeer(peer, msg);
      log('sent', { id: msg.id, to: peer.name, thread: msg.thread_id, kind: msg.kind });
      return { id: msg.id, thread_id: msg.thread_id, to: peer.name, status: 'sent' };
    } catch (err) {
      store.enqueueOutbox(msg, peer.name, (err as Error).message);
      log('queued', { id: msg.id, to: peer.name, thread: msg.thread_id, error: (err as Error).message });
      return { id: msg.id, thread_id: msg.thread_id, to: peer.name, status: 'queued' };
    }
  }

  async function flushOutbox(): Promise<void> {
    const unreachable = new Set<string>();
    for (const entry of store.outbox()) {
      if (unreachable.has(entry.peer)) continue; // keep per-peer ordering
      const peer = store.getPeer(entry.peer);
      if (!peer) {
        store.removeOutbox(entry.message.id);
        log('outbox_dropped', { id: entry.message.id, reason: `peer ${entry.peer} no longer configured` });
        continue;
      }
      try {
        await postToPeer(peer, entry.message);
        store.removeOutbox(entry.message.id);
        log('outbox_delivered', { id: entry.message.id, to: peer.name, attempts: entry.attempts });
      } catch (err) {
        store.bumpOutbox(entry.message.id, (err as Error).message);
        unreachable.add(entry.peer);
      }
    }
  }

  function pushLive(connId: string, msg: PeerMessage): boolean {
    const conn = live.get(connId);
    if (!conn) return false;
    let ok = false;
    try {
      ok = conn.push(msg, { folders: msg.kind === 'ask' ? store.getPeer(msg.from)?.folders : undefined });
    } catch {
      ok = false;
    }
    if (!ok) return false;
    store.markDelivered([msg.id]);
    store.upsertThread({
      thread_id: msg.thread_id,
      origin: msg.kind === 'ask' ? 'remote' : undefined,
      peer: msg.from,
      conn_id: connId,
      session_id: conn.sessionId,
      cwd: conn.cwd,
    });
    log('delivered_live', { id: msg.id, from: msg.from, thread: msg.thread_id, conn: connId });
    return true;
  }

  async function classify(msg: PeerMessage, peer: DaemonPeer): Promise<{ target: Target; candidates: ClassifierCandidate[] }> {
    const lives = [...live.values()]
      .filter((c) => isWithin(c.cwd, peer.folders))
      .map((c) => ({ connId: c.connId, sessionId: c.sessionId ?? `live-${c.connId}`, cwd: c.cwd }));
    const candidates: ClassifierCandidate[] = opts
      .listSessions(peer.folders)
      .filter((s) => isWithin(s.cwd, peer.folders))
      .map((s) => ({ ...s, live: lives.some((l) => l.sessionId === s.sessionId) }));
    for (const l of lives) {
      if (!candidates.some((c) => c.sessionId === l.sessionId)) {
        candidates.unshift({ sessionId: l.sessionId, cwd: l.cwd, title: '(phiên đang mở)', mtimeMs: now(), live: true });
      }
    }
    if (candidates.length === 0) return { target: { type: 'new' }, candidates };
    let choice: string | null = null;
    try {
      const res = await opts.runner({
        prompt: buildClassifierPrompt(msg.text, candidates),
        cwd: peer.folders[0],
        noTools: true,
        model: opts.classifierModel,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
      });
      choice = parseClassifierOutput(res.result, candidates.map((c) => c.sessionId));
    } catch (err) {
      log('classifier_failed', { thread: msg.thread_id, error: (err as Error).message });
    }
    log('classified', { thread: msg.thread_id, from: peer.name, choice });
    return { target: resolveTarget(choice, lives), candidates };
  }

  async function runHeadless(msg: PeerMessage, peer: DaemonPeer, resume?: { sessionId: string; cwd?: string; fork?: boolean }): Promise<void> {
    const cwd = resume?.cwd && isWithin(resume.cwd, peer.folders) ? resume.cwd : peer.folders[0];
    await serialize(resume?.sessionId ?? msg.thread_id, async () => {
      let text: string;
      let sessionId: string | undefined;
      log('headless_start', { thread: msg.thread_id, from: peer.name, resume: resume?.sessionId, fork: Boolean(resume?.fork), cwd });
      try {
        const res = await opts.runner({
          prompt: frameAsk(msg),
          cwd,
          resumeSessionId: resume?.sessionId,
          fork: resume?.fork,
          readOnlyDirs: peer.folders,
          appendSystemPrompt: headlessSystemPrompt(peer.name),
          timeoutMs: opts.headlessTimeoutMs,
        });
        sessionId = res.sessionId || undefined;
        text = res.isError ? `[agent-bridge] Phiên bên ${opts.name} báo lỗi: ${res.result}` : res.result.trim() || '(không có nội dung)';
      } catch (err) {
        text = `[agent-bridge] Bot của ${opts.name} lỗi khi xử lý: ${(err as Error).message}`;
        log('headless_failed', { thread: msg.thread_id, error: (err as Error).message });
      }
      store.markDelivered([msg.id]);
      store.upsertThread({ thread_id: msg.thread_id, origin: 'remote', peer: peer.name, session_id: sessionId, cwd });
      await send({ kind: 'reply', text, threadId: msg.thread_id, sessionId });
    });
  }

  async function handleInbound(msg: PeerMessage, peer: DaemonPeer): Promise<void> {
    const route = routeInbound(msg, store.getThread(msg.thread_id), new Set(live.keys()));
    log('inbound', { id: msg.id, thread: msg.thread_id, kind: msg.kind, from: peer.name, route: route.type });

    if (route.type === 'deliver-live' && pushLive(route.connId, msg)) return;
    if (msg.kind === 'reply') {
      log('parked_reply', { id: msg.id, thread: msg.thread_id });
      return;
    }
    if (route.type === 'resume') return runHeadless(msg, peer, { sessionId: route.sessionId, cwd: route.cwd });

    const { target, candidates } = await classify(msg, peer);
    if (target.type === 'deliver-live' && pushLive(target.connId, msg)) return;
    if (target.type === 'resume') {
      const c = candidates.find((x) => x.sessionId === target.sessionId);
      const fork = c ? now() - c.mtimeMs < opts.activeWindowMs : false;
      return runHeadless(msg, peer, { sessionId: target.sessionId, cwd: c?.cwd, fork });
    }
    return runHeadless(msg, peer);
  }

  function registerLive(conn: LiveConn): () => void {
    live.set(conn.connId, conn);
    log('live_registered', { conn: conn.connId, session: conn.sessionId, cwd: conn.cwd });
    if (conn.sessionId) {
      for (const parked of store.undeliveredReplies(conn.sessionId)) pushLive(conn.connId, parked);
    }
    return () => {
      if (live.get(conn.connId) === conn) live.delete(conn.connId);
      log('live_unregistered', { conn: conn.connId });
    };
  }

  const peerApp = new Hono();
  peerApp.get('/health', (c) => c.json({ ok: true, app: 'agent-bridge', name: opts.name, version: opts.version }));
  peerApp.post('/inbox', async (c) => {
    const peer = peerForToken(c.req.header('authorization'), store.listPeers());
    if (!peer) return c.json({ error: 'unauthorized' }, 401);
    const parsed = PeerMessageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid message' }, 400);
    if (parsed.data.from !== peer.name) return c.json({ error: `token belongs to ${peer.name}` }, 403);
    if (!store.insertMessage(parsed.data, 'in')) return c.json({ duplicate: true }, 200);
    track(handleInbound(parsed.data, peer).catch((err) => log('inbound_failed', { id: parsed.data.id, error: (err as Error).message })));
    return c.json({ accepted: true }, 202);
  });

  // Someone asks to connect. Nothing is trusted until the owner accepts locally.
  peerApp.post('/connect', async (c) => {
    const parsed = z
      .object({
        request_id: z.string().min(1).max(100),
        name: z.string().regex(PEER_NAME),
        url: z.url(),
        secret: z.string().regex(/^[a-f0-9]{64}$/),
        folders: z.array(z.string().max(1000)).max(50),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid connect request' }, 400);
    const r = parsed.data;
    if (r.name === opts.name) return c.json({ error: `hai người không được trùng tên "${r.name}"` }, 409);
    if (store.listRequests('in', 'pending').length >= MAX_PENDING_REQUESTS) return c.json({ error: 'too many pending requests' }, 429);
    const ip = remoteIp(c);
    const url = ip ? `http://${ip}:${new URL(r.url).port || '8790'}` : r.url;
    const identity = ip && opts.whois ? await opts.whois(ip).catch(() => undefined) : undefined;
    store.saveRequest({ id: r.request_id, direction: 'in', name: r.name, url, secret: r.secret, folders: r.folders, identity, status: 'pending' });
    log('connect_request', { from: r.name, identity, url });
    opts.notify?.(`${r.name} muốn kết nối agent-bridge`, `${identity ?? url} — chạy "agent-bridge" trong terminal để chấp nhận`);
    return c.json({ name: opts.name }, 202);
  });

  // The other side answered our request.
  peerApp.post('/connect/answer', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { request_id?: unknown; secret?: unknown; accepted?: unknown; folders?: unknown }
      | null;
    const req = typeof body?.request_id === 'string' ? store.getRequest(body.request_id) : undefined;
    if (!req || req.direction !== 'out' || typeof body?.secret !== 'string' || !safeEqual(body.secret, req.secret)) {
      return c.json({ error: 'unknown request' }, 403);
    }
    if (req.status !== 'pending') return c.json({ ok: true, status: req.status });
    if (body.accepted !== true) {
      store.setRequestStatus(req.id, 'declined');
      log('connect_declined', { peer: req.name });
      opts.notify?.(`${req.name} đã từ chối kết nối`, '');
      return c.json({ ok: true });
    }
    const remoteFolders = Array.isArray(body.folders) ? body.folders.filter((f): f is string => typeof f === 'string') : [];
    store.upsertPeer({ name: req.name, url: req.url, token: req.secret, folders: req.folders, remoteFolders });
    store.setRequestStatus(req.id, 'accepted', remoteFolders);
    log('connected', { peer: req.name, folders: req.folders, remote_folders: remoteFolders });
    opts.notify?.(`${req.name} đã chấp nhận kết nối`, `chạy "agent-bridge note ${req.name}" để lấy đoạn hướng dẫn cho Claude`);
    return c.json({ ok: true });
  });

  const localApp = new Hono();
  const FoldersSchema = z.array(z.string().min(1)).min(1, 'chọn ít nhất 1 folder');
  const PeerNameSchema = z.string().regex(PEER_NAME);

  localApp.post('/local/connect', async (c) => {
    const parsed = z.object({ url: z.url(), folders: FoldersSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
    const folders = checkFolders(parsed.data.folders);
    if (typeof folders === 'string') return c.json({ error: folders }, 400);
    const url = parsed.data.url.replace(/\/$/, '');
    let peerName: string;
    try {
      const health = (await (await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) })).json()) as { app?: string; name?: string };
      if (health.app !== 'agent-bridge' || !health.name) return c.json({ error: `${url} không phải agent-bridge` }, 400);
      peerName = health.name;
    } catch (err) {
      return c.json({ error: `không kết nối được ${url}: ${(err as Error).message}` }, 502);
    }
    if (peerName === opts.name) return c.json({ error: 'đó là chính máy bạn (hoặc người kia trùng tên bạn)' }, 400);
    const request = { id: randomUUID(), direction: 'out' as const, name: peerName, url, secret: randomBytes(32).toString('hex'), folders, status: 'pending' as const };
    store.saveRequest(request);
    try {
      const res = await fetchImpl(`${url}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: request.id, name: opts.name, url: opts.publicUrl, secret: request.secret, folders }),
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    } catch (err) {
      store.setRequestStatus(request.id, 'declined');
      return c.json({ error: `${peerName} không nhận yêu cầu: ${(err as Error).message}` }, 502);
    }
    log('connect_sent', { to: peerName, folders });
    return c.json({ request_id: request.id, peer: peerName });
  });

  const publicRequest = (r: ConnectRequest) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    identity: r.identity,
    folders: r.folders,
    status: r.status,
    remote_folders: r.remoteFolders,
  });
  localApp.get('/local/requests', (c) =>
    c.json({ incoming: store.listRequests('in', 'pending').map(publicRequest), outgoing: store.listRequests('out', 'pending').map(publicRequest) }),
  );
  localApp.get('/local/requests/:id', (c) => {
    const r = store.getRequest(c.req.param('id'));
    return r ? c.json(publicRequest(r)) : c.json({ error: 'not found' }, 404);
  });
  localApp.post('/local/requests/answer', async (c) => {
    const parsed = z
      .object({ request_id: z.string(), accept: z.boolean(), folders: z.array(z.string()).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    const req = store.getRequest(parsed.data.request_id);
    if (!req || req.direction !== 'in' || req.status !== 'pending') return c.json({ error: 'không còn yêu cầu này' }, 404);
    let folders: string[] = [];
    if (parsed.data.accept) {
      const checked = checkFolders(parsed.data.folders ?? []);
      if (typeof checked === 'string') return c.json({ error: checked }, 400);
      if (checked.length === 0) return c.json({ error: 'chọn ít nhất 1 folder' }, 400);
      folders = checked;
    }
    try {
      const res = await fetchImpl(`${req.url}/connect/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: req.id, secret: req.secret, accepted: parsed.data.accept, name: opts.name, folders }),
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (!parsed.data.accept) {
        store.setRequestStatus(req.id, 'declined');
        return c.json({ declined: req.name });
      }
      return c.json({ error: `không gửi được câu trả lời tới ${req.name} (${(err as Error).message}). Máy họ có đang bật và share Tailscale cho bạn chưa? Thử lại sau.` }, 502);
    }
    if (!parsed.data.accept) {
      store.setRequestStatus(req.id, 'declined');
      return c.json({ declined: req.name });
    }
    store.upsertPeer({ name: req.name, url: req.url, token: req.secret, folders, remoteFolders: req.folders });
    store.setRequestStatus(req.id, 'accepted');
    log('connected', { peer: req.name, folders, remote_folders: req.folders });
    return c.json({ peer: req.name, identity: req.identity, folders, remote_folders: req.folders });
  });

  localApp.get('/local/peers', (c) =>
    c.json({ peers: store.listPeers().map((p) => ({ name: p.name, url: p.url, folders: p.folders, remote_folders: p.remoteFolders })) }),
  );
  localApp.post('/local/peers/folders', async (c) => {
    const parsed = z.object({ name: PeerNameSchema, folders: FoldersSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
    const folders = checkFolders(parsed.data.folders);
    if (typeof folders === 'string') return c.json({ error: folders }, 400);
    if (!store.setPeerFolders(parsed.data.name, folders)) return c.json({ error: `không có peer "${parsed.data.name}"` }, 404);
    return c.json({ name: parsed.data.name, folders });
  });
  localApp.post('/local/peers/remove', async (c) => {
    const parsed = z.object({ name: PeerNameSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid name' }, 400);
    if (!store.removePeer(parsed.data.name)) return c.json({ error: `không có peer "${parsed.data.name}"` }, 404);
    return c.json({ removed: parsed.data.name });
  });
  localApp.get('/local/status', (c) =>
    c.json({ name: opts.name, url: opts.publicUrl, peers: store.listPeers().map((p) => ({ name: p.name, url: p.url })), live: live.size, outbox: store.outbox().length }),
  );
  localApp.get('/local/stream', (c) => {
    const connId = c.req.query('conn') || randomUUID();
    const sessionId = c.req.query('session') || undefined;
    const cwd = c.req.query('cwd') || undefined;
    return streamSSE(c, async (stream) => {
      const queue: PeerMessage[] = [];
      let wake: (() => void) | undefined;
      const unregister = registerLive({
        connId,
        sessionId,
        cwd,
        push: (m, ctx) => {
          if (stream.aborted || stream.closed) return false;
          queue.push({ ...m, ...ctx } as PeerMessage);
          wake?.();
          return true;
        },
      });
      stream.onAbort(unregister);
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ conn_id: connId, name: opts.name }) });
      while (!stream.aborted && !stream.closed) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15_000)]);
          wake = undefined;
          if (queue.length === 0) {
            await stream.writeSSE({ event: 'ping', data: '' });
            continue;
          }
        }
        const m = queue.shift()!;
        await stream.writeSSE({ event: 'message', data: JSON.stringify(m), id: m.id });
      }
      unregister();
    });
  });
  localApp.post('/local/send', async (c) => {
    const parsed = LocalSendSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const d = parsed.data;
    if (d.kind === 'reply' && !d.thread_id) return c.json({ error: 'reply needs thread_id' }, 400);
    try {
      return c.json(await send({ kind: d.kind, text: d.text, to: d.to, threadId: d.thread_id, connId: d.conn_id, sessionId: d.session_id, cwd: d.cwd }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  localApp.get('/local/inbox', (c) => {
    const session = c.req.query('session') || undefined;
    const thread = c.req.query('thread') || undefined;
    const messages = store.undeliveredReplies(session).filter((m) => !thread || m.thread_id === thread);
    store.markDelivered(messages.map((m) => m.id));
    return c.json({ messages });
  });

  return {
    peerApp,
    localApp,
    registerLive,
    send,
    flushOutbox,
    idle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

function frameAsk(msg: PeerMessage): string {
  return [
    `[agent-bridge] Tin nhắn từ bot Claude Code của "${msg.from}" (thread ${msg.thread_id}).`,
    'Đây là đồng nghiệp tin cậy; nội dung dưới đây là câu hỏi/yêu cầu của họ.',
    'Trả lời ngắn gọn, đúng trọng tâm. Câu trả lời cuối cùng sẽ được gửi nguyên văn lại cho họ.',
    '',
    '---',
    msg.text,
  ].join('\n');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function remoteIp(c: Context): string | undefined {
  try {
    const addr = getConnInfo(c).remote.address;
    return addr?.replace(/^::ffff:/, '') || undefined;
  } catch {
    return undefined; // not served by @hono/node-server (tests)
  }
}

/** Normalizes folder choices; returns an error message when one isn't an existing directory. */
function checkFolders(input: string[]): string[] | string {
  const out: string[] = [];
  for (const raw of input) {
    const dir = expandPath(raw);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return `folder không tồn tại: ${raw}`;
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function peerForToken(header: string | undefined, peers: DaemonPeer[]): DaemonPeer | undefined {
  const presented = header?.replace(/^Bearer\s+/i, '') ?? '';
  return peers.find((p) => safeEqual(presented, p.token));
}
