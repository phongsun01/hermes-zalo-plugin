# PR 1 (v2) — WS catch-up theo đồng bộ tiến

## Ngữ nghĩa đã kiểm chứng và chưa kiểm chứng

Đã quan sát trên tài khoản thật (DM): `listener.requestOldMessages(type, lastId)` trả các tin **sau** `lastId` (loại chính tin `lastId`), thứ tự cũ → mới, cả tài khoản theo loại thread. `lastId = null` bắt đầu từ đầu bộ đệm đồng bộ của Zalo (nhiều ngày trước), **không** phải tin mới nhất. Kích thước trang thay đổi (17 đến 50).

| Điểm | Trạng thái |
|---|---|
| DM + cursor là msgId trong trang | Đã quan sát (trang 2 = trang 1 trừ tin cursor, đi tiếp về sau) |
| DM + cursor là msgId checkpoint thật | Đã quan sát (7 tin ngay sau checkpoint) |
| **Group + cursor** | **Chưa kiểm chứng** (probe v2 kiểm tra) |
| Cursor quá cũ, không còn trong bộ đệm Zalo | **Chưa biết** Zalo trả gì (rỗng? từ đầu bộ đệm?) |

Hệ quả thiết kế:
- Cursor đầu = `msgId` checkpoint của loại thread. Cursor kế = tin **mới nhất** trong trang. Dừng khi trang rỗng hoặc không có tin mới.
- Cắt trang (`truncated`) nghĩa là **thiếu các tin mới nhất** (ngược với thiết kế lùi cũ), nên module có `maxRounds` để chạy tiếp từ `resumeCursor`.
- Cửa sổ `ZALO_CATCHUP_MAX_WINDOW_MS` giờ chỉ là bộ lọc: tin cũ hơn cửa sổ bị bỏ nhưng vẫn được duyệt qua để tiến cursor.
- Tin của chính bot bị lọc nhưng vẫn dùng để tiến cursor. Buffer 30s không còn tác dụng vì cursor là msgId, nên đã bỏ. Dedup theo messageId ở bridge/adapter lo phần trùng.

## Thứ tự làm

1. Copy đè 3 file (`lib/`, `test/`, `scratch/`), chạy test: phải 18/18.
2. **Tắt bridge**, chạy lại `node scratch/probe_request_old.js` (tối đa 4 request). Cần `forward.*` đều `true` cho **cả DM và Group**.
3. Trước khi bật Group: kiểm tra Group với **msgId checkpoint thật** (lấy từ bảng `threads`, dòng `thread_type='group'` có `last_ts` lớn nhất), gọi `requestOldMessages(1, <msgId>)` một lần, xem có trả các tin ngay sau đó không. Làm tương tự với một checkpoint **cũ vài ngày** để biết Zalo xử lý cursor cũ ra sao.
4. Ghép code bên dưới, bật `ZALO_CATCHUP_ENGINE=ws`. Nếu bước 3 cho thấy Group không ổn, có thể chỉ bật cho DM (truyền `types: [THREAD_USER]`).
5. Live test theo Acceptance Criteria V2.1.
6. Rollback: `ZALO_CATCHUP_ENGINE=rest`.

## Ghép vào `zaloClient.js`

Lưu ý: bản `zaloClient.js` tôi có là bản cũ (checkpoint JSON); đối chiếu tên hàm với file thật của bạn (SQLite).

**1. Import**

```js
import { createOldMessagesCatchup, THREAD_USER, THREAD_GROUP } from "./lib/old-messages-catchup.js";
```

**2. Constructor** (cạnh `this._catchingUp = false;`)

```js
this._catchupEngine = String(process.env.ZALO_CATCHUP_ENGINE || "rest").toLowerCase() === "ws" ? "ws" : "rest";
this._catchupTruncated = { user: false, group: false };
this._oldMsgs = createOldMessagesCatchup({
  getOwnId: () => this.ownId,
  maxPages:  Math.min(Math.max(Number(process.env.ZALO_CATCHUP_MAX_PAGES)  || 5, 1), 20),
  maxRounds: Math.min(Math.max(Number(process.env.ZALO_CATCHUP_MAX_ROUNDS) || 3, 1), 10),
});
```

**3. Nơi tạo listener** (chỗ có `listener.on("connected", ...)`)

