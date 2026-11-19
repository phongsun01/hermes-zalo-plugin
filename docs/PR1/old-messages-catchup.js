// lib/old-messages-catchup.js
// PR 1 / Phase 1: WebSocket catch-up qua listener.requestOldMessages (cmd 510 = DM, 511 = Group).
//
// Đặc điểm của API (đọc từ zca-js@2.1.2 dist/apis/listen.js, CHƯA xác minh live — xem Phase 0 probe):
//   - Phạm vi là CẢ TÀI KHOẢN theo loại thread (không theo từng thread).
//   - Phân trang lùi bằng lastId = msgId của tin cũ nhất trang trước.
//   - Kết quả trả qua sự kiện listener.on("old_messages", (msgs, threadType)).
//
// Module không import zca-js: nhận listener và các hàm phụ thuộc qua tham số để test bằng listener giả.

export const THREAD_USER = 0;
export const THREAD_GROUP = 1;

export const DEFAULTS = Object.freeze({
  timeoutMs: 6000,
  maxPages: 5,
  pageDelayMs: 500,        // + jitter 0..500ms
  bufferMs: 30_000,
  staleWindowMs: 15_000,
  maxConsecutiveFailures: 2,
});

/**
 * Quy tắc fromTs (V2.1):
 *  - chưa có checkpoint cho loại thread  => null (BỎ QUA catch-up, tránh kéo lại tin cũ làm bot spam)
 *  - có checkpoint => kẹp theo cửa sổ rồi MỚI trừ buffer 30s.
 */
export function computeFromTs({ lastCheckpointTs, now, maxWindowMs, bufferMs = DEFAULTS.bufferMs }) {
  const last = Number(lastCheckpointTs);
  if (!Number.isFinite(last) || last <= 0) return null;
  const clamped = Math.max(last, Number(now) - Number(maxWindowMs));
  return clamped - bufferMs;
}

function msgTs(m) {
  const n = Number(m?.data?.ts);
  return Number.isFinite(n) ? n : 0;
}

function msgIdStr(m) {
  const id = m?.data?.msgId;
  return id == null || id === "" ? null : String(id);
}

