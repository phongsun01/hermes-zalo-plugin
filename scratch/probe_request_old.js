// scratch/probe_request_old.js — Phase 0: kiểm chứng listener.requestOldMessages trên Zalo thật.
//
// CÁCH CHẠY (từ thư mục gốc repo, khi BRIDGE ĐÃ TẮT):
//     node scratch/probe_request_old.js
//     node scratch/probe_request_old.js --start-listener   # chỉ dùng nếu login() không tự start listener
//
// Gửi tối đa 3 request: DM trang 1, DM trang 2 (cursor), Group trang 1.
// CHỈ in metadata. Không bao giờ in nội dung tin nhắn, tên hay UID người khác.

import net from "node:net";
import { ZaloClient } from "../zaloClient.js";
import { credentialsPath, qrPath, cliMsgDir } from "../paths.js";

const PORT = Number(process.env.ZALO_BRIDGE_PORT || process.env.PORT || 8787);
const REQUEST_TIMEOUT_MS = 8000;
const READY_TIMEOUT_MS = 20000;
const startListener = process.argv.includes("--start-listener");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function summarise(label, threadType, msgs, ownId, extra = {}) {
  const arr = Array.isArray(msgs) ? msgs : [];
  const tsRaw = arr.map((m) => m?.data?.ts);
  const tsNum = tsRaw.map(Number).filter(Number.isFinite);
  let order = "n/a";
  if (tsNum.length >= 2) {
    const desc = tsNum.every((v, i) => i === 0 || tsNum[i - 1] >= v);
    const asc = tsNum.every((v, i) => i === 0 || tsNum[i - 1] <= v);
    order = desc && asc ? "equal" : desc ? "descending (mới→cũ)" : asc ? "ascending (cũ→mới)" : "mixed";
  }
  const ids = arr.map((m) => m?.data?.msgId);
  return {
    label,
    threadType,
    count: arr.length,
    tsType: [...new Set(tsRaw.map((v) => typeof v))].join(",") || "n/a",
    tsMin: tsNum.length ? Math.min(...tsNum) : null,
    tsMax: tsNum.length ? Math.max(...tsNum) : null,
    tsLooksLikeMs: tsNum.length ? tsNum.every((v) => v > 1e11) : null,
    order,
    msgIdType: [...new Set(ids.map((v) => typeof v))].join(",") || "n/a",
    distinctMsgIds: new Set(ids.map(String)).size,
    selfByFlag: arr.filter((m) => m?.isSelf === true).length,
    selfByUid: arr.filter((m) => String(m?.data?.uidFrom ?? "") === String(ownId)).length,
    distinctThreads: new Set(arr.map((m) => String(m?.threadId ?? ""))).size,
    ...extra,
  };
}

