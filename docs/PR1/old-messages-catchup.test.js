import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createOldMessagesCatchup, computeFromTs, THREAD_USER, THREAD_GROUP,
} from "../lib/old-messages-catchup.js";

const OWN = "356803217338268195";
const silent = { warn() {}, log() {}, error() {} };
const noSleep = () => Promise.resolve();

const msg = (id, ts, from = "111", extra = {}) => ({
  threadId: "t1", isSelf: false, data: { msgId: String(id), ts: String(ts), uidFrom: from, ...extra },
});

/** Listener giả: script[type] là mảng handler(lastId) => msgs | undefined (undefined = không phản hồi). */
function fakeListener(script = {}) {
  const l = new EventEmitter();
  l.calls = [];
  l.requestOldMessages = (type, lastId) => {
    l.calls.push({ type, lastId });
    const h = (script[type] || []).shift();
    if (!h) return;
    const out = h(lastId);
    if (out !== undefined) queueMicrotask(() => l.emit("old_messages", out, type));
  };
  return l;
}

function make(listener, over = {}) {
  const c = createOldMessagesCatchup({
    getOwnId: () => OWN, now: () => 10_000_000, sleep: noSleep, random: () => 0, log: silent,
    timeoutMs: 40, maxPages: 5, ...over,
  });
  c.attach(listener);
  return c;
}
const opts = (ts = 9_000_000) => ({ lastCheckpointTs: ts, maxWindowMs: 7_200_000 });

test("computeFromTs: kẹp cửa sổ rồi mới trừ buffer 30s", () => {
  assert.equal(computeFromTs({ lastCheckpointTs: 9_000_000, now: 10_000_000, maxWindowMs: 7_200_000 }), 9_000_000 - 30_000);
  // checkpoint quá cũ: bị kẹp bởi cửa sổ (now - window = 2_800_000), rồi trừ buffer
  assert.equal(computeFromTs({ lastCheckpointTs: 1_000, now: 10_000_000, maxWindowMs: 7_200_000 }), 2_800_000 - 30_000);
});

test("TH6: chưa có checkpoint => bỏ qua catch-up, không gửi request nào", async () => {
  const l = fakeListener();
  const c = make(l);
  for (const bad of [0, null, undefined, -1, NaN]) {
    const r = await c.catchupByType(THREAD_USER, { lastCheckpointTs: bad, maxWindowMs: 7_200_000 });
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "no_checkpoint");
  }
  assert.equal(l.calls.length, 0);
});

test("TH1: timeout => giải phóng waiter, trả status timeout, không treo", async () => {
  const l = fakeListener({ [THREAD_USER]: [() => undefined] });
  const c = make(l);
  const r = await c.catchupByType(THREAD_USER, opts());
  assert.equal(r.status, "timeout");
  assert.equal(c._debug.waiters.size, 0);
  assert.equal(r.truncated, false); // timeout không phải truncated
});

test("TH2: cursor lặp giữa 2 trang => dừng ngay", async () => {
  const page = () => [msg(900, 9_900_000), msg(800, 9_800_000)]; // oldest vẫn > fromTs, cursor = 800 cả hai lần
  const l = fakeListener({ [THREAD_USER]: [page, page, page, page] });
  const c = make(l);
  const r = await c.catchupByType(THREAD_USER, opts());
  assert.equal(l.calls.length, 2, "chỉ 2 request: trang 1 và trang 2 (cursor trùng thì dừng)");
  assert.equal(r.truncated, true);
});

test("TH3: tin của chính bot bị loại (isSelf và uidFrom === ownId, ID 18 chữ số so bằng chuỗi)", async () => {
  const l = fakeListener({ [THREAD_USER]: [() => [
    msg(3, 9_900_000, "222"),
    msg(2, 9_800_000, OWN),
    { ...msg(1, 9_700_000, "999"), isSelf: true },
    msg(0, 8_000_000, "333"), // cũ hơn fromTs: kết thúc
  ]] });
  const c = make(l);
  const r = await c.catchupByType(THREAD_USER, opts());
  assert.deepEqual(r.messages.map((m) => m.data.msgId), ["3"]);
});

test("TH4: trang mới→cũ hoặc cũ→mới đều cho kết quả ts tăng dần", async () => {
  const desc = [msg(5, 9_950_000), msg(4, 9_940_000), msg(3, 9_930_000), msg(1, 8_000_000)];
  const asc = [...desc].reverse();
  for (const order of [desc, asc]) {
    const l = fakeListener({ [THREAD_USER]: [() => order] });
    const r = await make(l).catchupByType(THREAD_USER, opts());
    assert.deepEqual(r.messages.map((m) => m.data.msgId), ["3", "4", "5"]);
  }
});

