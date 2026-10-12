import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PeerMessage, ThreadRecord } from './protocol.ts';

export interface PeerRecord {
  name: string;
  url: string;
  token: string;
  /** What this peer may read on this machine. */
  folders: string[];
  /** What the peer lets us read on their machine (informational; they enforce it). */
  remoteFolders: string[];
}

export type RequestStatus = 'pending' | 'accepted' | 'declined';

export interface ConnectRequest {
  id: string;
  direction: 'in' | 'out';
  name: string;
  url: string;
  secret: string;
  /** out: folders we grant them · in: folders they grant us */
  folders: string[];
  identity?: string;
  status: RequestStatus;
  /** out + accepted: folders they granted us */
  remoteFolders?: string[];
}

export interface OutboxEntry {
  message: PeerMessage;
  peer: string;
  attempts: number;
  last_error: string | null;
}

export interface LoggedMessage extends PeerMessage {
  /** Insertion order on this machine; a cursor for following new messages. */
  seq: number;
  direction: 'in' | 'out';
  received_at: number;
  via?: MessageVia;
}

/**
 * Written or approved by this machine's owner (in Telegram), not by the agent on its own.
 * 'owner-in-chat': typed in the shared chat, so it is already visible there.
 */
export type MessageVia = 'owner' | 'owner-in-chat';

export type DraftStatus = 'pending' | 'sent' | 'dropped' | 'replaced' | 'superseded';

/** An answer held back for the owner to send, drop or replace. */
export interface Draft {
  id: string;
  thread_id: string;
  peer: string;
  /** What the agent asks the owner; absent when held because the owner had already answered. */
  question?: string;
  text: string;
  status: DraftStatus;
  resolved_by?: string;
  /** Telegram message carrying the buttons, once posted. */
  posted_message_id?: number;
  /** Status last shown on that post. */
  shown_status?: DraftStatus;
  created_at: number;
}

export interface ThreadSummary {
  thread_id: string;
  peer?: string;
  origin?: 'local' | 'remote';
  /** local: the session that asked · remote: the session that answered here */
  session_id?: string;
  count: number;
  started_at: number;
  last_at: number;
  first_text: string;
  first_sender: string;
  last_kind: PeerMessage['kind'];
}

type Row = Record<string, string | number | null>;

