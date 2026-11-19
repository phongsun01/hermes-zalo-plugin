# PR 1 — Ghép WS catch-up vào `zaloClient.js`

Ba file mới (không sửa file nào có sẵn khi copy):

| File | Vai trò |
|---|---|
| `lib/old-messages-catchup.js` | Engine WS (phụ thuộc vào listener truyền vào, không import zca-js) |
| `test/old-messages-catchup.test.js` | 15 test bằng listener giả: `node --test test/old-messages-catchup.test.js` |
| `scratch/probe_request_old.js` | Phase 0: chỉ in metadata, tối đa 3 request |

Lưu ý: bản `zaloClient.js` tôi có là bản cũ (checkpoint JSON). Bản của bạn đã chuyển sang SQLite (`this._repository`), nên các tên hàm dưới đây cần đối chiếu với file thật của bạn.

## Thứ tự làm

1. Copy 3 file, chạy test: phải 15/15.
2. **Tắt bridge**, chạy `node scratch/probe_request_old.js`. Gửi kết quả cho tôi trước khi bật engine mới.
3. Chỉ khi `cursorWorked=true` và `tsLooksLikeMs=true` mới ghép code bên dưới và bật `ZALO_CATCHUP_ENGINE=ws`.
4. Live test theo Acceptance Criteria V2.1 (ngắt mạng 60 giây, gửi DM và tin nhóm từ tài khoản khác).
5. Rollback: đặt lại `ZALO_CATCHUP_ENGINE=rest`, không cần revert code.

## Ghép vào `zaloClient.js`

**1. Import (đầu file)**

```js
import { createOldMessagesCatchup, THREAD_USER, THREAD_GROUP } from "./lib/old-messages-catchup.js";
```

**2. Constructor** (cạnh `this._catchingUp = false;`)

```js
this._catchupEngine = String(process.env.ZALO_CATCHUP_ENGINE || "rest").toLowerCase() === "ws" ? "ws" : "rest";
this._catchupTruncated = { user: false, group: false };
this._oldMsgs = createOldMessagesCatchup({
  getOwnId: () => this.ownId,
  maxPages: Math.min(Math.max(Number(process.env.ZALO_CATCHUP_MAX_PAGES) || 5, 1), 20),
});
```

**3. Nơi tạo listener** (chỗ có `listener.on("connected", ...)`): thêm một dòng.

```js
this._oldMsgs.attach(listener);   // chỉ đăng ký 1 lần cho mỗi listener (WeakSet)
```

**4. `_catchupMissedMessages`**: sau kill switch `ZALO_ENABLE_CATCHUP` và các guard hiện có, bên trong `try` (để `finally` vẫn đưa state về READY):

```js
if (this._catchupEngine === "ws") {
  await this._catchupViaWebSocket();
  return;               // vẫn đi qua finally
}
// ... engine REST cũ giữ nguyên (kèm auto-prune 404)
```

**5. Hàm mới**

```js
async _catchupViaWebSocket() {
  const kind = (type) => (type === THREAD_USER ? "user" : "group");
  const results = await this._oldMsgs.runCatchup({
    getCheckpointTs: (type) => this._maxCheckpointTs(kind(type)),
    maxWindowMs: this.maxCatchupWindowMs,
    shouldAbort: () => this.state !== "CATCHUP" || !this.loggedIn || this.sessionDead,
  });

  for (const [typeStr, r] of Object.entries(results)) {
    const k = kind(Number(typeStr));
    this._catchupTruncated[k] = Boolean(r.truncated);
    if (r.status === "timeout" || r.status === "error") this._stats.historyFetchErrors++;
    for (const raw of r.messages) {
      const ev = this._normaliseMessage(raw);   // old_messages dùng cùng lớp UserMessage/GroupMessage với tin live
      if (!ev) continue;
      ev.replayed = true;                        // PR5 dùng để xếp hàng ưu tiên thấp
      this.emit("message", ev);
      this._updateThreadLastSeen(ev.threadId, ev.messageId, ev.timestamp, ev.threadType);
      this._stats.recoveredCount++;
      await new Promise((res) => setTimeout(res, 50));   // không làm tràn ring buffer 200 của SSE
    }
  }
}

// Mốc tin live gần nhất của một loại thread (0 = chưa có => engine bỏ qua loại đó).
_maxCheckpointTs(kind) {
  // Bản SQLite:  return this._repository?.getMaxCheckpointTs(kind) ?? 0;
  // Bản JSON:
  let max = 0;
  for (const t of Object.values(this._checkpoint.threads)) {
    if (t.threadType === kind) max = Math.max(max, Number(t.checkpoint?.timestamp || 0));
  }
  return max;
}
```

**6. `lib/message-repository.js`** (bản SQLite): thêm và export

```js
function getMaxCheckpointTs(threadType) {
  const row = store.select(
    `SELECT MAX(last_ts) AS ts FROM threads WHERE thread_type = $t AND is_hidden = 0`,
    { $t: String(threadType) }
  )[0];
  return Number(row?.ts || 0);
}
```

**7. `/health`**: trong khối `catchup` thêm `engine: this._catchupEngine, truncated: this._catchupTruncated`.

## Chưa được kiểm chứng (cần probe và live test)

- Thứ tự tin trong trang, ý nghĩa của `lastId` (có thật là msgId cũ nhất để lùi tiếp), kích thước mỗi trang. Test hiện chỉ dùng listener giả.
- Một trang `old_messages` có thể bị tin của nhóm sôi nổi chiếm hết. `truncated=true` trong `/health` là tín hiệu để tăng `ZALO_CATCHUP_MAX_PAGES`.
- Phản hồi muộn sau timeout: module bỏ phản hồi đến trong 15 giây sau timeout. Nếu phản hồi thật đến muộn hơn, nó bị bỏ vì không có waiter.
