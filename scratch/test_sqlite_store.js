// test_sqlite_store.js
// Basic smoke test for SQLite store + repository modules.
// Usage: node scratch/test_sqlite_store.js

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStore, createRepository } from "../lib/index.js";

let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-sqlite-test-"));
function tmpPath(...parts) {
  return path.join(tmpDir, ...parts);
}

async function run() {
  console.log("\n SQLite Store + Repository Smoke Tests\n");

  // 1. Create store
  const dbPath = tmpPath("zalo.sqlite");
  const store = await createStore(dbPath);
  console.log("  ✓ createStore: db created at", dbPath);

  // 2. Verify tables exist
  const tables = store.select("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const tableNames = tables.map((r) => r.name);
  const expected = ["attachments", "friends", "messages", "sync_state", "threads"];
  for (const t of expected) {
    if (!tableNames.includes(t)) throw new Error(`Missing table: ${t}`);
  }
  console.log(`  ✓ tables: ${tableNames.join(", ")}`);

  // 3. Create repository
  const repo = createRepository(store);
  console.log("  ✓ createRepository");

  // 4. saveIncoming (incoming message)
  repo.saveIncoming({
    messageId: "msg_1",
    threadId: "g_1",
    threadType: "group",
    senderId: "user_1",
    senderName: "Alice",
    text: "Hello world",
    msgType: "chat.text",
    ts: 1000,
    isSelf: false,
    attachment: { type: "image", url: "https://example.com/img.jpg", width: 800, height: 600 },
  });
  const msgs = store.select("SELECT * FROM messages");
  if (msgs.length !== 1) throw new Error(`Expected 1 message, got ${msgs.length}`);
  if (msgs[0].direction !== "incoming") throw new Error(`Expected incoming, got ${msgs[0].direction}`);
  console.log("  ✓ saveIncoming: incoming direction");

  // 5. saveIncoming (outgoing = self)
  repo.saveIncoming({
    messageId: "msg_2",
    threadId: "g_1",
    threadType: "group",
    senderId: "bot_1",
    senderName: "Bot",
    text: "Hi Alice",
    msgType: "chat.text",
    ts: 2000,
    isSelf: true,
  });
  const msgs2 = store.select("SELECT * FROM messages ORDER BY ts");
  if (msgs2.length !== 2) throw new Error(`Expected 2 messages`);
  if (msgs2[1].direction !== "outgoing") throw new Error(`Expected outgoing, got ${msgs2[1].direction}`);
  console.log("  ✓ saveIncoming: outgoing direction (self-loop)");

  // 6. Checkpoint auto-upsert
  const cp = repo.getCheckpoint("g_1");
  if (!cp) throw new Error("Checkpoint should exist for g_1");
  if (cp.last_ts !== 2000) throw new Error(`Expected last_ts=2000, got ${cp.last_ts}`);
  console.log("  ✓ checkpoint: auto-upsert via saveIncoming");

  // 7. upsertCheckpoint (backward guard)
  repo.upsertCheckpoint("g_1", "group", "msg_old", 500);
  const cp2 = repo.getCheckpoint("g_1");
  if (cp2.last_ts !== 2000) throw new Error(`Backward guard failed: last_ts should stay 2000, got ${cp2.last_ts}`);
  if (cp2.last_message_id !== "msg_2") throw new Error(`Backward guard failed: last_message_id should stay msg_2`);
  console.log("  ✓ checkpoint: backward TS guard");

  // 8. getContext
  const ctx = repo.getContext("g_1");
  if (ctx.length !== 2) throw new Error(`Expected 2 context messages`);
  if (Number(ctx[0].ts) !== 1000 || Number(ctx[1].ts) !== 2000) throw new Error(`Context order wrong`);
  console.log("  ✓ getContext: ordered by ts ASC");

  // 9. search
  const results = repo.search("Hello");
  if (results.length !== 1) throw new Error(`Expected 1 search result, got ${results.length}`);
  console.log("  ✓ search: LIKE query");

  // 10. saveHistory (batch)
  repo.saveHistory([
    { messageId: "h_1", threadId: "g_1", threadType: "group", senderId: "user_1", text: "Hist 1", ts: 500, isSelf: false },
    { messageId: "h_2", threadId: "g_1", threadType: "group", senderId: "bot_1", text: "Hist 2", ts: 600, isSelf: true },
  ]);
  const allMsgs = store.select("SELECT COUNT(*) as c FROM messages");
  if (allMsgs[0].c !== 4) throw new Error(`Expected 4 total messages, got ${allMsgs[0].c}`);
  console.log("  ✓ saveHistory: batch insert");

  // 11. persist & reload
  store.persist();
  const dbSize = fs.statSync(dbPath).size;
  if (dbSize <= 0) throw new Error("Persisted db is empty");
  console.log("  ✓ persist: file written (" + dbSize + " bytes)");

  // 12. reopen & verify
  store.close();
  const store2 = await createStore(dbPath);
  const repo2 = createRepository(store2);
  const cpReload = repo2.getCheckpoint("g_1");
  if (!cpReload || cpReload.last_ts !== 2000) throw new Error("Checkpoint did not survive restart");
  console.log("  ✓ reopen: checkpoint survives restart");
  store2.close();

  // 13. migrateFromJson
  const jsonPath = tmpPath("thread_checkpoint.json");
  const jsonData = {
    version: 1,
    threads: {
      "g_100": { threadType: "group", checkpoint: { messageId: "j_msg_1", timestamp: 10000 }, updatedAt: Date.now() },
      "u_200": { threadType: "user", checkpoint: { messageId: "j_msg_2", timestamp: 20000 }, updatedAt: Date.now() },
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData));
  const store3 = await createStore(tmpPath("migrated.sqlite"));
  const repo3 = createRepository(store3);
  repo3.migrateFromJson(jsonPath);
  const cpMigrated = repo3.getCheckpoint("g_100");
  if (!cpMigrated || cpMigrated.last_ts !== 10000) throw new Error("Migration failed for g_100");
  console.log("  ✓ migrateFromJson: legacy JSON → SQLite");
  store3.close();

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n ✅ All " + 13 + " tests passed\n");
}

run().catch((e) => {
  console.error("\n ❌ TEST FAILED:", e.message);
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(1);
});
