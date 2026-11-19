import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createOldMessagesCatchup, isValidCheckpoint, THREAD_USER, THREAD_GROUP,
} from "../lib/old-messages-catchup.js";

const OWN = "356803217338268195";
const NOW = 10_000_000;
const WINDOW = 7_200_000; // windowStart = 2_800_000
const silent = { warn() {}, log() {}, error() {} };
const noSleep = () => Promise.resolve();

const msg = (id, ts, from = "111", extra = {}) => ({
  threadId: "t1", isSelf: false, data: { msgId: String(id), ts: String(ts), uidFrom: from, ...extra },
});

/** Server giả theo ngữ nghĩa ĐÃ QUAN SÁT: trả tối đa pageSize tin SAU lastId (loại tin lastId), cũ → mới. */
function forwardServer(list, pageSize = 50) {
  return (lastId) => {
    const idx = lastId == null ? -1 : list.findIndex((m) => m.data.msgId === String(lastId));
    if (lastId != null && idx === -1) return [];
    return list.slice(idx + 1, idx + 1 + pageSize);
  };
}

/** Listener giả: handlers[type] là hàm (lastId) => msgs | undefined (undefined = không phản hồi) hoặc mảng handler theo lượt. */
function fakeListener(handlers = {}) {
  const l = new EventEmitter();
  l.calls = [];
  l.requestOldMessages = (type, lastId) => {
    l.calls.push({ type, lastId });
    let h = handlers[type];
    if (Array.isArray(h)) h = h.shift();
    if (!h) return;
    const out = h(lastId);
    if (out !== undefined) queueMicrotask(() => l.emit("old_messages", out, type));
  };
  return l;
}

function make(listener, over = {}) {
  const c = createOldMessagesCatchup({
    getOwnId: () => OWN, now: () => NOW, sleep: noSleep, random: () => 0, log: silent,
    timeoutMs: 40, maxPages: 5, maxRounds: 3, ...over,
  });
  c.attach(listener);
  return c;
}
const cp = (msgId, ts = 9_000_000) => ({ msgId: String(msgId), ts });
const ids = (r) => r.messages.map((m) => m.data.msgId);
// n tin: id = 1000+i, ts = 9_000_000 + i*1000
const series = (n, from = "111") => Array.from({ length: n }, (_, i) => msg(1000 + i, 9_000_000 + i * 1000, from));

test("isValidCheckpoint", () => {
  assert.equal(isValidCheckpoint({ msgId: "1", ts: 5 }), true);
  for (const bad of [null, undefined, {}, { msgId: "", ts: 5 }, { msgId: "1", ts: 0 }, { msgId: null, ts: 5 }, { msgId: "1", ts: NaN }]) {
    assert.equal(isValidCheckpoint(bad), false);
  }
});

test("Chưa có checkpoint => bỏ qua catch-up, không gửi request nào", async () => {
  const l = fakeListener();
  const c = make(l);
  for (const bad of [undefined, null, { msgId: "", ts: 5 }, { msgId: "9", ts: 0 }]) {
    const r = await c.catchupByType(THREAD_USER, { checkpoint: bad, maxWindowMs: WINDOW });
    assert.equal(r.status, "skipped");
    assert.equal(r.reason, "no_checkpoint");
  }
  assert.equal(l.calls.length, 0);
});

test("Timeout => giải phóng waiter, trả status timeout, không treo", async () => {
  const l = fakeListener({ [THREAD_USER]: () => undefined });
  const c = make(l);
  const r = await c.catchupByType(THREAD_USER, { checkpoint: cp(1000), maxWindowMs: WINDOW });
  assert.equal(r.status, "timeout");
  assert.equal(c._debug.waiters.size, 0);
  assert.equal(r.truncated, false);
});

test("Đồng bộ tiến: bắt đầu bằng msgId checkpoint (không null), lấy hết các tin sau đó theo thứ tự tăng dần", async () => {
  const all = series(120);
  const l = fakeListener({ [THREAD_USER]: forwardServer(all, 50) });
  const r = await make(l, { maxPages: 10 }).catchupByType(THREAD_USER, { checkpoint: cp(1009), maxWindowMs: WINDOW });
  assert.equal(l.calls[0].lastId, "1009", "request đầu phải dùng msgId checkpoint");
  assert.equal(r.messages.length, 110);                // 1010..1119
  assert.equal(ids(r)[0], "1010");
  assert.equal(ids(r).at(-1), "1119");
  assert.equal(r.truncated, false);
  assert.equal(r.pages, 4);                            // 50 + 50 + 10 + trang rỗng
  // cursor kế tiếp là tin MỚI NHẤT của trang trước
  assert.deepEqual(l.calls.map((c) => c.lastId), ["1009", "1059", "1109", "1119"]);
});