test("TH5: waiter bận => request thứ 2 bị từ chối, không ghi đè waiter cũ", async () => {
  const l = fakeListener({ [THREAD_USER]: [() => undefined] });
  const c = make(l, { timeoutMs: 80 });
  const first = c.requestOld(THREAD_USER);
  const second = await c.requestOld(THREAD_USER);
  assert.equal(second.status, "busy");
  assert.equal(l.calls.length, 1);
  // phản hồi đến thì waiter cũ vẫn nhận được
  l.emit("old_messages", [msg(1, 1)], THREAD_USER);
  const r1 = await first;
  assert.equal(r1.status, "ok");
  assert.equal(r1.msgs.length, 1);
});

test("Phân trang: dùng msgId cũ nhất làm cursor và dừng khi chạm fromTs", async () => {
  const l = fakeListener({ [THREAD_USER]: [
    () => [msg(50, 9_990_000), msg(40, 9_900_000)],
    (lastId) => { assert.equal(lastId, "40"); return [msg(30, 9_800_000), msg(20, 8_000_000)]; },
    () => { throw new Error("không được gọi trang 3"); },
  ] });
  const r = await make(l).catchupByType(THREAD_USER, opts());
  assert.equal(l.calls.length, 2);
  assert.equal(l.calls[0].lastId, null);
  assert.deepEqual(r.messages.map((m) => m.data.msgId), ["30", "40", "50"]);
  assert.equal(r.truncated, false);
});

test("truncated: hết maxPages mà chưa chạm fromTs", async () => {
  let id = 1000;
  const mk = () => { id -= 10; return [msg(id, 9_900_000 + id)]; };
  const l = fakeListener({ [THREAD_GROUP]: Array.from({ length: 5 }, () => mk) });
  const r = await make(l, { maxPages: 3 }).catchupByType(THREAD_GROUP, opts());
  assert.equal(r.pages, 3);
  assert.equal(r.truncated, true);
});

test("Hết lịch sử (trang rỗng) => không truncated", async () => {
  const l = fakeListener({ [THREAD_GROUP]: [() => [msg(2, 9_900_000)], () => []] });
  const r = await make(l).catchupByType(THREAD_GROUP, opts());
  assert.equal(r.truncated, false);
  assert.equal(r.messages.length, 1);
});

test("Bỏ trùng msgId giữa các trang; ts dạng chuỗi hoặc số đều chạy", async () => {
  const l = fakeListener({ [THREAD_USER]: [
    () => [msg(9, 9_900_000), { ...msg(8, 9_800_000), data: { msgId: "8", ts: 9_800_000, uidFrom: "1" } }],
    () => [msg(8, 9_800_000), msg(7, 8_000_000)],
  ] });
  const r = await make(l).catchupByType(THREAD_USER, opts());
  assert.deepEqual(r.messages.map((m) => m.data.msgId), ["8", "9"]);
});

test("Phản hồi muộn của request đã timeout bị bỏ, không làm hỏng request kế tiếp", async () => {
  let t = 10_000_000;
  const l = fakeListener({ [THREAD_USER]: [() => undefined, () => [msg(1, 9_900_000)]] });
  const c = make(l, { now: () => t });
  assert.equal((await c.requestOld(THREAD_USER)).status, "timeout");
  l.emit("old_messages", [msg(999, 999)], THREAD_USER); // phản hồi muộn: phải bị bỏ
  const r = await c.requestOld(THREAD_USER);
  assert.equal(r.status, "ok");
  assert.equal(r.msgs[0].data.msgId, "1");
});

test("runCatchup: skip loại chưa có checkpoint, vẫn chạy loại còn lại", async () => {
  const l = fakeListener({ [THREAD_GROUP]: [() => [msg(5, 9_900_000), msg(1, 8_000_000)]] });
  const r = await make(l).runCatchup({
    getCheckpointTs: (t) => (t === THREAD_GROUP ? 9_000_000 : 0), maxWindowMs: 7_200_000,
  });
  assert.equal(r[THREAD_USER].status, "skipped");
  assert.equal(r[THREAD_GROUP].messages.length, 1);
});

test("runCatchup: circuit breaker dừng sau 2 lỗi liên tiếp", async () => {
  const l = fakeListener({ 0: [() => undefined], 1: [() => undefined] });
  const c = make(l);
  const r = await c.runCatchup({
    types: [0, 1, 0], getCheckpointTs: () => 9_000_000, maxWindowMs: 7_200_000,
  });
  assert.equal(r[0].status, "aborted"); // lần thứ 3 (key 0 bị ghi đè bởi lần sau) là 'aborted'
  assert.equal(l.calls.length, 2);
});

test("attach chỉ đăng ký 1 lần cho cùng listener", () => {
  const l = fakeListener();
  const c = make(l);
  c.attach(l); c.attach(l);
  assert.equal(l.listenerCount("old_messages"), 1);
});