```js
this._oldMsgs.attach(listener);   // chỉ đăng ký 1 lần cho mỗi listener
```

**4. `_catchupMissedMessages`**: sau kill switch `ZALO_ENABLE_CATCHUP` và các guard hiện có, bên trong `try` để `finally` vẫn đưa state về READY:

```js
if (this._catchupEngine === "ws") {
  await this._catchupViaWebSocket();
  return;
}
// ... engine REST cũ giữ nguyên (kèm auto-prune 404)
```

**5. Hàm mới**

```js
async _catchupViaWebSocket() {
  const kind = (type) => (type === THREAD_USER ? "user" : "group");
  const results = await this._oldMsgs.runCatchup({
    // types: [THREAD_USER],   // bỏ comment nếu chỉ bật cho DM
    getCheckpoint: (type) => this._latestCheckpoint(kind(type)),
    maxWindowMs: this.maxCatchupWindowMs,
    shouldAbort: () => this.state !== "CATCHUP" || !this.loggedIn || this.sessionDead,
  });

  for (const [typeStr, r] of Object.entries(results)) {
    const k = kind(Number(typeStr));
    this._catchupTruncated[k] = Boolean(r.truncated);
    if (r.status === "timeout" || r.status === "error") this._stats.historyFetchErrors++;
    for (const raw of r.messages) {          // đã lọc self, bỏ trùng, sắp xếp ts tăng dần
      const ev = this._normaliseMessage(raw); // old_messages dùng cùng lớp UserMessage/GroupMessage với tin live
      if (!ev) continue;
      ev.replayed = true;                      // PR5 dùng để xếp hàng ưu tiên thấp
      this.emit("message", ev);
      this._updateThreadLastSeen(ev.threadId, ev.messageId, ev.timestamp, ev.threadType);
      this._stats.recoveredCount++;
      await new Promise((res) => setTimeout(res, 50));   // không làm tràn ring buffer 200 của SSE
    }
  }
}

// Checkpoint mới nhất của một loại thread: { msgId, ts } hoặc null (chưa có => engine bỏ qua loại đó).
_latestCheckpoint(kind) {
  // Bản SQLite:  return this._repository?.getLatestCheckpoint(kind) ?? null;
  // Bản JSON:
  let best = null;
  for (const t of Object.values(this._checkpoint.threads)) {
    if (t.threadType !== kind) continue;
    const ts = Number(t.checkpoint?.timestamp || 0);
    if (ts > 0 && t.checkpoint?.messageId && (!best || ts > best.ts)) best = { msgId: String(t.checkpoint.messageId), ts };
  }
  return best;
}
```

**6. `lib/message-repository.js`** (bản SQLite): thêm và export

```js
function getLatestCheckpoint(threadType) {
  const row = store.select(
    `SELECT last_message_id AS msgId, last_ts AS ts FROM threads
     WHERE thread_type = $t AND is_hidden = 0 AND last_message_id <> '' AND last_ts > 0
     ORDER BY last_ts DESC LIMIT 1`,
    { $t: String(threadType) }
  )[0];
  return row ? { msgId: String(row.msgId), ts: Number(row.ts) } : null;
}
```

**7. `/health`**: trong khối `catchup` thêm `engine: this._catchupEngine, truncated: this._catchupTruncated`.

## Rủi ro còn lại

- **Checkpoint là tin của chính bot hay của người dùng?** Cursor tốt nhất là tin mới nhất bất kỳ trong loại thread. Nếu `threads.last_message_id` chỉ cập nhật theo tin vào (không phải tin bot gửi), cursor có thể cũ hơn một chút và Zalo trả thêm vài tin của bot. Chúng bị lọc, không gây hại.
- **Khi checkpoint không được lưu lúc tắt đột ngột:** cursor cũ hơn thực tế, các tin đã xử lý được trả lại và chặn bằng dedup messageId. Cần xác nhận dedup này chạy ở cả `server.js` và `adapter.py` cho tin `replayed`.
- **Cursor quá cũ:** nếu Zalo trả "từ đầu bộ đệm" thì ta duyệt tối đa `maxPages × maxRounds` trang toàn tin cũ ngoài cửa sổ và có thể báo `truncated`. Bước 3 ở trên sẽ cho biết thực tế.