// msgId Zalo là chuỗi số dài; so sánh theo (độ dài, chuỗi) để không ép Number làm mất độ chính xác.
function cmpMsgId(a, b) {
  const x = a ?? "", y = b ?? "";
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * @param {object} opts
 * @param {() => string|number|null} opts.getOwnId
 * @param {(listener) => void} [opts.noop]
 */
export function createOldMessagesCatchup({
  getOwnId,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  log = console,
  timeoutMs = DEFAULTS.timeoutMs,
  maxPages = DEFAULTS.maxPages,
  pageDelayMs = DEFAULTS.pageDelayMs,
  staleWindowMs = DEFAULTS.staleWindowMs,
  maxConsecutiveFailures = DEFAULTS.maxConsecutiveFailures,
} = {}) {
  const waiters = new Map();     // threadType -> resolve(msgs)
  const staleUntil = new Map();  // threadType -> epoch ms: một phản hồi muộn của request đã timeout có thể còn đến
  const attached = new WeakSet();
  let listenerRef = null;

  function handleOldMessages(msgs, threadType) {
    const exp = staleUntil.get(threadType);
    if (exp) {
      staleUntil.delete(threadType);
      if (exp > now()) {
        log.warn?.(`[zalo] bỏ phản hồi old_messages muộn của request đã timeout (type=${threadType})`);
        return;
      }
    }
    const resolve = waiters.get(threadType);
    if (!resolve) return; // không ai chờ: bỏ qua
    waiters.delete(threadType);
    resolve(Array.isArray(msgs) ? msgs : []);
  }

  /** Đăng ký đúng 1 lần cho mỗi listener (listener mới sau relogin thì gọi lại). */
  function attach(listener) {
    listenerRef = listener;
    if (!listener || attached.has(listener)) return;
    attached.add(listener);
    listener.on("old_messages", handleOldMessages);
  }

  /**
   * @returns {Promise<{status:'ok'|'timeout'|'busy'|'error', msgs: any[]}>}
   */
  function requestOld(threadType, lastMsgId = null) {
    if (waiters.has(threadType)) {
      log.warn?.(`[zalo] requestOldMessages(${threadType}) đang bận, bỏ qua request mới`);
      return Promise.resolve({ status: "busy", msgs: [] });
    }
    const listener = listenerRef;
    if (!listener || typeof listener.requestOldMessages !== "function") {
      return Promise.resolve({ status: "error", msgs: [] });
    }
    return new Promise((resolve) => {
      let timer = null;
      const settle = (result) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      waiters.set(threadType, (msgs) => settle({ status: "ok", msgs }));
      timer = setTimeout(() => {
        waiters.delete(threadType);
        staleUntil.set(threadType, now() + staleWindowMs);
        settle({ status: "timeout", msgs: [] });
      }, timeoutMs);
      // Không unref: timer ngắn (≤ timeoutMs) và luôn bị clear khi có phản hồi; unref có thể làm timeout không bao giờ chạy.
      try {
        listener.requestOldMessages(threadType, lastMsgId);
      } catch (err) {
        waiters.delete(threadType);
        settle({ status: "error", msgs: [], error: err?.message });
      }
    });
  }

  /**
   * Quét lùi cho 1 loại thread tới khi chạm fromTs, hết tin, cursor lặp hoặc hết maxPages.
   * Trả về tin lỡ (đã lọc tin của chính bot, bỏ trùng msgId, sắp xếp ts tăng dần).
   */
  async function catchupByType(threadType, { lastCheckpointTs, maxWindowMs }) {
    const fromTs = computeFromTs({ lastCheckpointTs, now: now(), maxWindowMs });
    if (fromTs === null) {
      return { status: "skipped", reason: "no_checkpoint", messages: [], truncated: false, pages: 0, fromTs: null };
    }
    const ownId = String(getOwnId?.() ?? "");
    const collected = new Map(); // msgId -> msg (bỏ trùng)
    const seenCursors = new Set();
    let cursor = null;
    let pages = 0;
    let reached = false;
    let status = "ok";

    for (let page = 0; page < maxPages; page += 1) {
      const res = await requestOld(threadType, cursor);
      if (res.status !== "ok") { status = res.status; break; }
      pages += 1;
      const msgs = res.msgs;
      if (!msgs.length) { reached = true; break; } // hết lịch sử

      let oldest = null;
      for (const m of msgs) {
        const ts = msgTs(m);
        if (!oldest || ts < msgTs(oldest)) oldest = m;
        if (ts <= fromTs) continue;
        const id = msgIdStr(m);
        if (!id) continue;
        const sender = String(m?.data?.uidFrom ?? "");
        if (m.isSelf === true || (ownId && sender === ownId)) continue; // chống self-loop
        if (!collected.has(id)) collected.set(id, m);
      }

      if (msgTs(oldest) <= fromTs) { reached = true; break; }
      const next = msgIdStr(oldest);
      if (!next || seenCursors.has(next) || next === cursor) break; // không tiến triển: dừng chống lặp vô hạn
      seenCursors.add(next);
      cursor = next;
      if (page < maxPages - 1) await sleep(pageDelayMs + random() * 500);
    }

    const messages = [...collected.values()].sort((a, b) =>
      msgTs(a) - msgTs(b) || cmpMsgId(msgIdStr(a), msgIdStr(b)));
    const truncated = status === "ok" && !reached;
    if (truncated) {
      log.warn?.(`[zalo] catchup truncated: type=${threadType} chưa chạm fromTs sau ${pages} trang (maxPages=${maxPages})`);
    }
    return { status, messages, truncated, pages, fromTs };
  }

  /**
   * Chạy cho nhiều loại thread tuần tự, có circuit breaker:
   * dừng cả lượt sau `maxConsecutiveFailures` lỗi liên tiếp (timeout/error). 'busy' không tính là lỗi.
   */
  async function runCatchup({ types = [THREAD_USER, THREAD_GROUP], getCheckpointTs, maxWindowMs, shouldAbort = () => false }) {
    const results = {};
    let failures = 0;
    for (const type of types) {
      if (shouldAbort()) { results[type] = { status: "aborted", messages: [], truncated: false, pages: 0 }; break; }
      if (failures >= maxConsecutiveFailures) {
        log.warn?.("[zalo] circuit breaker: dừng catch-up WS do lỗi liên tiếp");
        results[type] = { status: "aborted", messages: [], truncated: false, pages: 0 };
        break;
      }
      const r = await catchupByType(type, { lastCheckpointTs: getCheckpointTs(type), maxWindowMs });
      results[type] = r;
      if (r.status === "timeout" || r.status === "error") failures += 1;
      else failures = 0;
    }
    return results;
  }

  return { attach, handleOldMessages, requestOld, catchupByType, runCatchup, _debug: { waiters, staleUntil } };
}