async function main() {
  if (await portInUse(PORT)) {
    console.error(`[probe] Cổng ${PORT} đang được dùng: có thể bridge đang chạy.`);
    console.error("[probe] Tắt bridge trước (Zalo chỉ cho 1 listener/tài khoản; chạy song song sẽ gây lỗi 3000 Duplicate Connection). Dừng.");
    process.exit(2);
  }

  const client = new ZaloClient({
    credentialsPath: credentialsPath(), qrPath: qrPath(), selfListen: false,
    cliMsgDir: cliMsgDir(), cliMsgRetentionDays: 30, infoCacheTtlMs: 600000, infoMinIntervalMs: 1500,
  });
  await client.login({ forceQR: false });
  const api = client.api;
  const listener = api?.listener;
  const ownId = client.ownId;
  if (!listener || typeof listener.requestOldMessages !== "function") {
    console.error("[probe] listener.requestOldMessages không tồn tại ở bản zca-js này.");
    await client.shutdown?.(); process.exit(3);
  }

  if (startListener && !(listener.ws && listener.ws.readyState === 1)) {
    listener.start({ retryOnClose: false });
  }
  const t0 = Date.now();
  while (!(listener.ws && listener.ws.readyState === 1)) {
    if (Date.now() - t0 > READY_TIMEOUT_MS) {
      console.error("[probe] WebSocket chưa sẵn sàng (readyState !== 1) sau 20s.");
      console.error("[probe] Nếu login() không tự start listener, chạy lại với --start-listener.");
      await client.shutdown?.(); process.exit(4);
    }
    await sleep(250);
  }
  await sleep(1500); // chờ handshake/cipherKey ổn định trước khi bắn frame

  const results = [];
  const ask = (threadType, lastId) => new Promise((resolve) => {
    const timer = setTimeout(() => { listener.off("old_messages", onOld); resolve(null); }, REQUEST_TIMEOUT_MS);
    const onOld = (msgs, type) => {
      if (type !== threadType) return;
      clearTimeout(timer); listener.off("old_messages", onOld); resolve(msgs);
    };
    listener.on("old_messages", onOld);
    listener.requestOldMessages(threadType, lastId);
  });
  const oldest = (msgs) => [...msgs].sort((a, b) => Number(a.data.ts) - Number(b.data.ts))[0];

  // Ngữ nghĩa đã quan sát (DM): lastId = "các tin SAU lastId", loại tin lastId. Probe này kiểm tra lại cho DM và, quan trọng,
  // kiểm tra lần đầu cho GROUP. Tối đa 4 request: (DM, Group) x (trang 1 với null, trang 2 với cursor).
  const newest = (msgs) => [...msgs].sort((a, b) => Number(a.data.ts) - Number(b.data.ts)).at(-1);
  async function probeType(label, threadType) {
    const p1 = await ask(threadType, null);
    results.push(p1 ? summarise(`${label} trang 1 (lastId=null)`, threadType, p1, ownId) : { label: `${label} trang 1`, timedOut: true });
    if (!p1 || !p1.length) return;
    await sleep(2000);
    // cursor = tin GIỮA trang 1 (không phải cũ nhất/mới nhất) để phân biệt rõ tiến/lùi
    const sorted = [...p1].sort((a, b) => Number(a.data.ts) - Number(b.data.ts));
    const c = sorted[Math.floor(sorted.length / 2)];
    const cTs = Number(c.data.ts), cId = String(c.data.msgId);
    const p2 = await ask(threadType, cId);
    if (!p2) { results.push({ label: `${label} trang 2 (cursor giữa trang 1)`, timedOut: true }); return; }
    const ts2 = p2.map((m) => Number(m.data.ts));
    const expectedAfter = sorted.slice(sorted.indexOf(c) + 1).map((m) => String(m.data.msgId));
    results.push(summarise(`${label} trang 2 (cursor giữa trang 1)`, threadType, p2, ownId, {
      forward: {
        allNotOlderThanCursor: ts2.length > 0 && ts2.every((t) => t >= cTs),
        cursorMsgExcluded: !p2.some((m) => String(m.data.msgId) === cId),
        containsAllPage1MsgsAfterCursor: expectedAfter.every((id) => p2.some((m) => String(m.data.msgId) === id)),
        newestAdvancedBeyondPage1: ts2.length > 0 && Math.max(...ts2) > Number(newest(p1).data.ts),
      },
    }));
  }
  await probeType("DM", 0);
  await sleep(2000);
  await probeType("Group", 1);

  console.log(JSON.stringify({ requestsSent: "<=4", ownIdPresent: Boolean(ownId), results }, null, 2));
  console.log("\nĐọc kết quả:");
  console.log("- forward.allNotOlderThanCursor/cursorMsgExcluded/containsAllPage1MsgsAfterCursor = true cho CẢ DM và Group => ngữ nghĩa tiến đúng.");
  console.log("- Nếu Group khác DM (ví dụ lùi hoặc trả cả tin cursor): KHÔNG bật ZALO_CATCHUP_ENGINE=ws cho Group.");
  console.log("- count mỗi trang (kích thước trang thay đổi) và tsLooksLikeMs: dùng chọn ZALO_CATCHUP_MAX_PAGES.");
  console.log("- selfByFlag/selfByUid > 0: bộ lọc self-loop là cần thiết (đúng dự kiến).");
  console.log("- Chưa kiểm tra được ở probe này: cursor là msgId của checkpoint thật cũ hơn nhiều ngày (xem PR1-INTEGRATION.md, bước 3).");

  await client.shutdown?.();
  process.exit(0);
}

main().catch((err) => { console.error("[probe] lỗi:", err?.message || err); process.exit(1); });
