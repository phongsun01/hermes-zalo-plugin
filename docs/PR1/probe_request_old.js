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

  // 1) DM trang 1
  const dm1 = await ask(0, null);
  results.push(dm1 ? summarise("DM trang 1", 0, dm1, ownId) : { label: "DM trang 1", timedOut: true });

  // 2) DM trang 2 bằng cursor = msgId cũ nhất của trang 1
  await sleep(2000);
  if (dm1 && dm1.length) {
    const o = oldest(dm1);
    const dm2 = await ask(0, String(o.data.msgId));
    const extra = dm2 && dm2.length
      ? { cursorWorked: Math.min(...dm2.map((m) => Number(m.data.ts))) < Number(o.data.ts),
          overlapWithPage1: dm2.filter((m) => dm1.some((x) => String(x.data.msgId) === String(m.data.msgId))).length }
      : {};
    results.push(dm2 ? summarise("DM trang 2 (cursor)", 0, dm2, ownId, extra) : { label: "DM trang 2 (cursor)", timedOut: true });
  } else {
    results.push({ label: "DM trang 2 (cursor)", skipped: "trang 1 rỗng hoặc timeout" });
  }

  // 3) Group trang 1
  await sleep(2000);
  const g1 = await ask(1, null);
  results.push(g1 ? summarise("Group trang 1", 1, g1, ownId) : { label: "Group trang 1", timedOut: true });

  console.log(JSON.stringify({ requestsSent: 3, ownIdPresent: Boolean(ownId), results }, null, 2));
  console.log("\nĐọc kết quả:");
  console.log("- order: quyết định cách chọn cursor/dừng (module catch-up không phụ thuộc thứ tự, nhưng cần biết).");
  console.log("- cursorWorked=true: trang 2 thực sự cũ hơn trang 1. false/thiếu: KHÔNG bật ZALO_CATCHUP_ENGINE=ws.");
  console.log("- count mỗi trang: dùng để chọn ZALO_CATCHUP_MAX_PAGES. tsLooksLikeMs=false: cần chuẩn hoá đơn vị ts.");
  console.log("- selfByFlag/selfByUid > 0: bộ lọc self-loop là cần thiết (đúng dự kiến).");

  await client.shutdown?.();
  process.exit(0);
}

main().catch((err) => { console.error("[probe] lỗi:", err?.message || err); process.exit(1); });
