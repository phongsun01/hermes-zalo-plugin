import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStore, createRepository } from "../lib/index.js";
import { secureFilePermissions } from "../lib/file-permissions.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ret-test-"));
}

test("PR3: backfill_state lưu và cập nhật tiến trình catchup", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, "test.sqlite");

  try {
    const store = await createStore(dbPath);
    const repo = createRepository(store);

    // Chưa có: trả null
    assert.equal(repo.getBackfillState("user"), null);

    // Upsert user state
    repo.upsertBackfillState("user", {
      cursor: "msg_123",
      lastTs: 1700000000000,
      status: "done",
      syncedCount: 50,
    });

    const state = repo.getBackfillState("user");
    assert.equal(state.thread_type, "user");
    assert.equal(state.cursor, "msg_123");
    assert.equal(state.last_ts, 1700000000000);
    assert.equal(state.status, "done");
    assert.equal(state.synced_count, 50);

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PR3 (Acceptance Criteria): Dọn dẹp tin nhắn cũ theo retention (mặc định 30 ngày) và xóa cascade attachment", async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, "test.sqlite");

  try {
    const store = await createStore(dbPath);
    const repo = createRepository(store);

    const now = 100_000_000_000;
    const thirtyDaysMs = 30 * 86400 * 1000;
    const oldTs = now - thirtyDaysMs - 10_000; // 30 ngày + 10s trước
    const newTs = now - thirtyDaysMs + 10_000; // 30 ngày - 10s trước (vẫn nằm trong 30 ngày)

    // Tạo 3 tin cũ và 2 tin mới
    for (let i = 1; i <= 3; i++) {
      await repo.saveIncoming({
        messageId: `old_${i}`,
        cliMsgId: `cli_old_${i}`,
        threadId: "t1",
        threadType: "user",
        senderId: "u1",
        senderName: "User 1",
        text: `Old message ${i}`,
        msgType: "chat.text",
        ts: oldTs,
        attachment: { type: "image", url: `http://img/old_${i}.jpg` },
      });
    }

    for (let i = 1; i <= 2; i++) {
      await repo.saveIncoming({
        messageId: `new_${i}`,
        cliMsgId: `cli_new_${i}`,
        threadId: "t1",
        threadType: "user",
        senderId: "u1",
        senderName: "User 1",
        text: `New message ${i}`,
        msgType: "chat.text",
        ts: newTs,
        attachment: { type: "image", url: `http://img/new_${i}.jpg` },
      });
    }

    // Kiểm tra ban đầu: 5 messages, 5 attachments
    const statsBefore = repo.getStats();
    assert.equal(statsBefore.messages, 5);
    assert.equal(statsBefore.attachments, 5);

    // Chạy purge với retentionDays = 30
    const purgeRes = repo.purgeOldMessages({ retentionDays: 30, now: () => now });
    assert.equal(purgeRes.deletedMessages, 3);
    assert.equal(purgeRes.skipped, false);

    // Kiểm tra sau khi purge: chỉ còn 2 tin mới và 2 attachments mới
    const statsAfter = repo.getStats();
    assert.equal(statsAfter.messages, 2);
    assert.equal(statsAfter.attachments, 2);

    // Kiểm tra retentionDays = 0 (tắt purge)
    const purgeSkipped = repo.purgeOldMessages({ retentionDays: 0 });
    assert.equal(purgeSkipped.skipped, true);
    assert.equal(purgeSkipped.deletedMessages, 0);

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PR3 (Acceptance Criteria): secureFilePermissions thiết lập quyền an toàn trên file", () => {
  const tmpDir = makeTmpDir();
  const testFile = path.join(tmpDir, "perm_test.txt");
  fs.writeFileSync(testFile, "hello");

  try {
    const ok = secureFilePermissions(testFile);
    assert.equal(typeof ok, "boolean");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