test("Thứ tự trong trang không quan trọng (cũ→mới hoặc mới→cũ đều cho cùng kết quả, ts tăng dần)", async () => {
  const all = series(20);
  for (const flip of [false, true]) {
    const server = forwardServer(all, 50);
    const l = fakeListener({ [THREAD_USER]: (id) => (flip ? server(id).reverse() : server(id)) });
    const r = await make(l).catchupByType(THREAD_USER, { checkpoint: cp(1004), maxWindowMs: WINDOW });
    assert.equal(ids(r)[0], "1005");
    assert.equal(ids(r).at(-1), "1019");
    const ts = r.messages.map((m) => Number(m.data.ts));
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  }
});

test("Hết tin mới: trang chỉ chứa tin mốc hoặc đã thấy => reached, không truncated", async () => {
  const all = series(3);
  const l = fakeListener({ [THREAD_GROUP]: [
    () => all.slice(0, 3),          // trang 1: 1000(mốc, bị loại),1001,1002
    () => [all[2]],                 // trang 2: server trả lại tin cuối => không có gì mới
  ] });
  const r = await make(l).catchupByType(THREAD_GROUP, { checkpoint: cp(1000), maxWindowMs: WINDOW });
  assert.deepEqual(ids(r), ["1001", "1002"]);
  assert.equal(r.truncated, false);
});

test("Tin của chính bot bị loại (isSelf / uidFrom === ownId) nhưng VẪN dùng để tiến cursor", async () => {
  const list = [
    msg(2001, 9_000_100, OWN),
    { ...msg(2002, 9_000_200, "999"), isSelf: true },
    msg(2003, 9_000_300, OWN),
  ];
  const l = fakeListener({ [THREAD_USER]: [
    () => list,                                   // toàn tin của bot
    (id) => { assert.equal(id, "2003", "cursor phải tiến qua tin của bot"); return [msg(2004, 9_000_400, "222")]; },
    () => [],
  ] });
  const r = await make(l).catchupByType(THREAD_USER, { checkpoint: cp(2000), maxWindowMs: WINDOW });
  assert.deepEqual(ids(r), ["2004"]);
});

test("Tin quá cửa sổ bị bỏ nhưng vẫn phân trang tiếp để tới tin mới", async () => {
  const old = [msg(1, 1_000_000), msg(2, 1_100_000)];     // < windowStart 2_800_000
  const fresh = [msg(3, 9_500_000)];
  const l = fakeListener({ [THREAD_USER]: [() => old, () => fresh, () => []] });
  const r = await make(l).catchupByType(THREAD_USER, { checkpoint: cp(1, 500), maxWindowMs: WINDOW });
  assert.deepEqual(ids(r), ["3"]);
});

test("Bị cắt trang: truncated + resumeCursor, và catchupType tự chạy tiếp các vòng sau, không mất/không trùng tin", async () => {
  const all = series(100);                          // 100 tin, 10 tin/trang, maxPages 3 => 30 tin/vòng
  const l = fakeListener({ [THREAD_USER]: forwardServer(all, 10) });
  const c = make(l, { maxPages: 3, maxRounds: 5 });

  const one = await c.catchupByType(THREAD_USER, { checkpoint: cp(1000), maxWindowMs: WINDOW });
  assert.equal(one.truncated, true);
  assert.equal(one.messages.length, 30);
  assert.equal(one.resumeCursor, "1030");

  const l2 = fakeListener({ [THREAD_USER]: forwardServer(all, 10) });
  const full = await make(l2, { maxPages: 3, maxRounds: 5 }).catchupType(THREAD_USER, {
    getCheckpoint: () => cp(1000), maxWindowMs: WINDOW,
  });
  assert.equal(full.messages.length, 99);           // 1001..1099
  assert.equal(new Set(ids(full)).size, 99);
  assert.equal(full.truncated, false);
  assert.ok(full.rounds >= 4);
});

