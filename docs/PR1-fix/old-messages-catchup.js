// lib/old-messages-catchup.js  (v2 — đồng bộ TIẾN)
// PR 1 / Phase 1: WebSocket catch-up qua listener.requestOldMessages (cmd 510 = DM, 511 = Group).
//
// Ngữ nghĩa ĐÃ KIỂM CHỨNG bằng probe thật (DM):
//   requestOldMessages(type, lastId) trả các tin SAU lastId (mới hơn), KHÔNG gồm tin lastId.
//   lastId = null  => bắt đầu từ đầu bộ đệm đồng bộ của Zalo (~nhiều ngày trước), KHÔNG phải tin mới nhất.
//   Phạm vi là cả tài khoản theo loại thread; thứ tự trong trang: cũ → mới; kích thước trang thay đổi (17..50).
// CHƯA kiểm chứng: Group với cursor là checkpoint thật; hành vi khi lastId đã quá cũ/không còn trong bộ đệm.
//
// Thuật toán: cursor = msgId checkpoint của loại thread; lặp: gửi cursor → nhận trang → cursor mới = tin MỚI NHẤT
// trong trang; dừng khi trang rỗng / không có tin mới / hết maxPages. Tin quá cửa sổ (maxWindowMs) bị bỏ, tin của
// chính bot bị lọc nhưng vẫn được dùng để tiến cursor.
//
// Cắt trang (truncated) trong đồng bộ tiến nghĩa là THIẾU CÁC TIN MỚI NHẤT, nên có "rounds": nếu bị cắt thì chạy
// tiếp từ resumeCursor tối đa maxRounds vòng.

export const THREAD_USER = 0;
export const THREAD_GROUP = 1;

export const DEFAULTS = Object.freeze({
  timeoutMs: 6000,
  maxPages: 5,             // mỗi vòng
  maxRounds: 3,
  pageDelayMs: 500,        // + jitter 0..500ms
  staleWindowMs: 15_000,
  maxConsecutiveFailures: 2,
});

function msgTs(m) {
  const n = Number(m?.data?.ts);
  return Number.isFinite(n) ? n : 0;
}

function msgIdStr(m) {
  const id = m?.data?.msgId;
  return id == null || id === "" ? null : String(id);
}

