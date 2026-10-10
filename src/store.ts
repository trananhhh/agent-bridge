import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PeerMessage, ThreadRecord } from './protocol.ts';

export interface PeerRecord {
  name: string;
  url: string;
  token: string;
  folders: string[];
}

export type InviteTake = { ok: true; folders: string[] } | { ok: false; reason: 'unknown' | 'used' | 'expired' };

export interface OutboxEntry {
  message: PeerMessage;
  peer: string;
  attempts: number;
  last_error: string | null;
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
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        secret_hash TEXT PRIMARY KEY,
        folders TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        peer TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  insertMessage(m: PeerMessage, direction: 'in' | 'out'): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, thread_id, direction, sender, kind, text, sent_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.thread_id, direction, m.from, m.kind, m.text, m.sent_at, Date.now());
    return Number(res.changes) > 0;
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
        `INSERT INTO peers (name, url, token, folders, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, token = excluded.token, folders = excluded.folders`,
      )
      .run(p.name, p.url, p.token, JSON.stringify(p.folders), Date.now());
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

  createInvite(secretHash: string, folders: string[], expiresAt: number): void {
    this.db.prepare('INSERT INTO invites (secret_hash, folders, expires_at) VALUES (?, ?, ?)').run(secretHash, JSON.stringify(folders), expiresAt);
  }

  /** Atomically consumes an invite; a second take of the same invite fails with 'used'. */
  takeInvite(secretHash: string, now: number): InviteTake {
    const row = this.db.prepare('SELECT * FROM invites WHERE secret_hash = ?').get(secretHash) as Row | undefined;
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.used_at !== null) return { ok: false, reason: 'used' };
    if (Number(row.expires_at) < now) return { ok: false, reason: 'expired' };
    const res = this.db.prepare('UPDATE invites SET used_at = ? WHERE secret_hash = ? AND used_at IS NULL').run(now, secretHash);
    if (Number(res.changes) === 0) return { ok: false, reason: 'used' };
    return { ok: true, folders: JSON.parse(String(row.folders)) as string[] };
  }

  close(): void {
    this.db.close();
  }
}

function toPeer(r: Row): PeerRecord {
  return { name: String(r.name), url: String(r.url), token: String(r.token), folders: JSON.parse(String(r.folders)) as string[] };
}

function toMessage(r: Row): PeerMessage {
  return {
    id: String(r.id),
    thread_id: String(r.thread_id),
    from: String(r.sender),
    kind: r.kind as PeerMessage['kind'],
    text: String(r.text),
    sent_at: String(r.sent_at),
  };
}