export class BridgeStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        sender TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id);
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        origin TEXT,
        peer TEXT,
        conn_id TEXT,
        session_id TEXT,
        cwd TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS peers (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        folders TEXT NOT NULL,
        remote_folders TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        folders TEXT NOT NULL,
        identity TEXT,
        status TEXT NOT NULL,
        remote_folders TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        peer TEXT NOT NULL,
        question TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_by TEXT,
        posted_message_id INTEGER,
        shown_status TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drafts_thread ON drafts (thread_id, status);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        peer TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    const columns = (this.db.prepare('PRAGMA table_info(messages)').all() as Row[]).map((c) => c.name);
    if (!columns.includes('mirror')) this.db.exec('ALTER TABLE messages ADD COLUMN mirror TEXT');
    if (!columns.includes('via')) this.db.exec('ALTER TABLE messages ADD COLUMN via TEXT');
  }

  insertMessage(m: PeerMessage, direction: 'in' | 'out', via?: MessageVia): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, thread_id, direction, sender, kind, text, sent_at, received_at, mirror, via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.thread_id, direction, m.from, m.kind, m.text, m.sent_at, Date.now(), m.mirror ?? null, via ?? null);
    return Number(res.changes) > 0;
  }

  lastMessage(threadId: string): LoggedMessage | undefined {
    const row = this.db.prepare('SELECT rowid AS seq, * FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1').get(threadId) as Row | undefined;
    return row ? toLogged(row) : undefined;
  }

  insertDraft(d: Pick<Draft, 'id' | 'thread_id' | 'peer' | 'question' | 'text'>): void {
    this.db
      .prepare(`INSERT INTO drafts (id, thread_id, peer, question, text, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
      .run(d.id, d.thread_id, d.peer, d.question ?? null, d.text, Date.now());
  }

  getDraft(id: string): Draft | undefined {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
    return row ? toDraft(row) : undefined;
  }

  pendingDraft(threadId: string): Draft | undefined {
    const row = this.db
      .prepare("SELECT * FROM drafts WHERE thread_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as Row | undefined;
    return row ? toDraft(row) : undefined;
  }

  draftByPost(messageId: number): Draft | undefined {
    const row = this.db.prepare('SELECT * FROM drafts WHERE posted_message_id = ?').get(messageId) as Row | undefined;
    return row ? toDraft(row) : undefined;
  }

  /** Moves a pending draft to `status`. False when it was no longer pending, so two clicks never send twice. */
  resolveDraft(id: string, status: Exclude<DraftStatus, 'pending'>, by: string): boolean {
    return Number(this.db.prepare("UPDATE drafts SET status = ?, resolved_by = ? WHERE id = ? AND status = 'pending'").run(status, by, id).changes) > 0;
  }

  /** Settles every pending draft on a thread; returns their ids. */
  settlePendingDrafts(threadId: string, status: Exclude<DraftStatus, 'pending'>, by: string): string[] {
    const ids = (this.db.prepare("SELECT id FROM drafts WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, rowid").all(threadId) as Row[]).map((r) =>
      String(r.id),
    );
    for (const id of ids) this.resolveDraft(id, status, by);
    return ids;
  }

  reopenDraft(id: string): void {
    this.db.prepare("UPDATE drafts SET status = 'pending', resolved_by = NULL WHERE id = ?").run(id);
  }

  threadDrafts(threadId: string): Draft[] {
    return (this.db.prepare('SELECT * FROM drafts WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as Row[]).map(toDraft);
  }

  /** Asks received since `sinceMs` that were never answered nor handed to a session (e.g. the daemon restarted first). */
  unansweredAsks(sinceMs: number): PeerMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE direction = 'in' AND kind = 'ask' AND delivered = 0 AND received_at >= ? ORDER BY rowid")
      .all(sinceMs) as Row[];
    return rows.map(toMessage);
  }

  unpostedDrafts(): Draft[] {
    return (this.db.prepare('SELECT * FROM drafts WHERE posted_message_id IS NULL ORDER BY created_at, rowid').all() as Row[]).map(toDraft);
  }

  setDraftPosted(id: string, messageId: number): void {
    this.db.prepare("UPDATE drafts SET posted_message_id = ?, shown_status = 'pending' WHERE id = ?").run(messageId, id);
  }

  /** Posted drafts whose status changed since their post was last updated. */
  draftsToRefresh(): Draft[] {
    return (
      this.db.prepare('SELECT * FROM drafts WHERE posted_message_id IS NOT NULL AND status != shown_status ORDER BY created_at, rowid').all() as Row[]
    ).map(toDraft);
  }

  setDraftShown(id: string, status: DraftStatus): void {
    this.db.prepare('UPDATE drafts SET shown_status = ? WHERE id = ?').run(status, id);
  }

  markDelivered(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  undeliveredReplies(sessionId?: string): PeerMessage[] {
    const rows = (
      sessionId
        ? this.db
            .prepare(
              `SELECT m.* FROM messages m JOIN threads t ON t.thread_id = m.thread_id
               WHERE m.direction = 'in' AND m.kind = 'reply' AND m.delivered = 0 AND t.session_id = ?
               ORDER BY m.received_at, m.rowid`,
            )
            .all(sessionId)
        : this.db
            .prepare(
              `SELECT * FROM messages WHERE direction = 'in' AND kind = 'reply' AND delivered = 0
               ORDER BY received_at, rowid`,
            )
            .all()
    ) as Row[];
    return rows.map(toMessage);
  }

  listThreads(limit: number): ThreadSummary[] {
    const rows = this.db
      .prepare(
        `SELECT m.thread_id, t.peer, t.origin, t.session_id, COUNT(*) AS count,
           MIN(m.received_at) AS started_at, MAX(m.received_at) AS last_at, MAX(m.rowid) AS last_seq,
           (SELECT f.text FROM messages f WHERE f.thread_id = m.thread_id ORDER BY f.rowid LIMIT 1) AS first_text,
           (SELECT f.sender FROM messages f WHERE f.thread_id = m.thread_id ORDER BY f.rowid LIMIT 1) AS first_sender,
           (SELECT l.kind FROM messages l WHERE l.thread_id = m.thread_id ORDER BY l.rowid DESC LIMIT 1) AS last_kind
         FROM messages m LEFT JOIN threads t ON t.thread_id = m.thread_id
         GROUP BY m.thread_id ORDER BY last_seq DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => {
      const t: ThreadSummary = {
        thread_id: String(r.thread_id),
        count: Number(r.count),
        started_at: Number(r.started_at),
        last_at: Number(r.last_at),
        first_text: String(r.first_text),
        first_sender: String(r.first_sender),
        last_kind: r.last_kind as PeerMessage['kind'],
      };
      if (r.peer) t.peer = String(r.peer);
      if (r.origin) t.origin = r.origin as ThreadSummary['origin'];
      if (r.session_id) t.session_id = String(r.session_id);
      return t;
    });
  }

  /** Thread ids equal to, or starting with, `prefix` (at most 2 — more than one means ambiguous). */
  findThreadIds(prefix: string): string[] {
    const exact = this.db.prepare('SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1').get(prefix);
    if (exact) return [prefix];
    const rows = this.db
      .prepare('SELECT DISTINCT thread_id FROM messages WHERE substr(thread_id, 1, ?) = ? LIMIT 2')
      .all(prefix.length, prefix) as Row[];
    return rows.map((r) => String(r.thread_id));
  }

  threadMessages(threadId: string): LoggedMessage[] {
    const rows = this.db.prepare('SELECT rowid AS seq, * FROM messages WHERE thread_id = ? ORDER BY rowid').all(threadId) as Row[];
    return rows.map(toLogged);
  }

  messagesAfter(seq: number, limit = 200): LoggedMessage[] {
    const rows = this.db.prepare('SELECT rowid AS seq, * FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?').all(seq, limit) as Row[];
    return rows.map(toLogged);
  }

  latestSeq(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS seq FROM messages').get() as Row).seq);
  }

  getThread(threadId: string): ThreadRecord | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId) as Row | undefined;
    if (!row) return undefined;
    const rec: ThreadRecord = { thread_id: String(row.thread_id) };
    if (row.origin) rec.origin = row.origin as ThreadRecord['origin'];
    if (row.peer) rec.peer = String(row.peer);
    if (row.conn_id) rec.conn_id = String(row.conn_id);
    if (row.session_id) rec.session_id = String(row.session_id);
    if (row.cwd) rec.cwd = String(row.cwd);
    return rec;
  }

  upsertThread(t: ThreadRecord): void {
    this.db
      .prepare(
        `INSERT INTO threads (thread_id, origin, peer, conn_id, session_id, cwd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET
           origin = COALESCE(threads.origin, excluded.origin),
           peer = COALESCE(threads.peer, excluded.peer),
           conn_id = COALESCE(excluded.conn_id, threads.conn_id),
           session_id = COALESCE(excluded.session_id, threads.session_id),
           cwd = COALESCE(excluded.cwd, threads.cwd),
           updated_at = excluded.updated_at`,
      )
      .run(t.thread_id, t.origin ?? null, t.peer ?? null, t.conn_id ?? null, t.session_id ?? null, t.cwd ?? null, Date.now());
  }

  enqueueOutbox(m: PeerMessage, peer: string, error: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO outbox (id, payload, peer, last_error, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, JSON.stringify(m), peer, error, Date.now());
  }

  outbox(): OutboxEntry[] {
    const rows = this.db.prepare('SELECT * FROM outbox ORDER BY created_at, rowid').all() as Row[];
    return rows.map((r) => ({
      message: JSON.parse(String(r.payload)) as PeerMessage,
      peer: String(r.peer),
      attempts: Number(r.attempts),
      last_error: r.last_error === null ? null : String(r.last_error),
    }));
  }

  bumpOutbox(id: string, error: string): void {
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(error, id);
  }

  removeOutbox(id: string): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  upsertPeer(p: PeerRecord): void {
    this.db
      .prepare(
        `INSERT INTO peers (name, url, token, folders, remote_folders, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, token = excluded.token, folders = excluded.folders, remote_folders = excluded.remote_folders`,
      )
      .run(p.name, p.url, p.token, JSON.stringify(p.folders), JSON.stringify(p.remoteFolders), Date.now());
  }

  getPeer(name: string): PeerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM peers WHERE name = ?').get(name) as Row | undefined;
    return row ? toPeer(row) : undefined;
  }

  listPeers(): PeerRecord[] {
    return (this.db.prepare('SELECT * FROM peers ORDER BY name').all() as Row[]).map(toPeer);
  }

  setPeerFolders(name: string, folders: string[]): boolean {
    return Number(this.db.prepare('UPDATE peers SET folders = ? WHERE name = ?').run(JSON.stringify(folders), name).changes) > 0;
  }

  removePeer(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM peers WHERE name = ?').run(name).changes) > 0;
  }

  saveRequest(r: ConnectRequest): void {
    if (r.direction === 'in') {
      this.db.prepare("DELETE FROM requests WHERE direction = 'in' AND name = ? AND status = 'pending' AND id != ?").run(r.name, r.id);
    }
    this.db
      .prepare(
        `INSERT INTO requests (id, direction, name, url, secret, folders, identity, status, remote_folders, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, remote_folders = excluded.remote_folders`,
      )
      .run(
        r.id,
        r.direction,
        r.name,
        r.url,
        r.secret,
        JSON.stringify(r.folders),
        r.identity ?? null,
        r.status,
        r.remoteFolders ? JSON.stringify(r.remoteFolders) : null,
        Date.now(),
      );
  }

  getRequest(id: string): ConnectRequest | undefined {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return row ? toRequest(row) : undefined;
  }

  listRequests(direction: 'in' | 'out', status?: RequestStatus): ConnectRequest[] {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM requests WHERE direction = ? AND status = ? ORDER BY created_at, rowid').all(direction, status)
        : this.db.prepare('SELECT * FROM requests WHERE direction = ? ORDER BY created_at, rowid').all(direction)
    ) as Row[];
    return rows.map(toRequest);
  }

  setRequestStatus(id: string, status: RequestStatus, remoteFolders?: string[]): void {
    this.db
      .prepare('UPDATE requests SET status = ?, remote_folders = COALESCE(?, remote_folders) WHERE id = ?')
      .run(status, remoteFolders ? JSON.stringify(remoteFolders) : null, id);
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function toPeer(r: Row): PeerRecord {
  return {
    name: String(r.name),
    url: String(r.url),
    token: String(r.token),
    folders: JSON.parse(String(r.folders)) as string[],
    remoteFolders: JSON.parse(String(r.remote_folders ?? '[]')) as string[],
  };
}

function toRequest(r: Row): ConnectRequest {
  const req: ConnectRequest = {
    id: String(r.id),
    direction: r.direction as ConnectRequest['direction'],
    name: String(r.name),
    url: String(r.url),
    secret: String(r.secret),
    folders: JSON.parse(String(r.folders)) as string[],
    status: r.status as RequestStatus,
  };
  if (r.identity) req.identity = String(r.identity);
  if (r.remote_folders) req.remoteFolders = JSON.parse(String(r.remote_folders)) as string[];
  return req;
}

function toLogged(r: Row): LoggedMessage {
  const m: LoggedMessage = { ...toMessage(r), seq: Number(r.seq), direction: r.direction as LoggedMessage['direction'], received_at: Number(r.received_at) };
  if (r.via) m.via = r.via as MessageVia;
  return m;
}

function toDraft(r: Row): Draft {
  const d: Draft = {
    id: String(r.id),
    thread_id: String(r.thread_id),
    peer: String(r.peer),
    text: String(r.text),
    status: r.status as DraftStatus,
    created_at: Number(r.created_at),
  };
  if (r.question !== null) d.question = String(r.question);
  if (r.resolved_by !== null) d.resolved_by = String(r.resolved_by);
  if (r.posted_message_id !== null) d.posted_message_id = Number(r.posted_message_id);
  if (r.shown_status !== null) d.shown_status = r.shown_status as DraftStatus;
  return d;
}

function toMessage(r: Row): PeerMessage {
  const m: PeerMessage = {
    id: String(r.id),
    thread_id: String(r.thread_id),
    from: String(r.sender),
    kind: r.kind as PeerMessage['kind'],
    text: String(r.text),
    sent_at: String(r.sent_at),
  };
  if (r.mirror) m.mirror = String(r.mirror);
  return m;
}
