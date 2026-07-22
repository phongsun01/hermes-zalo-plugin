import initSqlJs from "sql.js";
import fs from "fs";
import path from "path";

const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  // v1: initial schema
  [
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      thread_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'incoming',
      text TEXT DEFAULT '',
      msg_type TEXT DEFAULT '',
      ts INTEGER NOT NULL,
      content_json TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      url TEXT DEFAULT '',
      thumbnail TEXT DEFAULT '',
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      file_name TEXT DEFAULT '',
      FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      thread_type TEXT NOT NULL,
      last_message_id TEXT DEFAULT '',
      last_ts INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT PRIMARY KEY,
      display_name TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      updated_at INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_msg TEXT DEFAULT '',
      started_at INTEGER DEFAULT 0,
      completed_at INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_state_status ON sync_state(status)`,
    `PRAGMA user_version = 1`,
  ],
  // v2: compound key message_uid (threadId:msgId), atomic persist
  [
    // Recreate messages with message_uid
    `CREATE TABLE IF NOT EXISTS messages_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_uid TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL,
      thread_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'incoming',
      text TEXT DEFAULT '',
      msg_type TEXT DEFAULT '',
      ts INTEGER NOT NULL,
      content_json TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `INSERT OR IGNORE INTO messages_v2
     SELECT id,
       thread_id || ':' || COALESCE(NULLIF(TRIM(message_id),''), CAST(id AS TEXT)),
       message_id, thread_id, thread_type, sender_id, sender_name,
       direction, text, msg_type, ts, content_json, created_at
     FROM messages`,
    `DROP TABLE IF EXISTS messages`,
    `ALTER TABLE messages_v2 RENAME TO messages`,
    `DROP TABLE IF EXISTS attachments`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_uid TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      url TEXT DEFAULT '',
      thumbnail TEXT DEFAULT '',
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      file_name TEXT DEFAULT '',
      FOREIGN KEY (message_uid) REFERENCES messages(message_uid) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_message_uid ON messages(message_uid)`,
    `PRAGMA user_version = 2`,
  ],
];

export async function createStore(dbPath) {
  const SQL = await initSqlJs();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let db;
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA journal_mode = MEMORY");
  db.run("PRAGMA foreign_keys = ON");

  const version = db.exec("PRAGMA user_version")[0]?.values[0][0] || 0;
  if (version < SCHEMA_VERSION) {
    for (let i = version; i < SCHEMA_VERSION; i++) {
      for (const sql of MIGRATIONS[i]) {
        db.run(sql);
      }
    }
  }

  function persist() {
    const data = db.export();
    const tmpPath = dbPath + ".tmp";
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, dbPath);
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // ignore on platforms that don't support chmod
    }
  }

  function run(sql, params = {}) {
    const stmt = db.prepare(sql);
    const result = stmt.run(params);
    stmt.free();
    return result;
  }

  function transaction(fn) {
    db.run("BEGIN IMMEDIATE");
    try {
      const result = fn(db);
      db.run("COMMIT");
      return result;
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  function select(sql, params = {}) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  function selectOne(sql, params = {}) {
    const rows = select(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  function exec(sql) {
    db.run(sql);
  }

  function close() {
    persist();
    db.close();
  }

  const store = {
    dbPath,
    exec,
    run,
    select,
    selectOne,
    transaction,
    persist,
    close,
    get db() {
      return db;
    },
  };

  return store;
}
