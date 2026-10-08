import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function createExecutionJournal({ directory, maxRequests = 50000, maxSessions = 256, retainedResults = 1000 }) {
  for (const limit of [maxRequests, maxSessions, retainedResults]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_storage_limit");
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "effects.sqlite"));
  const token = randomUUID();
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  try {
    db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    db.exec("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY, home TEXT NOT NULL, writes INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runtime_owner (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)");
    const columns = db.prepare("PRAGMA table_info(requests)").all().map((column) => column.name);
    if (!columns.includes("checkpoint")) db.exec("ALTER TABLE requests ADD COLUMN checkpoint TEXT");
    transaction(() => {
      const owner = db.prepare("SELECT * FROM runtime_owner WHERE id=1").get();
      if (owner) {
        try { process.kill(owner.pid, 0); throw new Error("household_in_use"); }
        catch (error) { if (error.code !== "ESRCH") throw new Error("household_in_use"); }
      }
      db.prepare("INSERT OR REPLACE INTO runtime_owner VALUES (1,?,?)").run(process.pid, token);
    });
  } catch (error) { db.close(); throw error; }

  return {
    getRequest: (id) => db.prepare("SELECT * FROM requests WHERE id=?").get(id),
    getState(id) { const row = db.prepare("SELECT state FROM conversations WHERE id=?").get(id); return row ? JSON.parse(row.state) : undefined; },
    initializeState(id, state) {
      if (!this.getState(id)) {
        if (db.prepare("SELECT count(*) AS n FROM conversations").get().n >= maxSessions) throw new Error("session_capacity_reached");
        db.prepare("INSERT INTO conversations VALUES (?,?)").run(id, JSON.stringify(state));
      }
      return this.getState(id);
    },
    admit(id, fingerprint) {
      if (db.prepare("SELECT count(*) AS n FROM requests").get().n >= maxRequests) throw new Error("request_capacity_reached");
      db.prepare("INSERT INTO requests (id,fingerprint,status) VALUES (?,?,'admitted')").run(id, fingerprint);
    },
    prepare(id, decision) { db.prepare("UPDATE requests SET status='prepared', checkpoint=? WHERE id=?").run(JSON.stringify(decision), id); },
    beginEffect(id) { db.prepare("UPDATE requests SET status='effect_started' WHERE id=?").run(id); },
    complete(request, result, state) {
      return transaction(() => {
        let committed;
        if (state) {
          const previous = this.getState(request.sessionId);
          if ((state.revision ?? 0) !== (previous?.revision ?? 0)) throw new Error("conversation_revision_conflict");
          committed = { ...state, revision: (previous?.revision ?? 0) + 1 };
          db.prepare("INSERT OR REPLACE INTO conversations VALUES (?,?)").run(request.sessionId, JSON.stringify(committed));
        }
        db.prepare("UPDATE requests SET status='complete', result=?, checkpoint=NULL WHERE id=?").run(JSON.stringify(result), request.commandId);
        // Keep identity tombstones: dropping an old result must never authorize replay.
        db.prepare("UPDATE requests SET status='compacted', result=NULL WHERE status='complete' AND rowid NOT IN (SELECT rowid FROM requests WHERE status='complete' ORDER BY rowid DESC LIMIT ?)").run(retainedResults);
        return committed;
      });
    },
    getWorld: () => db.prepare("SELECT * FROM world WHERE id=1").get(),
    saveWorld(home, writes) { db.prepare("INSERT OR REPLACE INTO world VALUES (1,?,?)").run(JSON.stringify(home), writes); },
    stats() {
      return { requests: db.prepare("SELECT count(*) AS n FROM requests").get().n, retainedResults: db.prepare("SELECT count(*) AS n FROM requests WHERE result IS NOT NULL").get().n, conversations: db.prepare("SELECT count(*) AS n FROM conversations").get().n, maxRequests, maxSessions };
    },
    close() {
      try { db.prepare("DELETE FROM runtime_owner WHERE token=?").run(token); }
      finally { db.close(); }
    },
  };
}