// msgId là chuỗi số: so sánh theo (độ dài, chuỗi), không ép Number.
function cmpMsgId(a, b) {
  const x = a ?? "", y = b ?? "";
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

function cmpMsg(a, b) {
  return msgTs(a) - msgTs(b) || cmpMsgId(msgIdStr(a), msgIdStr(b));
}

/** Checkpoint hợp lệ = có msgId và ts > 0. Không hợp lệ => bỏ qua catch-up loại đó. */
export function isValidCheckpoint(cp) {
  return Boolean(cp) && cp.msgId != null && String(cp.msgId) !== "" && Number(cp.ts) > 0;
}

export function createOldMessagesCatchup({
  getOwnId,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  log = console,
  timeoutMs = DEFAULTS.timeoutMs,
  maxPages = DEFAULTS.maxPages,
  maxRounds = DEFAULTS.maxRounds,
  pageDelayMs = DEFAULTS.pageDelayMs,
  staleWindowMs = DEFAULTS.staleWindowMs,
  maxConsecutiveFailures = DEFAULTS.maxConsecutiveFailures,
} = {}) {
  const waiters = new Map();     // threadType -> resolve(msgs)
  const staleUntil = new Map();  // threadType -> epoch ms: phản hồi muộn của request đã timeout còn có thể đến
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
    if (!resolve) return;
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

  /** @returns {Promise<{status:'ok'|'timeout'|'busy'|'error', msgs:any[]}>} */
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
      const settle = (result) => { if (timer) clearTimeout(timer); resolve(result); };
      waiters.set(threadType, (msgs) => settle({ status: "ok", msgs }));
      // Không unref: timer ngắn và luôn bị clear khi có phản hồi.
      timer = setTimeout(() => {
        waiters.delete(threadType);
        staleUntil.set(threadType, now() + staleWindowMs);
        settle({ status: "timeout", msgs: [] });
      }, timeoutMs);
      try {
        listener.requestOldMessages(threadType, lastMsgId);
      } catch (err) {
        waiters.delete(threadType);
        settle({ status: "error", msgs: [], error: err?.message });
      }
    });
  }

  /**
   * Một vòng đồng bộ tiến cho 1 loại thread.
   * @param {{checkpoint?:{msgId:string,ts:number}, cursorOverride?:string|null, maxWindowMs:number}} o
   * @returns {{status, messages, truncated, pages, resumeCursor, startCursor}}
   */
  async function catchupByType(threadType, { checkpoint, cursorOverride = null, maxWindowMs }) {
    const startCursor = cursorOverride != null ? String(cursorOverride)
      : isValidCheckpoint(checkpoint) ? String(checkpoint.msgId) : null;
    if (startCursor === null) {
      return { status: "skipped", reason: "no_checkpoint", messages: [], truncated: false, pages: 0, resumeCursor: null, startCursor: null };
    }
    const windowStart = now() - maxWindowMs;
    const ownId = String(getOwnId?.() ?? "");
    const collected = new Map();
    const seenIds = new Set();
    const seenCursors = new Set([startCursor]);
    let cursor = startCursor;
    let pages = 0;
    let reached = false;
    let status = "ok";

    for (let page = 0; page < maxPages; page += 1) {
      const res = await requestOld(threadType, cursor);
      if (res.status !== "ok") { status = res.status; break; }
      pages += 1;
      if (!res.msgs.length) { reached = true; break; } // hết tin mới

      let fresh = 0;
      let newest = null;
      for (const m of res.msgs) {
        const id = msgIdStr(m);
        if (!id || id === cursor || seenIds.has(id)) continue; // tin mốc / đã thấy / không có id
        seenIds.add(id);
        fresh += 1;
        if (!newest || cmpMsg(m, newest) > 0) newest = m;      // cursor tiến theo cả tin của bot / tin quá cũ
        if (msgTs(m) < windowStart) continue;                   // ngoài cửa sổ catch-up
        const sender = String(m?.data?.uidFrom ?? "");
        if (m.isSelf === true || (ownId && sender === ownId)) continue; // chống self-loop
        collected.set(id, m);
      }
      if (fresh === 0) { reached = true; break; }                // không còn gì mới

      const next = msgIdStr(newest);
      if (seenCursors.has(next)) break;                          // không tiến triển (bất thường): dừng, đánh dấu truncated
      seenCursors.add(next);
      cursor = next;
      if (page < maxPages - 1) await sleep(pageDelayMs + random() * 500);
    }

    const messages = [...collected.values()].sort(cmpMsg);
    const truncated = status === "ok" && !reached;
    if (truncated) {
      log.warn?.(`[zalo] catchup truncated: type=${threadType} dừng sau ${pages} trang khi vẫn còn tin MỚI hơn chưa lấy (resumeCursor=${cursor})`);
    }
    return { status, messages, truncated, pages, resumeCursor: cursor, startCursor };
  }

  /** Nhiều vòng cho 1 loại thread (tiếp tục từ resumeCursor khi bị cắt). */
  async function catchupType(threadType, { getCheckpoint, maxWindowMs, shouldAbort }) {
    const agg = new Map();
    let override = null;
    let pages = 0;
    let rounds = 0;
    let last = null;
    while (rounds < maxRounds) {
      if (rounds > 0 && shouldAbort?.()) break;
      const r = await catchupByType(threadType, { checkpoint: getCheckpoint(threadType), cursorOverride: override, maxWindowMs });
      rounds += 1;
      pages += r.pages;
      for (const m of r.messages) agg.set(msgIdStr(m), m);
      last = r;
      if (r.status !== "ok" || !r.truncated) break;
      if (!r.resumeCursor || r.resumeCursor === r.startCursor) break; // không tiến: tránh vòng lặp
      override = r.resumeCursor;
    }
    return {
      status: last.status, reason: last.reason, messages: [...agg.values()].sort(cmpMsg),
      truncated: Boolean(last.truncated), pages, rounds,
    };
  }

  /**
   * Chạy cho nhiều loại thread tuần tự, có circuit breaker:
   * dừng cả lượt sau `maxConsecutiveFailures` lỗi liên tiếp (timeout/error). 'busy' không tính là lỗi.
   */
  async function runCatchup({ types = [THREAD_USER, THREAD_GROUP], getCheckpoint, maxWindowMs, shouldAbort = () => false }) {
    const results = {};
    let failures = 0;
    for (const type of types) {
      if (shouldAbort()) { results[type] = { status: "aborted", messages: [], truncated: false, pages: 0, rounds: 0 }; break; }
      if (failures >= maxConsecutiveFailures) {
        log.warn?.("[zalo] circuit breaker: dừng catch-up WS do lỗi liên tiếp");
        results[type] = { status: "aborted", messages: [], truncated: false, pages: 0, rounds: 0 };
        break;
      }
      const r = await catchupType(type, { getCheckpoint, maxWindowMs, shouldAbort });
      results[type] = r;
      if (r.status === "timeout" || r.status === "error") failures += 1;
      else failures = 0;
    }
    return results;
  }

  return { attach, handleOldMessages, requestOld, catchupByType, catchupType, runCatchup, _debug: { waiters, staleUntil } };
}