test("Hết maxRounds mà vẫn còn tin => truncated=true được báo ra", async () => {
  const l = fakeListener({ [THREAD_USER]: forwardServer(series(100), 10) });
  const r = await make(l, { maxPages: 2, maxRounds: 2 }).catchupType(THREAD_USER, {
    getCheckpoint: () => cp(1000), maxWindowMs: WINDOW,
  });
  assert.equal(r.truncated, true);
  assert.equal(r.messages.length, 40);
});

test("Server không tiến triển (cursor mới đã thấy) => dừng, không lặp vô hạn", async () => {
  const stuck = [msg(7, 9_500_000), msg(6, 9_400_000)];   // newest=7; lần sau cursor=7 trả đúng lại cặp này
  const l = fakeListener({ [THREAD_USER]: () => stuck });
  const r = await make(l, { maxPages: 10 }).catchupByType(THREAD_USER, { checkpoint: cp(5), maxWindowMs: WINDOW });
  assert.ok(l.calls.length <= 3, `quá nhiều request: ${l.calls.length}`);
  assert.deepEqual(ids(r), ["6", "7"]);
});

test("Bỏ tin trùng msgId; ts dạng chuỗi hoặc số đều chạy", async () => {
  const l = fakeListener({ [THREAD_USER]: [
    () => [msg(9, 9_900_000), { ...msg(8, 9_800_000), data: { msgId: "8", ts: 9_800_000, uidFrom: "1" } }, msg(9, 9_900_000)],
    () => [],
  ] });
  const r = await make(l).catchupByType(THREAD_USER, { checkpoint: cp(1), maxWindowMs: WINDOW });
  assert.deepEqual(ids(r), ["8", "9"]);
});

test("Waiter bận => request thứ 2 bị từ chối, không ghi đè waiter cũ", async () => {
  const l = fakeListener({ [THREAD_USER]: () => undefined });
  const c = make(l, { timeoutMs: 80 });
  const first = c.requestOld(THREAD_USER, "1");
  const second = await c.requestOld(THREAD_USER, "1");
  assert.equal(second.status, "busy");
  assert.equal(l.calls.length, 1);
  l.emit("old_messages", [msg(1, 1)], THREAD_USER);
  const r1 = await first;
  assert.equal(r1.status, "ok");
  assert.equal(r1.msgs.length, 1);
});

test("Phản hồi muộn của request đã timeout bị bỏ, không làm hỏng request kế tiếp", async () => {
  const l = fakeListener({ [THREAD_USER]: [() => undefined, () => [msg(1, 9_900_000)]] });
  const c = make(l);
  assert.equal((await c.requestOld(THREAD_USER, "0")).status, "timeout");
  l.emit("old_messages", [msg(999, 999)], THREAD_USER); // phản hồi muộn: phải bị bỏ
  const r = await c.requestOld(THREAD_USER, "0");
  assert.equal(r.status, "ok");
  assert.equal(r.msgs[0].data.msgId, "1");
});

test("runCatchup: bỏ qua loại chưa có checkpoint, vẫn chạy loại còn lại", async () => {
  const l = fakeListener({ [THREAD_GROUP]: [() => [msg(5, 9_900_000)], () => []] });
  const r = await make(l).runCatchup({
    getCheckpoint: (t) => (t === THREAD_GROUP ? cp(1) : null), maxWindowMs: WINDOW,
  });
  assert.equal(r[THREAD_USER].status, "skipped");
  assert.deepEqual(ids(r[THREAD_GROUP]), ["5"]);
});

test("runCatchup: circuit breaker dừng sau 2 lỗi liên tiếp", async () => {
  const l = fakeListener({ 0: () => undefined, 1: () => undefined });
  const r = await make(l).runCatchup({
    types: [0, 1, 1], getCheckpoint: () => cp(1), maxWindowMs: WINDOW,
  });
  assert.equal(l.calls.length, 2, "request thứ 3 không được gửi");
  assert.equal(r[0].status, "timeout");
});

test("runCatchup: shouldAbort dừng ngay", async () => {
  const l = fakeListener({ 0: () => [] });
  const r = await make(l).runCatchup({ getCheckpoint: () => cp(1), maxWindowMs: WINDOW, shouldAbort: () => true });
  assert.equal(l.calls.length, 0);
  assert.equal(r[0].status, "aborted");
});

test("attach chỉ đăng ký 1 lần cho cùng listener", () => {
  const l = fakeListener();
  const c = make(l);
  c.attach(l); c.attach(l);
  assert.equal(l.listenerCount("old_messages"), 1);
});
