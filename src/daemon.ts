import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ClaudeRunner } from './claude-runner.ts';
import { expandPath } from './config.ts';
import { decodeInvite, encodeInvite } from './invite.ts';
import { PeerMessageSchema, type MessageKind, type PeerMessage } from './protocol.ts';
import { buildClassifierPrompt, parseClassifierOutput, resolveTarget, routeInbound, type ClassifierCandidate, type Target } from './router.ts';
import { isWithin, type SessionCandidate } from './sessions.ts';
import type { BridgeStore, PeerRecord } from './store.ts';

/** Peer `folders`: the only directories this peer's questions may be answered from (read-only). First one hosts new sessions. */
type DaemonPeer = PeerRecord;

export interface DaemonOptions {
  name: string;
  /** How peers reach this daemon (http://<tailscale-ip>:<port>); embedded in invite codes. */
  publicUrl: string;
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
const INVITE_TTL_MS = 24 * 3600_000;
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
    if (!name) throw new Error(names.length ? `"to" is required: pick one of ${names.join(', ')}` : 'chưa kết nối với ai (tạo mã mời bằng create_invite)');
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
  peerApp.get('/health', (c) => c.json({ ok: true, name: opts.name }));
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

  peerApp.post('/pair', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { secret?: unknown; name?: unknown; url?: unknown } | null;
    const secret = typeof body?.secret === 'string' ? body.secret : '';
    const name = typeof body?.name === 'string' ? body.name : '';
    const url = typeof body?.url === 'string' ? body.url : '';
    if (!secret || !PEER_NAME.test(name) || !URL.canParse(url)) return c.json({ error: 'invalid pairing request' }, 400);
    if (name === opts.name) return c.json({ error: `bên kia cũng tên "${name}" — hai người phải khác tên` }, 409);
    const taken = store.takeInvite(hashSecret(secret), now());
    if (!taken.ok) {
      const reason = { unknown: 'mã mời không tồn tại (bên mời có thể đã cài lại)', used: 'mã mời đã được dùng', expired: 'mã mời đã hết hạn (24h)' }[taken.reason];
      return c.json({ error: reason }, 410);
    }
    store.upsertPeer({ name, url, token: secret, folders: taken.folders });
    log('paired', { peer: name, url, folders: taken.folders });
    return c.json({ name: opts.name });
  });

  const localApp = new Hono();
  const FoldersSchema = z.array(z.string().min(1)).min(1, 'chọn ít nhất 1 folder');
  const PeerNameSchema = z.string().regex(PEER_NAME);

  localApp.post('/local/invite', async (c) => {
    const parsed = z.object({ folders: FoldersSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
    const folders = checkFolders(parsed.data.folders);
    if (typeof folders === 'string') return c.json({ error: folders }, 400);
    const secret = randomBytes(32).toString('hex');
    const expiresAt = now() + INVITE_TTL_MS;
    store.createInvite(hashSecret(secret), folders, expiresAt);
    log('invite_created', { folders });
    return c.json({ code: encodeInvite({ name: opts.name, url: opts.publicUrl, secret }), folders, expires_at: new Date(expiresAt).toISOString() });
  });

  localApp.post('/local/accept', async (c) => {
    const parsed = z.object({ code: z.string().min(1), folders: FoldersSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
    const folders = checkFolders(parsed.data.folders);
    if (typeof folders === 'string') return c.json({ error: folders }, 400);
    let invite;
    try {
      invite = decodeInvite(parsed.data.code);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (invite.name === opts.name) return c.json({ error: 'đây là mã mời do chính bạn tạo — gửi nó cho người kia' }, 400);
    let res: Response;
    try {
      res = await fetchImpl(`${invite.url.replace(/\/$/, '')}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: invite.secret, name: opts.name, url: opts.publicUrl }),
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
    } catch (err) {
      return c.json({ error: `không kết nối được tới ${invite.name} (${invite.url}): ${(err as Error).message}. Kiểm tra Tailscale (hai máy thấy nhau chưa) và daemon bên kia.` }, 502);
    }
    const body = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
    if (!res.ok) return c.json({ error: body.error ?? `${invite.name} từ chối (${res.status})` }, 400);
    if (body.name !== invite.name) return c.json({ error: `máy ở ${invite.url} tự nhận là "${body.name}", không phải "${invite.name}"` }, 400);
    store.upsertPeer({ name: invite.name, url: invite.url, token: invite.secret, folders });
    log('paired', { peer: invite.name, url: invite.url, folders });
    return c.json({ peer: invite.name, folders });
  });

  localApp.get('/local/peers', (c) => c.json({ peers: store.listPeers().map(({ token: _t, ...p }) => p) }));
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

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
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
  const presented = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  return peers.find((p) => {
    const expected = Buffer.from(p.token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  });
}
