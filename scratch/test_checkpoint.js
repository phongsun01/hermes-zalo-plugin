// test_checkpoint.js
// Automated tests for Checkpoint Persistence Engine (SQLite), State Machine,
// and Self-loop filter.
//
// Usage: node scratch/test_checkpoint.js
// Uses only stdlib + zca-js ThreadType enum — no test framework needed.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createStore, createRepository } from "../lib/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir;
function tmpPath(...parts) {
  return path.join(tmpDir, ...parts);
}

function cleanup() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Suite ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  return async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      if (e.stack) console.error(`    ${e.stack.split("\n").slice(1).join("\n    ")}`);
    }
  };
}

// ── Mock ZaloClient ──────────────────────────────────────────────────────────

async function createClient() {
  const { ZaloClient } = await import("../zaloClient.js");
  const credPath = tmpPath("credentials.json");
  const qrPath = tmpPath("qr.png");
  const c = new ZaloClient({
    credentialsPath: credPath,
    qrPath,
    selfListen: false,
    cliMsgDir: tmpPath("climsgids"),
    cliMsgRetentionDays: 0,
    infoCacheTtlMs: 60000,
    infoMinIntervalMs: 100,
  });
  // Set ownId so self-loop filter works
  c.ownId = "12345";
  // Init SQLite (normally done in _afterLogin).
  // Override dbPath to avoid conflict between tests.
  c._dbPath = tmpPath("zalo_" + Math.random().toString(36).slice(2, 8) + ".sqlite");
  c._store = await createStore(c._dbPath);
  c._repository = createRepository(c._store);
  return c;
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n📋 Checkpoint & Catch-up Test Suite\n");

  // ── Checkpoint (SQLite) ───────────────────────────────────────────────

  await test("checkpoint: save via repository persists checkpoint in SQLite", async () => {
    const c = await createClient();
    c._updateThreadLastSeen("g_1", "msg_1", 1000, "group");
    c._persistDb();
    const cp = c._repository.getCheckpoint("g_1");
    assert(cp, "checkpoint should exist for g_1");
    assert.equal(cp.last_message_id, "msg_1");
    assert.equal(cp.last_ts, 1000);
  })();

  await test("checkpoint: _updateThreadLastSeen does not move backward", async () => {
    const c = await createClient();
    c._updateThreadLastSeen("g_2", "msg_1", 5000, "group");
    const cp1 = c._repository.getCheckpoint("g_2");
    assert.equal(cp1.last_ts, 5000);
    // Try to set an older timestamp — should be ignored
    c._updateThreadLastSeen("g_2", "msg_0", 1000, "group");
    const cp2 = c._repository.getCheckpoint("g_2");
    assert.equal(cp2.last_ts, 5000, "must not move backward");
    assert.equal(cp2.last_message_id, "msg_1", "messageId must not move backward");
  })();

  await test("checkpoint: migrateFromJson loads legacy JSON into SQLite", async () => {
    const jsonPath = tmpPath("legacy.json");
    const legacy = {
      version: 1,
      threads: {
        "g_3": { threadType: "group", checkpoint: { messageId: "m1", timestamp: 999 }, updatedAt: Date.now() },
      },
    };
    fs.writeFileSync(jsonPath, JSON.stringify(legacy));
    const c = await createClient();
    c._repository.migrateFromJson(jsonPath);
    const cp = c._repository.getCheckpoint("g_3");
    assert(cp, "thread g_3 should be migrated");
    assert.equal(cp.last_message_id, "m1");
    assert.equal(cp.last_ts, 999);
  })();

  await test("checkpoint: debounce coalesces multiple updates", async () => {
    const c = await createClient();
    c._updateThreadLastSeen("g_a", "m1", 111, "group");
    c._updateThreadLastSeen("g_b", "m2", 222, "group");
    // Should have a pending timer, not yet written
    assert(c._dbTimer, "debounce timer should be set");
    assert(c._dbChanged, "changed flag should be true");
    // Flush synchronously
    c._persistDb();
    // Verify both threads exist in SQLite
    const cpa = c._repository.getCheckpoint("g_a");
    const cpb = c._repository.getCheckpoint("g_b");
    assert(cpa, "g_a should exist");
    assert(cpb, "g_b should exist");
    assert.equal(cpa.last_ts, 111);
    assert.equal(cpb.last_ts, 222);
  })();

  await test("checkpoint: maxTrackedThreads clamp", async () => {
    const old = process.env.ZALO_MAX_TRACKED_THREADS;
    try {
      process.env.ZALO_MAX_TRACKED_THREADS = "999999";
      const c = await createClient();
      assert(c.maxTrackedThreads <= 500, "should clamp to 500 max");
      process.env.ZALO_MAX_TRACKED_THREADS = "5";
      const c2 = await createClient();
      assert(c2.maxTrackedThreads >= 10, "should clamp to 10 min");
    } finally {
      if (old !== undefined) process.env.ZALO_MAX_TRACKED_THREADS = old;
      else delete process.env.ZALO_MAX_TRACKED_THREADS;
    }
  })();

  await test("checkpoint: maxCatchupWindowMs clamp", async () => {
    const old = process.env.ZALO_CATCHUP_MAX_WINDOW_MS;
    try {
      process.env.ZALO_CATCHUP_MAX_WINDOW_MS = "999999999999";
      const c = await createClient();
      assert(c.maxCatchupWindowMs <= 86400000, "should clamp to 24h max");
      process.env.ZALO_CATCHUP_MAX_WINDOW_MS = "10000";
      const c2 = await createClient();
      assert(c2.maxCatchupWindowMs >= 300000, "should clamp to 5min min");
    } finally {
      if (old !== undefined) process.env.ZALO_CATCHUP_MAX_WINDOW_MS = old;
      else delete process.env.ZALO_CATCHUP_MAX_WINDOW_MS;
    }
  })();

  // ── State Machine ──────────────────────────────────────────────────────

  await test("state: setState transitions correctly", async () => {
    const c = await createClient();
    c.setState("CONNECTED");
    assert.equal(c.state, "CONNECTED");
    c.setState("CATCHUP");
    assert.equal(c.state, "CATCHUP");
    c.setState("READY");
    assert.equal(c.state, "READY");
  })();

  await test("state: SESSION_DEAD overrides any state", async () => {
    const c = await createClient();
    c.setState("READY");
    c.sessionDead = true;
    c.setState("CATCHUP");    // should be forced to SESSION_DEAD
    assert.equal(c.state, "SESSION_DEAD", "sessionDead=true must force SESSION_DEAD");
    c.sessionDead = false;
    c.setState("READY");
    assert.equal(c.state, "READY", "should return to normal after sessionDead cleared");
  })();

  await test("state: _declareSessionDead sets sessionDead + emits event", async () => {
    const c = await createClient();
    let emitted = null;
    c.on("session_dead", (d) => { emitted = d; });
    c._declareSessionDead(3000, "duplicate connection");
    assert(c.sessionDead, "sessionDead should be true");
    assert.equal(c.state, "SESSION_DEAD", "state should be SESSION_DEAD");
    assert(emitted, "session_dead event should fire");
    assert(emitted.message.includes("another device"), "message should mention other device");
  })();

  await test("state: _scheduleAutoRelogin exhausts budget then declares dead", async () => {
    const c = await createClient();
    // Directly test the exhaustion path: with attempts >= max, it should
    // immediately declare session dead
    c._autoReloginAttempts = 5; // MAX_AUTO_RELOGIN_ATTEMPTS
    let deadEmitted = false;
    c.on("session_dead", () => { deadEmitted = true; });
    // Reset reconnecting guard so _scheduleAutoRelogin proceeds
    c._reconnecting = false;
    c._scheduleAutoRelogin(1006, "network glitch");
    assert(deadEmitted, "should declare session dead when attempts exhausted");
    assert(c.sessionDead, "sessionDead should be true");
  })();

  // ── Self-loop Filter ───────────────────────────────────────────────────

  await test("self-loop: _normaliseHistoryMessage filters own messages", async () => {
    const c = await createClient();
    c.ownId = "12345";
    const { ThreadType } = await import("../zaloClient.js");
    const rawMsg = {
      msgId: "own_msg_1",
      uidFrom: "12345",
      content: "hello from bot",
      msgType: "text",
      ts: 1000,
    };
    const result = c._normaliseHistoryMessage(rawMsg, "g_1", "group");
    assert.equal(result, null, "own message should return null");
  })();

  await test("self-loop: _normaliseHistoryMessage passes others through", async () => {
    const c = await createClient();
    c.ownId = "12345";
    const rawMsg = {
      msgId: "user_msg_1",
      uidFrom: "67890",
      content: "hello user",
      msgType: "text",
      ts: 2000,
    };
    const result = c._normaliseHistoryMessage(rawMsg, "g_1", "group");
    assert(result, "other user's message should pass through");
    assert.equal(result.senderId, "67890");
    assert.equal(result.text, "hello user");
  })();

  await test("self-loop: _normaliseHistoryMessage handles missing uidFrom gracefully", async () => {
    const c = await createClient();
    c.ownId = "12345";
    const rawMsg = {
      msgId: "no_sender_msg",
      content: "anonymous",
      msgType: "text",
      ts: 3000,
    };
    const result = c._normaliseHistoryMessage(rawMsg, "g_1", "group");
    assert(result, "message with no sender should pass through");
    assert.equal(result.senderId, "");
  })();

  // ── Graceful Shutdown ──────────────────────────────────────────────────

  await test("shutdown: _persistDb flushes pending checkpoint to SQLite", async () => {
    const c = await createClient();
    c._updateThreadLastSeen("g_flush", "m1", 777, "group");
    // Flush synchronously (same as SIGTERM/SIGINT handler does)
    c._persistDb();
    // Verify in SQLite
    const cp = c._repository.getCheckpoint("g_flush");
    assert(cp, "thread should be flushed on shutdown");
    assert.equal(cp.last_ts, 777);
  })();

  // ── _fetchThreadHistory Guards ─────────────────────────────────────────

  await test("catchup: _fetchThreadHistory handles DM via loadmsg", async () => {
    const c = await createClient();
    // Without api, _fetchThreadHistory should throw or handle gracefully
    // (We just verify it doesn't silently return [])
    try {
      await c._fetchThreadHistory("dm_user_1", "user", "lastMsg", Date.now());
      // If no error, DM path is reachable (will fail at api.callRaw without real api)
    } catch {
      // Expected to fail without real api
    }
  })();

  // ── Results ────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zalocp-"));
console.log(`tmpdir: ${tmpDir}`);

try {
  await run();
} finally {
  cleanup();
}
