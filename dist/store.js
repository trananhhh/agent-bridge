import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export class BridgeStore {
    db;
    constructor(path) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
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
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        peer TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
        const columns = this.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
        if (!columns.includes('mirror'))
            this.db.exec('ALTER TABLE messages ADD COLUMN mirror TEXT');
    }
    insertMessage(m, direction) {
        const res = this.db
            .prepare(`INSERT OR IGNORE INTO messages (id, thread_id, direction, sender, kind, text, sent_at, received_at, mirror)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(m.id, m.thread_id, direction, m.from, m.kind, m.text, m.sent_at, Date.now(), m.mirror ?? null);
        return Number(res.changes) > 0;
    }
    markDelivered(ids) {
        const stmt = this.db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?');
        for (const id of ids)
            stmt.run(id);
    }
    undeliveredReplies(sessionId) {
        const rows = (sessionId
            ? this.db
                .prepare(`SELECT m.* FROM messages m JOIN threads t ON t.thread_id = m.thread_id
               WHERE m.direction = 'in' AND m.kind = 'reply' AND m.delivered = 0 AND t.session_id = ?
               ORDER BY m.received_at, m.rowid`)
                .all(sessionId)
            : this.db
                .prepare(`SELECT * FROM messages WHERE direction = 'in' AND kind = 'reply' AND delivered = 0
               ORDER BY received_at, rowid`)
                .all());
        return rows.map(toMessage);
    }
    listThreads(limit) {
        const rows = this.db
            .prepare(`SELECT m.thread_id, t.peer, t.origin, t.session_id, COUNT(*) AS count,
           MIN(m.received_at) AS started_at, MAX(m.received_at) AS last_at, MAX(m.rowid) AS last_seq,
           (SELECT f.text FROM messages f WHERE f.thread_id = m.thread_id ORDER BY f.rowid LIMIT 1) AS first_text,
           (SELECT f.sender FROM messages f WHERE f.thread_id = m.thread_id ORDER BY f.rowid LIMIT 1) AS first_sender,
           (SELECT l.kind FROM messages l WHERE l.thread_id = m.thread_id ORDER BY l.rowid DESC LIMIT 1) AS last_kind
         FROM messages m LEFT JOIN threads t ON t.thread_id = m.thread_id
         GROUP BY m.thread_id ORDER BY last_seq DESC LIMIT ?`)
            .all(limit);
        return rows.map((r) => {
            const t = {
                thread_id: String(r.thread_id),
                count: Number(r.count),
                started_at: Number(r.started_at),
                last_at: Number(r.last_at),
                first_text: String(r.first_text),
                first_sender: String(r.first_sender),
                last_kind: r.last_kind,
            };
            if (r.peer)
                t.peer = String(r.peer);
            if (r.origin)
                t.origin = r.origin;
            if (r.session_id)
                t.session_id = String(r.session_id);
            return t;
        });
    }
    /** Thread ids equal to, or starting with, `prefix` (at most 2 — more than one means ambiguous). */
    findThreadIds(prefix) {
        const exact = this.db.prepare('SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1').get(prefix);
        if (exact)
            return [prefix];
        const rows = this.db
            .prepare('SELECT DISTINCT thread_id FROM messages WHERE substr(thread_id, 1, ?) = ? LIMIT 2')
            .all(prefix.length, prefix);
        return rows.map((r) => String(r.thread_id));
    }
    threadMessages(threadId) {
        const rows = this.db.prepare('SELECT rowid AS seq, * FROM messages WHERE thread_id = ? ORDER BY rowid').all(threadId);
        return rows.map(toLogged);
    }
    messagesAfter(seq, limit = 200) {
        const rows = this.db.prepare('SELECT rowid AS seq, * FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?').all(seq, limit);
        return rows.map(toLogged);
    }
    latestSeq() {
        return Number(this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS seq FROM messages').get().seq);
    }
    getThread(threadId) {
        const row = this.db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId);
        if (!row)
            return undefined;
        const rec = { thread_id: String(row.thread_id) };
        if (row.origin)
            rec.origin = row.origin;
        if (row.peer)
            rec.peer = String(row.peer);
        if (row.conn_id)
            rec.conn_id = String(row.conn_id);
        if (row.session_id)
            rec.session_id = String(row.session_id);
        if (row.cwd)
            rec.cwd = String(row.cwd);
        return rec;
    }
    upsertThread(t) {
        this.db
            .prepare(`INSERT INTO threads (thread_id, origin, peer, conn_id, session_id, cwd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET
           origin = COALESCE(threads.origin, excluded.origin),
           peer = COALESCE(threads.peer, excluded.peer),
           conn_id = COALESCE(excluded.conn_id, threads.conn_id),
           session_id = COALESCE(excluded.session_id, threads.session_id),
           cwd = COALESCE(excluded.cwd, threads.cwd),
           updated_at = excluded.updated_at`)
            .run(t.thread_id, t.origin ?? null, t.peer ?? null, t.conn_id ?? null, t.session_id ?? null, t.cwd ?? null, Date.now());
    }
    enqueueOutbox(m, peer, error) {
        this.db
            .prepare('INSERT OR IGNORE INTO outbox (id, payload, peer, last_error, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(m.id, JSON.stringify(m), peer, error, Date.now());
    }
    outbox() {
        const rows = this.db.prepare('SELECT * FROM outbox ORDER BY created_at, rowid').all();
        return rows.map((r) => ({
            message: JSON.parse(String(r.payload)),
            peer: String(r.peer),
            attempts: Number(r.attempts),
            last_error: r.last_error === null ? null : String(r.last_error),
        }));
    }
    bumpOutbox(id, error) {
        this.db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(error, id);
    }
    removeOutbox(id) {
        this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
    }
    upsertPeer(p) {
        this.db
            .prepare(`INSERT INTO peers (name, url, token, folders, remote_folders, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, token = excluded.token, folders = excluded.folders, remote_folders = excluded.remote_folders`)
            .run(p.name, p.url, p.token, JSON.stringify(p.folders), JSON.stringify(p.remoteFolders), Date.now());
    }
    getPeer(name) {
        const row = this.db.prepare('SELECT * FROM peers WHERE name = ?').get(name);
        return row ? toPeer(row) : undefined;
    }
    listPeers() {
        return this.db.prepare('SELECT * FROM peers ORDER BY name').all().map(toPeer);
    }
    setPeerFolders(name, folders) {
        return Number(this.db.prepare('UPDATE peers SET folders = ? WHERE name = ?').run(JSON.stringify(folders), name).changes) > 0;
    }
    removePeer(name) {
        return Number(this.db.prepare('DELETE FROM peers WHERE name = ?').run(name).changes) > 0;
    }
    saveRequest(r) {
        if (r.direction === 'in') {
            this.db.prepare("DELETE FROM requests WHERE direction = 'in' AND name = ? AND status = 'pending' AND id != ?").run(r.name, r.id);
        }
        this.db
            .prepare(`INSERT INTO requests (id, direction, name, url, secret, folders, identity, status, remote_folders, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, remote_folders = excluded.remote_folders`)
            .run(r.id, r.direction, r.name, r.url, r.secret, JSON.stringify(r.folders), r.identity ?? null, r.status, r.remoteFolders ? JSON.stringify(r.remoteFolders) : null, Date.now());
    }
    getRequest(id) {
        const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
        return row ? toRequest(row) : undefined;
    }
    listRequests(direction, status) {
        const rows = (status
            ? this.db.prepare('SELECT * FROM requests WHERE direction = ? AND status = ? ORDER BY created_at, rowid').all(direction, status)
            : this.db.prepare('SELECT * FROM requests WHERE direction = ? ORDER BY created_at, rowid').all(direction));
        return rows.map(toRequest);
    }
    setRequestStatus(id, status, remoteFolders) {
        this.db
            .prepare('UPDATE requests SET status = ?, remote_folders = COALESCE(?, remote_folders) WHERE id = ?')
            .run(status, remoteFolders ? JSON.stringify(remoteFolders) : null, id);
    }
    getKv(key) {
        const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
        return row ? String(row.value) : undefined;
    }
    setKv(key, value) {
        this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    }
    close() {
        this.db.close();
    }
}
function toPeer(r) {
    return {
        name: String(r.name),
        url: String(r.url),
        token: String(r.token),
        folders: JSON.parse(String(r.folders)),
        remoteFolders: JSON.parse(String(r.remote_folders ?? '[]')),
    };
}
function toRequest(r) {
    const req = {
        id: String(r.id),
        direction: r.direction,
        name: String(r.name),
        url: String(r.url),
        secret: String(r.secret),
        folders: JSON.parse(String(r.folders)),
        status: r.status,
    };
    if (r.identity)
        req.identity = String(r.identity);
    if (r.remote_folders)
        req.remoteFolders = JSON.parse(String(r.remote_folders));
    return req;
}
function toLogged(r) {
    return { ...toMessage(r), seq: Number(r.seq), direction: r.direction, received_at: Number(r.received_at) };
}
function toMessage(r) {
    const m = {
        id: String(r.id),
        thread_id: String(r.thread_id),
        from: String(r.sender),
        kind: r.kind,
        text: String(r.text),
        sent_at: String(r.sent_at),
    };
    if (r.mirror)
        m.mirror = String(r.mirror);
    return m;
}
