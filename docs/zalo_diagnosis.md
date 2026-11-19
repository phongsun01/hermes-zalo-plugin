# 🔍 Chẩn đoán Zalo Plugin — Hermes Gateway

> Thời điểm cập nhật: 2026-10-15 12:20 ICT

---

## 📊 Tóm tắt trạng thái

| Thành phần | Trạng thái | Chi tiết |
|---|---|---|
| Plugin Python (`~/.hermes/plugins/zalo/`) | ✅ Cài đặt | `adapter.py` có retry (5 lần) + `max_message_length=4000` + login retry 60s |
| Bridge Node.js (`server.js` port 8787) | ✅ **v1.0.8** | KeepAlive 60s, auto-relogin 5 attempts với 30s timeout, cookieOnly relogin |
| Bridge resilience | ✅ **uncaughtException + unhandledRejection handlers** | Không crash khi async error |
| Watchdog (`bridge-watchdog.js`) | ✅ **Forever restart** | Không max retries, restart 3s, health poll 10s + auto /relogin |
| Credentials (`~/.hermes-zalo/credentials.json`) | ✅ Có | Auto-refreshed sau mỗi keepAlive |
| QR login | ✅ Đã quét | Cookie login ổn định |
| Config `config.yaml` | ✅ Đầy đủ | `platforms.zalo.enabled: true` + `plugins.enabled: [zalo-platform]` (cả 2 cần) |
| `.env` | ✅ Đúng | `ZALO_PLUGIN_URL=http://host.docker.internal:8787` |
| DM reply | ✅ OK | Text thuần, strip markdown, chunk 4000 ký tự |
| Group reply (@mention) | ✅ OK | Chỉ reply khi được mention (`ZALO_GROUP_MODE=mention`) |
| Markdown handling | ✅ Strip → text thuần | Không còn lỗi gửi JSON card |
| Recovery code 1006 | ✅ **zca-js WS retry** (Fix 22) | Inject 1006 vào retry list → reconnect nội bộ ~2s, không cần full relogin |
| Recovery code 1000 | ✅ **zca-js tự retry WS** | Inject code 1000 vào `close_and_retry_codes` + `retryCount`, zca-js reconnect nội bộ 0 API call, downtime ~5s |
| SSE single-client 409 gate | ✅ **HTTP 409 rejection** (Fix 22) | Bridge trả 409 khi đã có SSE client; Docker phantom bị chặn ổn định |
| SSE reconnect adapter | ✅ **409 sleep 10s** | Adapter code mới: nhận 409 → sleep 10s im lặng thay vì reconnect storm |
| SSE reconnect | ✅ **Giảm downtime + cleanup** | Backoff max 10s + health poll 2s + `TCPConnector(force_close=True)` + `/disconnect` trước retry |
| Gateway reconnect match | ✅ **Login retry polling** | Adapter poll `/health` 60s khi "not_logged_in" trước khi báo fail |
| Bridge-watchdog | ✅ **Forever** | Không max retries, restart 3s, health poll 10s + auto /relogin |
| Message dedup | ✅ **4 layers** | server.js (isSelf + messageId ring + **single-client SSE**) + adapter.py (messageId ring) |
| `sseClients` | ✅ **Single-client mode → 409 gate** | 409 reject thay vì evict; Docker phantom bị từ chối tại HTTP level |
| Group Catchup | ✅ **Hoạt động ổn định** (Fix 31) | Dùng `getGroupChatHistory` chính thức, circuit breaker ngắt khi 429, auto-prune 404 sau 3 lần |
| DM Catchup | ⚠️ **Safe Degrade** (Fix 31) | REST `/api/message/loadmsg` trả 400 Bad Request trên web endpoint. DM dựa vào live websocket + fast reconnect |
| Windows Firewall | ✅ **Rule port 8787** (Fix 23 & Fix 34) | Inbound rule TCP 8787 cho phép Docker (`192.168.65.254`) kết nối vào host bridge |
| Markdown Parser | ✅ **Chính xác (Fix 34)** | Bóc tách tuần tự (sequential accumulative regex), tính offset chuẩn xác không bị lệch 1-2 ký tự |
| s6-overlay shebang (CRLF) | ✅ **Đã sửa (Fix 28)** | Chuyển đổi dòng CRLF -> LF cho các script khởi động trong thư mục `docker/` trên host Windows |

---

## 🔧 Các sửa đổi đã áp dụng (2026-06-16 v4 - Docker Bridge Stability)

### 22. Single-client SSE 409 gate + adapter 409 handler (2026-06-16)

**Vấn đề:** Docker Desktop proxy (Windows) tạo 2 TCP connections đồng thời khi container gọi `GET /events`. Bridge thêm cả 2 vào `sseClients` → mỗi event được push 2 lần → bot reply 2 lần. Giải pháp evict (fix 21) gây "Death Spiral": evict → adapter disconnect → backoff ngắn → reconnect → evict lại.

**Root cause chính xác:**
- Docker Desktop NAT proxy tạo phantom connection ngay sau real connection
- Eviction kill real client, adapter reconnect → vòng lặp vô hạn

**Fix A — `server.js`:** Thay eviction bằng **HTTP 409 Conflict rejection**. Khi đã có `sseClients=1`, bridge từ chối SSE request mới bằng `res.status(409)`:
```javascript
app.get("/events", (req, res) => {
  if (sseClients.size >= 1) {
    console.log("[bridge] SSE rejected (already have 1 client) — returning 409");
    res.status(409).json({ error: "already_connected" });
    return;
  }
  // ... setup SSE
});
```

**Fix B — `adapter.py`:** Nhận 409 → sleep 10s im lặng thay vì raise exception:
```python
if resp.status == 409:
    logger.debug("Zalo: SSE 409 (bridge slot busy); waiting 10s for phantom to clear")
    await asyncio.sleep(10.0)
    continue  # retry loop
```

**Fix C — `bridge-watchdog.js`:** Pass `ZALO_PLUGIN_HOST=0.0.0.0` vào env của bridge child:
```javascript
const child = spawn("node", ["server.js"], {
  env: { ...process.env, ZALO_PLUGIN_HOST: "0.0.0.0" },
  ...
});
```

**Kết quả:** `sseClients` ổn định = 1, không còn double reply, bridge không bị eviction storm.

### 23. Windows Firewall rule port 8787 (2026-06-16)

**Vấn đề:** Bridge listen `0.0.0.0:8787` nhưng Windows Firewall block inbound traffic từ Docker network (`192.168.65.254`) → container không reach được `host.docker.internal:8787`.

**Fix:** Thêm Windows Firewall inbound rule:
```powershell
# Chạy với quyền Admin:
New-NetFirewallRule -DisplayName "Zalo Bridge 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Any
```

**Lưu ý:** Rule này persist sau reboot. Kiểm tra: `Get-NetFirewallRule -DisplayName "Zalo Bridge 8787"`

### 24. zca-js code 1006 WS retry injection (2026-06-16)

**Vấn đề:** Zalo WebSocket đóng với `code=1006` (abnormal closure) mỗi ~3 phút. zca-js không có code 1006 trong `close_and_retry_codes` → rơi vào `closed` event → `_scheduleAutoRelogin()` với 5s delay → full cookie relogin (~8-10s) → **blackout window 7-12s** mỗi 3 phút. Tin nhắn gửi trong window này bị mất hoàn toàn.

**Root cause:** `zca-js/dist/apis/listen.js` `canRetry(1006)` → `false` (1006 không trong retry list từ server settings).

**Fix (`zaloClient.js` `_afterLogin()`):** Inject code 1006 vào retry system cùng code 1000:
```javascript
if (!codes.includes(1006)) codes.push(1006);
if (!listener.retryCount["1006"]) {
  listener.retryCount["1006"] = {
    count: 0, max: 999, times: [2000],  // retry sau 2s, tối đa 999 lần
  };
}
```

**Kết quả:**
| Metric | Before (full relogin) | After (WS retry) |
|--------|----------------------|------------------|
| Downtime per code 1006 | 7-12s | ~2s |
| API call | 1 (cookie relogin) | 0 |
| Message loss window | 7-12s/3min | ~2s/3min |

**Cần restart bridge** để load fix: Ctrl+C trong terminal watchdog → `node bridge-watchdog.js`

### 25. Slash Command Skill execution environment (WSL/Docker) (2026-06-25)

**Vấn đề:** Khi tạo một AI Skill (như `/cc`) bằng file `SKILL.md` để user giao tiếp qua bot Zalo, nếu hướng dẫn Agent chạy các công cụ bằng Windows PowerShell (vd: `powershell -Command` với đường dẫn `C:\Users\Desktop\...`), Agent Zalo sẽ báo lỗi.

**Root cause:**
- Gateway và Agent phục vụ Zalo Bot đang chạy trực tiếp bên trong container Docker/WSL2 (Linux) - cụ thể là container `hermes`.
- Các Agent này không có tool `run_command` tương tác với PowerShell trên host Windows, mà dùng terminal Linux cục bộ.
- File system được mount vào `/opt/data` hoặc truy cập qua home directory `~/.hermes`, không phải ổ `C:\`.

**Giải pháp (Lesson Learned cho thiết kế Skill):**
- Khi viết file `SKILL.md` phục vụ qua Zalo (Gateway), phải viết hướng dẫn thực thi (Action) tương thích với môi trường **Linux/Docker**.
- Dùng `python ~/.hermes/scripts/...` thay vì `C:\Users\...`
- Bỏ các wrapper lệnh như `docker exec hermes ...` vì bản thân Agent Zalo đã nằm TRONG container `hermes` rồi.
- *Lưu ý: Nếu thay đổi, thêm bớt Skill mới (`SKILL.md`), cần restart Gateway container (`docker restart hermes`) để Gateway load lại danh sách Slash Command Registry.*

### 27. Định tuyến tin nhắn Cron nhóm Zalo bị gửi nhầm thành DM cá nhân (2026-07-03)

**Vấn đề:** 
Khi chạy các tác vụ định kỳ (Cron jobs) để gửi thông báo tự động vào nhóm chat Zalo (ví dụ nhóm có ID `3339712927031818889`), tin nhắn không được gửi vào nhóm mà lại gửi nhầm thành tin nhắn riêng tư (DM) cho sếp Lala Tran hoặc hiển thị người lạ tên `" "`.

**Root cause:**
1. **Mất thông tin phân loại hội thoại (Thread Type Loss)**: ID của user và group trên Zalo personal API (zca-js) đều là các dãy số có độ dài tương đương nhau. Zalo adapter chỉ tự động ghi nhận và lưu lại loại hội thoại (`user` hoặc `group`) dựa trên tin nhắn nhận đến. Tuy nhiên, tin nhắn Cron là tin nhắn chủ động gửi đi từ hệ thống (outbound), không có tin nhắn nhận đến từ trước để ghi nhận, do đó adapter không tìm thấy loại hội thoại trong cache và tự động fallback về nhắn tin cá nhân (`user`).
2. **Yêu cầu ID số nguyên gốc (Raw IDs)**: Zalo bridge mong muốn nhận `threadId` dạng số nguyên thuần túy, không chấp nhận các prefix chuỗi lạ như `group:3339712927031818889`.

**Giải pháp:**
1. **Dọn dẹp prefix gửi đi**: Bổ sung hàm `_clean_target(chat_id)` vào file adapter [adapter.py](file:///C:/Users/Desktop/.hermes/plugins/zalo/adapter.py) để tự động tách và trích xuất thuộc tính loại hội thoại khi phát hiện prefix `group:` hoặc `user:`, sau đó trả về ID số nguyên gốc gửi cho Zalo API.
2. **Nạp trước danh sách nhóm (Auto-populate Groups)**: Thêm phương thức `_populate_group_types()` chạy ngầm ngay khi kết nối (`connect()`) để fetch danh sách toàn bộ các nhóm từ Zalo bridge (`GET /groups`) và lưu sẵn ID của chúng vào cache `self._thread_types` dưới thuộc tính `group`.
3. **Cập nhật các phương thức gửi**: Áp dụng cơ chế dọn dẹp và phân giải ID này vào toàn bộ các phương thức gửi tin nhắn chủ động: `send`, `send_typing`, `send_image_file`, `send_document`, `send_voice`.
4. **Khởi động lại Gateway**:
   ```bash
   docker exec hermes hermes gateway restart
   ```

### 28. Sửa lỗi line endings (CRLF to LF) gây crash s6-overlay sau khi máy chủ reboot (2026-08-18)

**Vấn đề:** 
Sau khi Windows/Server restart, container Docker `hermes` và `hermes-dashboard` liên tục gặp lỗi khởi động `exec: fatal: unable to exec sh: No such file or directory` và bị lặp lại vô hạn, gây kẹt và ngắt kết nối với Zalo/Telegram.

**Root cause:**
- Trên Windows host, khi clone code hoặc lưu file, Git hoặc trình soạn thảo mặc định ghi định dạng xuống dòng là CRLF (`\r\n`).
- S6-overlay chạy trong Docker container là Linux yêu cầu định dạng dòng Unix LF (`\n`) đối với các file cấu hình và script khởi động dịch vụ (nằm trong thư mục `docker/s6-rc.d/` và `docker/cont-init.d/`). Khi có ký tự ẩn `\r`, shebang `#!/bin/sh` bị đọc sai thành `/bin/sh\r` -> báo lỗi không tìm thấy tệp hoặc thư mục.

**Giải pháp:**
1. **Chuyển đổi line endings sang LF trên host:** Chạy script PowerShell sau trên Windows để chuyển đổi toàn bộ tệp trong thư mục cấu hình về định dạng LF:
   ```powershell
   Get-ChildItem "D:\Antigravity\Hermes\docker\s6-rc.d" -Recurse -Include "type","run","finish" | ForEach-Object {
       $content = [System.IO.File]::ReadAllText($_.FullName)
       $fixed = $content -replace "`r`n", "`n"
       [System.IO.File]::WriteAllText($_.FullName, $fixed, [System.Text.UTF8Encoding]::new($false))
   }
   Get-ChildItem "D:\Antigravity\Hermes\docker\cont-init.d" -File | ForEach-Object {
       $content = [System.IO.File]::ReadAllText($_.FullName)
       $fixed = $content -replace "`r`n", "`n"
       [System.IO.File]::WriteAllText($_.FullName, $fixed, [System.Text.UTF8Encoding]::new($false))
   }
   # Áp dụng tương tự cho stage2-hook.sh và main-wrapper.sh nếu cần thiết
   ```
2. **Xoá tệp khóa của container cũ:** Để tránh xung đột lock log file gây kẹt:
   ```powershell
   Remove-Item -Force C:\Users\Desktop\.hermes\logs\gateways\default\lock
   ```
3. **Build lại image và khởi động lại container:**
   ```powershell
   docker compose build
   docker compose down
   docker compose up -d
   ```

**Kết quả:** Dịch vụ khởi động hoàn toàn trơn tru, Gateway kết nối lại ngay lập tức tới Zalo bridge (`sseClients` chuyển về 1).

---

## 🔧 Các sửa đổi đã áp dụng (2026-06-12 v3 - Stability Round)

### 13. Server crash resilience — uncaughtException / unhandledRejection handlers

**Vấn đề:** Bridge Node.js crash không báo với `TransferEncodingError` trên gateway (HTTP response bị cắt giữa chừng). Nguyên nhân: unhandled promise rejection từ zca-js listener hoặc Express route handler không có try/catch.

**Giải pháp (`server.js`):**
```javascript
process.on("uncaughtException", (err) => {
  console.error("[bridge] UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[bridge] UNHANDLED REJECTION:", reason);
});
```

→ Bridge không còn crash khi có async error. Watchdog restart không còn cần thiết cho các lỗi này.

### 14. Auto-relogin timeout — 30s giới hạn

**Vấn đề:** `zalo.login(saved)` trong `relogin()` có thể HANG vô thời hạn nếu saved credentials stale hoặc server không response → `_reconnecting` bị lock vĩnh viễn → không có relogin attempt nào tiếp theo → bridge stuck ở `loggedIn=false`.

**Giải pháp (`zaloClient.js`):**
```javascript
async relogin({ forceQR = true, cookieOnly = false } = {}) {
    this._stopReconnect();
    this._stopKeepAlive();
    // ... cleanup ...
    const TIMEOUT_MS = 30_000;
    const result = await Promise.race([
      this.login({ forceQR, cookieOnly }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("login timed out")), TIMEOUT_MS),
      ),
    ]);
    return result;
}
```

→ Mỗi relogin attempt timeout sau 30s, không block các attempt tiếp theo.

### 15. SSE backoff với health polling

**Vấn đề:** Khi SSE disconnect, adapter dùng exponential backoff từ 1s lên 30s => nếu bridge restart nhanh (3-5s), adapter vẫn chờ tới 30s mới reconnect.

**Giải pháp (`adapter.py`):**
1. **Max backoff giảm** từ 30s → 10s
2. **Health poll trong backoff:** mỗi 2s poll `/health` → nếu bridge online, reconnect ngay

```python
async def _wait_with_health_poll(self, max_wait: float) -> None:
    slept = 0.0
    while slept < max_wait:
        remaining = max_wait - slept
        chunk = min(2.0, remaining)
        await asyncio.sleep(chunk)
        slept += chunk
        try:
            async with self._session.get(
                f"{self.bridge_url}/health", timeout=aiohttp.ClientTimeout(total=3),
                ...
            ) as resp:
                if resp.status == 200:
                    return  # bridge is up, reconnect now
        except Exception:
            pass  # bridge still down
```

### 16. Adapter login retry — Poll tới 60s khi bridge "not logged in"

**Vấn đề:** Gateway reconnect watcher exponential backoff 30s-300s. Bridge có thể auto-relogin thành công trong ~10-75s, nhưng gateway bỏ lỡ vì đang backoff.

**Giải pháp (`adapter.py` start()):** Khi `/health` trả về `loggedIn=false`, adapter KHÔNG fail ngay. Thay vào đó poll `/health` mỗi 5s tới 60s:

```python
MAX_LOGIN_RETRIES = 12  # ~60s total with 5s polling
login_retry = 0
while login_retry < MAX_LOGIN_RETRIES:
    data = await self._session.get(f"{self.bridge_url}/health").json()
    if data.get("loggedIn"):
        break  # bridge is ready
    login_retry += 1
    if login_retry < MAX_LOGIN_RETRIES:
        await asyncio.sleep(5)
    else:
        # still not logged in after 60s — fail with "not_logged_in"
```

→ Gateway reconnect watcher có tỷ lệ thành công cao hơn nhiều vì chịu đựng được transient logout trong ~60s.

### 17. Watchdog forever — Không giới hạn retry

**Vấn đề:** Watchdog cũ có `MAX_RETRIES = 50` → bridge không thể restart sau 50 lần crash. Bridge có thể crash nhiều lần nếu credentials corrupt hoặc zca-js lỗi.

**Giải pháp (`bridge-watchdog.js`):** Bỏ max retries, restart forever với 3s delay:
```javascript
child.on("exit", (code) => {
    console.log(`[watchdog] bridge exited with code ${code}`);
    console.log(`[watchdog] restarting in ${RETRY_DELAY_MS / 1000}s...`);
    setTimeout(startBridge, RETRY_DELAY_MS);
});
```

### 18. Double reply root cause v2 — Zombie SSE connections + Docker proxy (2026-06-11)

**Vấn đề:** Bot Zalo trả lời 2 lần cho mỗi tin nhắn. Bridge health endpoint trả về `sseClients: 2`
dù chỉ có 1 adapter instance đang chạy.

**Root cause:** aiohttp `ClientSession()` dùng connection pool mặc định với keep-alive. Khi SSE
stream bị drop (do zca-js session death code 1006), TCP connection vẫn được giữ alive trong pool.
Docker Desktop proxy (trên Windows) không detect được RST từ container → bridge vẫn xem client cũ là active.
Khi adapter reconnect, bridge có 2 SSE clients → mỗi event được gửi tới cả 2 clients → mỗi client
có `_dedup_set` riêng (không shared) → không dedup được → bot trả lời 2 lần.

**Cơ chế zombie:**
```
Container adapter      Docker proxy (10632)      Bridge (8787)
     |                        |                        |
     |--- SSE connect ------->|---- SSE connect ------>| sseClients = {A}
     |                        |                        |
     |--- session death ----->|---- code 1006 -------->|
     |                        |                        |
     |                        | (proxy giữ TCP open)   | sseClients = {A} (zombie)
     |                        |                        |
     |--- reconnect --------->|---- SSE connect ------>| sseClients = {A, B}
     |                        |                        | ← DOUBLE EVENT!
```

**Các vấn đề liên quan phát hiện cùng lúc:**

1. **`setup_logging()` double-handler bug** (`hermes_logging.py`): Handlers được thêm TRƯỚC guard
   `if _logging_initialized` → mỗi lần gọi `setup_logging()` thêm duplicate handlers → mỗi log line
   ghi 2 lần với timestamp lệch nhau 7h (UTC vs ICT).

2. **Log file timestamp lệch 7h:** UTC handler + ICT handler cùng ghi vào 1 file → mỗi dòng xuất hiện
   2 lần (vd: `04:22:08` và `11:22:08`).

**Giải pháp:**

**Fix 1: `hermes_logging.py` — Di chuyển guard trước handler creation**
```python
root = logging.getLogger()

if _logging_initialized and not force:
    return log_dir

# Handler creation AFTER the guard
_add_rotating_handler(root, log_dir / "agent.log", ...)
```

**Fix 2: Zalo adapter `adapter.py` — Force-close TCP connection**
```python
self._session = aiohttp.ClientSession(
    connector=aiohttp.TCPConnector(force_close=True),
)
```
Khi SSE stream kết thúc, TCP connection được đóng ngay (RST) thay vì trả về pool → Docker proxy
detect được disconnect sớm hơn.

**Fix 3: Bridge `server.js` — `/disconnect` endpoint**
```javascript
app.post("/disconnect", (req, res) => {
  if (!checkAuth(req, res)) return;
  for (const client of sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
  res.json({ ok: true, cleared: true });
});
```
Cho phép adapter cleanup zombie clients trước khi reconnect.

**Fix 4: Adapter gọi `/disconnect` trước retry**
```python
except Exception as e:
    # Cleanup zombie clients before reconnect
    try:
        await self._session.post(
            f"{self.bridge_url}/disconnect",
            headers=self._headers(),
            timeout=aiohttp.ClientTimeout(total=3),
        )
    except Exception:
        pass
    # Then backoff + retry...
    await self._wait_with_health_poll(backoff)
```

**Kết quả:** Sau container restart, `sseClients` xuống còn 1. Khi reconnect, adapter cleanup
zombie clients trước → không tích lũy duplicate SSE clients.

### 19. setup_logging double-handler (2026-06-11)

**Vấn đề:** Mỗi log line trong `gateway.log` xuất hiện 2 lần — một với timestamp UTC, một với ICT.
Gây khó đọc log.

**Root cause:** `setup_logging()` trong `hermes_logging.py` thêm handlers trước guard check:

```python
# OLD — handlers added BEFORE guard
root = logging.getLogger()
_add_rotating_handler(root, ...)  # ← handler added unconditionally
if _logging_initialized and not force:
    return log_dir
_logging_initialized = True
```

Khi gọi lần 2 (có `force=True`), handlers được thêm lại → mỗi handler có format khác nhau (UTC vs ICT) →
mỗi LogRecord được ghi 2 lần.

**Fix:** Đảo thứ tự — guard trước, handlers sau:

```python
# FIXED — guard first, handlers after
root = logging.getLogger()
if _logging_initialized and not force:
    return log_dir  # ← handler creation skipped on subsequent calls
_add_rotating_handler(root, ...)
_logging_initialized = True
```

**Ghi chú:** Fix này cần áp dụng vào image (hoặc `docker exec` patch + `docker restart hermes`) vì
`hermes_logging.py` nằm trong Docker image, không phải volume mount.

### 20. Code 1000 retry — zca-js tự reconnect WS, 0 API call (2026-06-12)

**Vấn đề:** Zalo server gửi websocket `code 1000` (ManualClosure) ~6s sau mỗi kết nối.
zca-js `Listener.canRetry()` kiểm tra `close_and_retry_codes.includes(1000)` → false (vì code 1000
không nằm trong retry list từ server settings) → rơi vào `closed` event → full API relogin mỗi lần.

**Hậu quả:** cycle `connected ~6s → relogin ~8s → login ~2s → connected ~6s → relogin...`
Downtime ~8s mỗi 14s (57%). Mỗi lần relogin tốn API call.

**Root cause trong zca-js** (`node_modules/zca-js/dist/apis/listen.js`):
```javascript
// ws.onclose handler (line 123-139):
ws.onclose = (event) => {
    this.reset();
    this.emit("disconnected", event.code, event.reason);
    const retry = retryOnClose && this.canRetry(event.code);  // ← canRetry(1000)=false
    if (retry && retryOnClose) {
        // ... retry logic (không bao giờ chạy cho code 1000)
    } else {
        this.onClosedCallback(event.code, event.reason);  // ← luôn chạy
        this.emit("closed", event.code, event.reason);
    }
};

canRetry(code) {
    if (!this.ctx.settings.features.socket.close_and_retry_codes.includes(code))
        return false;  // ← code 1000 không trong danh sách → false
    ...
}
```

**Giải pháp (`zaloClient.js` `_afterLogin()`):** Inject code 1000 vào retry system của zca-js
trước khi gọi `listener.start()`:

```javascript
const listener = this.api.listener;
if (listener && listener.ctx?.settings?.features?.socket) {
  const codes = listener.ctx.settings.features.socket.close_and_retry_codes;
  if (!codes.includes(1000)) codes.push(1000);     // cho phép retry code 1000
  if (!listener.retryCount["1000"]) {
    listener.retryCount["1000"] = {
      count: 0, max: 999, times: [5000],           // retry mỗi 5s, tối đa 999 lần
    };
  }
}
this.api.listener.start({ retryOnClose: true });
```

**Cơ chế hoạt động:** Khi code 1000 đến, zca-js `canRetry(1000)` trả về `5000` (delay). Sau 5s,
zca-js gọi `this.start({ retryOnClose: true })` → tạo WebSocket mới trên cùng listener instance
→ emit `connected` → bridge thấy `status: { connected: true }`. **0 API call, không cần relogin.**

**Kết quả:**
| Metric | Before | After |
|--------|--------|-------|
| Downtime mỗi cycle | ~8s (full relogin) | ~5s (WS reconnect) |
| API call mỗi cycle | 1 (relogin→api.login) | 0 |
| Connected window | ~6s | ~6s |
| log pattern | `disconnected → CLOSED → auto-relogin 1/5 → logged in → connected` | `disconnected → connected` |

### 21. Single-client SSE mode — Chống zombie SSH clients từ Docker Desktop (2026-06-12)

**Vấn đề:** Bridge health endpoint trả về `sseClients: 2` dù adapter chỉ có 1 SSE connection.
Docker Desktop proxy trên Windows tạo TCP connection phụ → bridge thêm 2 Express `res` objects
vào `sseClients` → mỗi event được `res.write()` 2 lần. Kết hợp với bridge `pushEvent` dedup
vẫn không đủ vì adapter nhận event qua 2 đường riêng biệt.

**Biểu hiện:** Bot Zalo trả lời 2 lần cho 1 tin nhắn. Gateway log có 2 `send()` calls với
cùng `reply_to` nhưng nội dung khác nhau (AI generate 2 response).

**Giải pháp (`server.js` `/events` handler):** Single-client mode — evict tất cả client cũ
khi có client mới connect:

```javascript
app.get("/events", (req, res) => {
  // Single-client mode: evict any existing SSE client.
  for (const old of sseClients) {
    try { old.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
  sseClients.add(res);
  console.log("[bridge] SSE client connected, total:", sseClients.size);
  // ... heartbeat, cleanup ...
});
```

**Tại sao an toàn:** Bridge đã có `ring` buffer (200 events) hỗ trợ SSE `Last-Event-ID`.
Khi adapter bị evict, nó reconnect với `Last-Event-ID` → bridge replay events đã miss.

**Kết quả:** `sseClients` luôn = 1. Docker Desktop zombie không tích lũy. Nếu zombie
thay thế client thật, adapter reconnect trong <1s (backoff 1s) → không mất event.

## 🔧 Các sửa đổi đã áp dụng (v1 - 2026-06-10 v1)

### 0. Cập nhật v1.0.8 upstream (2026-06-10)

Đã reset repo về tag `v1.0.8` từ `github.com/cuongdev/hermes-zalo-plugin`.

**Thay đổi từ upstream:**
- **KeepAlive heartbeat:** `_startKeepAlive()` gọi `api.keepAlive()` mỗi 60s (constant `KEEPALIVE_INTERVAL_MS`)
- **Auto-relogin có backoff:** `_scheduleAutoRelogin()` với linear backoff (5s, 10s, 15s... tối đa 60s), tối đa 5 lần thử
- **`cookieOnly` param:** Cho phép relogin mà không fallback xuống QR (không block)
- **`_declareSessionDead()`:** Method chuẩn hóa cho fatal session death (code 3000/3003)
- **`_stopReconnect()`:** Cleanup timer reconnect khi shutdown/relogin
- **Constructor fields mới:** `_keepAliveTimer`, `_autoReloginTimer`, `_autoReloginAttempts`, `_reconnecting`

**Custom patches giữ lại (re-applied sau merge):**
- Markdown strip trong `sendText()` (xóa `**`, `*`, `__`, `~~`, `` ` ``, headers, lists, links)
- Cookie refresh sau mỗi lần `api.keepAlive()` (lưu cookie mới vào `credentials.json`)
- `loggedIn = true` restore trong listener `connected` event

### 1. KeepAlive Heartbeat — Chống session death (code=1006)

**Vấn đề:** Session Zalo liên tục chết sau ~3-5 phút với `code=1006` (abnormal close). Bridge vẫn `loggedIn=True` nhưng listener websocket đóng, không nhận tin nhắn.

**Giải pháp:** Học từ [zaloclaw](https://github.com/monas-team/zaloclaw) — thêm cơ chế `keepAlive` định kỳ:

**File:** `D:\Antigravity\hermes-zalo-plugin\zaloClient.js`

```javascript
// Trong _afterLogin():
this._startKeepAlive();

/** Periodic keepAlive + cookie refresh to prevent session death. */
_startKeepAlive() {
  if (this._keepAliveTimer) {
    clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }
  const keepaliveDuration = this.api.getContext?.()?.settings?.keepalive?.keepalive_duration;
  const intervalSec = (keepaliveDuration && keepaliveDuration > 0) ? keepaliveDuration : 60;
  const intervalMs = intervalSec * 1000;
  console.log(`[zalo] keepAlive: ${intervalSec}s interval`);

  this._keepAliveTimer = setInterval(async () => {
    if (!this.loggedIn || !this.api) return;
    try {
      await this.api.keepAlive();
      // Refresh cookies after keepAlive — server may have issued new ones.
      const jar = this.api.getCookie?.();
      if (jar) {
        const serialized = jar.serializeSync?.()?.cookies ?? jar.toJSON?.()?.cookies;
        if (serialized) {
          const creds = this._loadCredentials();
          if (creds) {
            creds.cookie = serialized;
            this._saveCredentials(creds);
            console.log("[zalo] credentials refreshed after keepAlive");
          }
        }
      }
    } catch (e) {
      console.error("[zalo] keepAlive failed:", e && e.message ? e.message : e);
    }
  }, intervalMs);

  if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
}
```

**Cơ chế hoạt động:**
1. Gọi `api.keepAlive()` mỗi 60-120s (Zalo server quy định)
2. Sau mỗi lần keepAlive, lấy cookie mới từ `api.getCookie()` và lưu vào `credentials.json`
3. Cookie được refresh liên tục → session không bị hết hạn

### 2. Listener `closed` — Auto-relogin khi code 1006

**Vấn đề:** Khi listener đóng với `code=1006`, `retryOnClose` của zca-js không reconnect được. Bridge treo ở trạng thái `loggedIn=false, sessionDead=true` nhưng không tự recovery.

**Giải pháp:** Khai báo session dead ngay khi code 1006 → trigger auto-relogin từ `server.js`:

```javascript
listener.on("closed", (code, reason) => {
  console.log("[zalo] listener CLOSED", code, reason);

  if (code === 1006) {
    console.log("[zalo] abnormal close (1006) — auto-relogin triggered");
    this.loggedIn = false;
    this.sessionDead = true;
    this.sessionDeadReason = `code=${code} reason=${reason || ""}`.trim();
    this.emit("status", { connected: false, dead: true, code, reason });
    this.emit("session_dead", {
      code, reason: reason || "",
      message: "Zalo session closed (cookie expired or network). Auto-relogin triggered.",
    });
    return;
  }

  this._declareSessionDead(code, reason);
});
```

**Trong `server.js`** (đã có từ trước):
```javascript
client.on("session_dead", (d) => {
  pushEvent("session_dead", d);
  // Auto-relogin on session death (code 1006 = abnormal close)
  console.log("[bridge] session dead — auto-relogin triggered");
  client.relogin({ forceQR: false })
    .then((r) => console.log("[bridge] auto-relogin complete via", r.method))
    .catch((e) => console.error("[bridge] auto-relogin failed:", e && e.message ? e.message : e));
});
```

### 3. Listener `connected` — Restore `loggedIn` khi reconnect

```javascript
listener.on("connected", () => {
  console.log("[zalo] listener connected");
  this.sessionDead = false;
  this.loggedIn = true; // Restore nếu bị set false trong transient drop
  this.emit("status", { connected: true });
});
```

### 4. Cleanup — Stop keepAlive timer khi shutdown/relogin

```javascript
// Trong shutdown():
if (this._keepAliveTimer) {
  clearInterval(this._keepAliveTimer);
  this._keepAliveTimer = null;
}

// Trong relogin():
if (this._keepAliveTimer) {
  clearInterval(this._keepAliveTimer);
  this._keepAliveTimer = null;
}
```

### 5. Constructor — Thêm field `_keepAliveTimer`

```javascript
this._keepAliveTimer = null; // setInterval for keepAlive heartbeat
```

### 6. Silent relogin — Không emit `session_dead` event cho code 1006

**Vấn đề:** Khi listener đóng code 1006, emit `session_dead` → gateway thấy `session_dead` SSE event → báo lỗi fatal.

**Giải pháp:** Auto-relogin trực tiếp trong listener handler, không emit `session_dead` — gateway chỉ thấy SSE disconnect nhẹ.

```javascript
listener.on("closed", (code, reason) => {
  console.log("[zalo] listener CLOSED", code, reason);
  if (code === 1006 || code === 1000) {
    // Silent auto-relogin — don't emit session_dead to avoid SSE error to gateway
    this.loggedIn = false;
    this.relogin({ forceQR: false })
      .then(r => console.log("[zalo] silent relogin completed via", r.method))
      .catch(e => console.error("[zalo] silent relogin failed:", e?.message));
    return;
  }
  this._declareSessionDead(code, reason);
});
```

### 7. Markdown stripping — Gửi text thuần

**Vấn đề:** Bridge cố gắng parse markdown → gửi JSON card object thay vì text → Zalo hiển thị lỗi.

**Giải pháp:** Strip tất cả markdown syntax trước khi gửi:

```javascript
// Trong sendText():
sendText(uid, text) {
  const plain = text
    .replace(/[*_~`]+/g, '')         // **bold**, *italic*, __underline__, ~~strikethrough~~, `code`
    .replace(/#{1,6}\s+/g, '')        // headers: # ## ###
    .replace(/^[-*+]\s+/gm, '')       // unordered lists
    .replace(/^\d+\.\s+/gm, '')       // ordered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links [text](url)
    .replace(/>\s+/g, '')             // blockquotes
    .replace(/\n{3,}/g, '\n\n')       // limit blank lines
    .trim();
  return this.api.sendText(uid, plain);
}
```

### 8. Retry logic trong adapter.py

**Vấn đề:** Container gateway gọi POST tới bridge mỗi lần gửi tin nhắn. Nếu bridge đang relogin (chết tạm thời), request fail → mất tin nhắn.

**Giải pháp:** Retry `_post()` tới 5 lần với exponential backoff + xử lý cả connection error và bridge error:

```python
def _post(self, endpoint, data):
    max_retries = 5
    for attempt in range(max_retries):
        try:
            r = requests.post(f"{self.bridge_url}{endpoint}", json=data, timeout=10)
            result = r.json()
            if result.get("error"):
                logger.warning(f"[bridge] error from bridge: {result['error']}")
                if attempt < max_retries - 1:
                    time.sleep(min(2 ** attempt, 10))
                    continue
                return None
            return result
        except Exception as e:
            logger.warning(f"[bridge] _post attempt {attempt+1}/{max_retries} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(min(2 ** attempt, 10))
                continue
            return None
```

### 9. Giới hạn tin nhắn — `max_message_length=2000`

**Vấn đề:** Tin nhắn dài >4000 ký tự (mặc định) bị Zalo từ chối với lỗi "Nội dung quá dài".

**Giải pháp:** Giảm xuống 2000 ký tự + tự động chunk:

```python
# Trong adapter.py
max_message_length = 2000

# Tự động chunk nếu text > 2000 ký tự
if len(text) > self.max_message_length:
    for chunk in [text[i:i+self.max_message_length] for i in range(0, len(text), self.max_message_length)]:
        self._post("/send", {"uid": uid, "text": chunk, "otp": otp})
        time.sleep(0.5)
else:
    self._post("/send", {"uid": uid, "text": text, "otp": otp})
```

### 10. Cleanup timers trong `shutdown()` / `relogin()`

### 11. Message dedup — Chống trả lời 2 lần (2026-06-10)

**Vấn đề:** Bot Zalo trả lời 2 lần cho mỗi tin nhắn. Nguyên nhân: zca-js hardcoded `selfListen=true` (để tracking cliMsgId cho undo), kết hợp với auto-relogin v1.0.8 có thể tạo overlap ngắn giữa listener cũ và mới → cùng message được deliver 2 lần qua SSE.

**Giải pháp:** Hai lớp dedup:

**Layer 1: `server.js` — Filter trước khi push SSE**
```javascript
function pushEvent(type, payload) {
  // Never echo own messages back to the gateway adapter.
  if (type === "message" && payload.isSelf) return;
  // Dedup by messageId (catches rare duplicate pushes from listener overlap).
  if (type === "message" && payload.messageId) {
    if (msgDedupSet.has(payload.messageId)) {
      console.log("[bridge] dedup: skipping duplicate message", payload.messageId);
      return;
    }
    msgDedupSet.add(payload.messageId);
    msgDedupRing.push(payload.messageId);
    if (msgDedupRing.length > DEDUP_SIZE) {
      const old = msgDedupRing.shift();
      msgDedupSet.delete(old);
    }
  }
  // ... push to SSE clients
}
```

**Layer 2: `adapter.py` — Dedup ring trong Python adapter**
```python
# Trong __init__:
self._dedup_max = 200
self._dedup_set = set()
self._dedup_ring = []

# Trong _on_inbound_message:
msg_id = str(m.get("messageId") or "")
if msg_id:
    if msg_id in self._dedup_set:
        logger.debug("Zalo: dedup dropped duplicate message %s", msg_id)
        return
    self._dedup_set.add(msg_id)
    self._dedup_ring.append(msg_id)
    if len(self._dedup_ring) > self._dedup_max:
        old = self._dedup_ring.pop(0)
        self._dedup_set.discard(old)
```

```javascript
// Trong shutdown() và relogin():
if (this._keepAliveTimer) {
  clearInterval(this._keepAliveTimer);
  this._keepAliveTimer = null;
}
```

### 12. Root cause double reply v1 — Plugin loading vs Config loading (2026-06-10, outdated)

**⚠️ Phân tích này KHÔNG phải nguyên nhân thực sự.** Xem tiếp section 18 cho kết luận chính xác.

Config từng có cả `gateway.platforms.zalo.enabled: true` và `plugins.enabled: [zalo-platform]`.
Tôi đã xoá `plugins.enabled` vì nghĩ gây duplicate adapter → bot chết hoàn toàn (0 adapter, 0 SSE).

**Cơ chế thực tế — 2 lớp cần cả 2:**

| Lớp | Vai trò | Codepath |
|---|---|---|
| `plugins.enabled: [zalo-platform]` | PluginManager load plugin → `register()` gọi `ctx.register_platform(name="zalo", ...)` → đăng ký adapter factory vào `platform_registry` | `hermes_cli/plugins.py` → `gateway/platform_registry.py` |
| `platforms.zalo.enabled: true` | Gateway tìm platform "zalo" trong config → tìm trong `platform_registry` → tạo adapter | `gateway/run.py:4564-4582` → `_create_adapter()` |

**Không có built-in Zalo adapter** trong `gateway/platforms/` → config `platforms.zalo.enabled: true`
một mình vô dụng. Chỉ plugin mới cung cấp factory.

## 🔴 Nguyên nhân gốc rễ: Bot Zalo không phản hồi (historical)

### Vấn đề 1 (Đã sửa): Session death code=1006

Session Zalo liên tục chết sau ~3-5 phút do websocket disconnect từ phía Zalo server. Bridge không có cơ chế keepAlive → cookie hết hạn → session dead.

### Vấn đề 2 (Đã sửa): Bridge không tự recovery

Khi session chết, bridge không tự động relogin → phải scan QR lại.

### Vấn đề 3 (Đã sửa): Container không reach được bridge

`host.docker.internal` resolve sai IP (`192.168.65.254`) khi bridge chưa bind `0.0.0.0`. Đã fix bằng `ZALO_PLUGIN_HOST=0.0.0.0` trong `server.js`.

### Vấn đề 4 (Đã sửa): `.env` mất newline trên Windows mount

File `.env` mount từ Windows host bị dính hết thành 1 dòng trong container → gateway không parse được env vars. Đã chuyển env vars Zalo trực tiếp vào `docker-compose.yml`.

---

## 🛠️ Hướng dẫn khởi động Bridge

### Khởi động bridge với watchdog (khuyến nghị)

```powershell
cd D:\Antigravity\hermes-zalo-plugin
# Lần đầu — với log file
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "bridge-watchdog.js" -WorkingDirectory "D:\Antigravity\hermes-zalo-plugin" -RedirectStandardOutput "$env:USERPROFILE\hermes-zalo\bridge_stdout.log" -RedirectStandardError "$env:USERPROFILE\hermes-zalo\bridge_stderr.log"

# Hoặc chạy trực tiếp (không log file, output ra console hiện tại)
node bridge-watchdog.js
```

Watchdog tự động restart bridge khi crash (3s delay, không giới hạn).
Health check mỗi 10s, auto /relogin khi session dead.

**Kiểm tra bridge đang chạy:**
```powershell
curl.exe -s http://127.0.0.1:8787/health
```
Kết quả mong muốn (`sseClients` có thể là 1 hoặc 2):
```json
{ "ok": true, "loggedIn": true, "sessionDead": false, "ownId": "...", "sseClients": 1 }
```
`sseClients` luôn = 1 nhờ single-client mode (xem section 21). Nếu vẫn thấy 2,
Docker proxy tạo phantom connection → single-client mode tự evict và adapter reconnect.

### Khởi động không watchdog (debug)

```powershell
cd D:\Antigravity\hermes-zalo-plugin
node server.js
```

### Nếu cần quét lại QR
```powershell
cd D:\Antigravity\hermes-zalo-plugin
node login.mjs
# Quét QR trên màn hình bằng ứng dụng Zalo
```

### Restart gateway sau khi bridge lên
```powershell
docker exec hermes hermes gateway restart
# hoặc
docker restart hermes
```

---

## 🔁 Luồng hoạt động đúng

```
Người dùng nhắn Zalo
        ↓
zca-js (bên trong bridge) nhận tin
        ↓
bridge POST SSE event → GET /events
        ↓
adapter.py (_sse_loop) nhận event
        ↓
_on_inbound_message() → kiểm tra ZALO_ALLOWED_USERS, ZALO_GROUP_MODE
        ↓
handle_message() → Hermes AIAgent xử lý
        ↓
adapter.send() → POST bridge/send → zca-js → Zalo
```

**Markdown strip (trước khi gửi):**
```
response từ AIAgent (markdown)
        ↓
sendText() strip: ** * __ ~~ ` # - []()
        ↓
text thuần → POST /send → zca-api → Zalo
```

**Retry adapter (khi bridge bận / relogin):**
```
adapter.send() → _post(/send, data)
        ↓
request fail hoặc result.error
        ↓
retry attempt 1..5 (backoff 1s..10s)
        ↓
thành công hoặc bỏ qua sau 5 lần
```

**KeepAlive loop (chạy ngầm):**
```
_api.keepAlive() mỗi 60s (KEEPALIVE_INTERVAL_MS)
        ↓
api.getCookie() → cookie mới
        ↓
_saveCredentials() → cập nhật credentials.json
        ↓
Session không bị hết hạn → listener không đóng
```

**Silent relogin (khi session chết code 1006):**
```
listener "closed" (code 1006)
        ↓
_scheduleAutoRelogin() với linear backoff (5s, 10s...)
        ↓
relogin({ cookieOnly: true }) với 30s timeout
        ↓
thành công hoặc fail → schedule attempt tiếp theo
        ↓
thành công → listener "connected" → loggedIn=true → _autoReloginAttempts=0
```

**SSE disconnect → adapter recovery (v2 — 2026-06-11):**
```
_adapter._sse_loop() catch exception
        ↓
POST /disconnect  ← cleanup zombie SSE clients (fix Docker proxy)
        ↓
_wait_with_health_poll(backoff)  ← poll /health mỗi 2s
        ↓
bridge online → reconnect SSE ngay (không chờ hết backoff)
        ↓
SSE connected + Last-Event-ID replay → không mất event
```

**Gateway reconnect watcher (khi start fail):**
```
_gateway reconnect watcher retry sau 30..300s (exponential backoff)
        ↓
adapter.start()
        ↓
/health → loggedIn=false → poll mỗi 5s tới ~60s
        ↓
bridge login thành công → loggedIn=true → SSE connect
```

---

## ⚙️ Config summary hiện tại

| Biến | Giá trị | Ý nghĩa |
|---|---|---|
| `ZALO_PLUGIN_URL` | `http://host.docker.internal:8787` | ✅ Đúng cho Docker container |
| `ZALO_PLUGIN_HOST` | `0.0.0.0` | ✅ Bridge bind all interfaces |
| `ZALO_ALLOWED_USERS` | `2825656851207986406` | Chỉ user này mới được talk to bot |
| `ZALO_GROUP_MODE` | `mention` | Bot trả lời trong group khi được @mention |
| `ZALO_ALLOWED_ACTION_GROUPS` | `read,send,interact` | OK |
| `ZALO_HOME_CHANNEL` | `2825656851207986406` | DM channel |
| `ZALO_LOG_IDS` | `true` | Log uid + threadId |

---

### 7. Docker Desktop proxy không forward TCP RST → zombie SSE connections

**Vấn đề:** Docker Desktop trên Windows dùng `com.docker.backend` làm proxy giữa container và host.
Khi container gửi TCP RST (từ `force_close=True`), proxy có thể không forward RST tới host → bridge
không nhận được `req.on("close")` → zombie client trong `sseClients`.

**Biểu hiện:** `sseClients: 2` (hoặc nhiều hơn) trên bridge health.

**Fix v3 (2026-06-12):** Single-client mode — `/events` handler evict client cũ khi client mới connect.
Không cần workaround. Docker zombie tự cleanup. (Xem section 21.)

**Fix cũ (v2, còn dùng):**
- `force_close=True` trong aiohttp connector (giảm thiểu)
- `POST /disconnect` endpoint + adapter gọi trước reconnect

### 8. Bridge login mất sau khi Windows restart

Nếu Windows restart, bridge watchdog không tự start lại (vì chạy trong PowerShell session).

**Fix:** Cài bridge như Windows service (dùng `nssm` hoặc Task Scheduler):
```
nssm install HermesZaloBridge "C:\Program Files\nodejs\node.exe" "D:\Antigravity\hermes-zalo-plugin\bridge-watchdog.js"
```

## 📝 Known Issues

### 6. s6-log lock file conflict trên volume mount (Gây treo Gateway và Bridge)

**Vấn đề:** `s6-log: fatal: unable to lock /opt/data/logs/gateways/default/lock: Resource busy`. Khi container restart (hoặc bị force kill), tiến trình cũ để lại lock file trên volume mount của Windows -> s6-log khởi động lại không acquire được lock. 

**Tác động nghiêm trọng:** S6-log bị kẹt khiến bộ đệm (pipe buffer) của luồng stdout bị đầy. Khi buffer đầy, tiến trình Gateway bên trong container bị block lại và **treo cứng** toàn bộ API. Kéo theo đó, Webhook từ Zalo Bridge gửi tới Gateway bị timeout liên tục, dẫn tới tiến trình Node.js của Zalo Bridge (`server.js`) cũng có thể bị treo hoặc kẹt kết nối. 

**Cách xử lý vĩnh viễn:** Bỏ qua cơ chế `s6-log` supervision để ghi log trực tiếp ra stdout mà không qua pipe.
- Sửa file `docker-compose.yml`, thêm biến môi trường vào container `gateway`:
```yaml
      - HERMES_GATEWAY_NO_SUPERVISE=1
```
- Recreate lại container:
```bash
docker rm -f hermes
docker compose up -d gateway
```

### 1. Process node cũ không kill được trên Windows

Một số process node chạy dưới quyền khác (Administrator/System) → `taskkill /F` báo "Access is denied".

**Workaround:**
- Mở PowerShell as Administrator → `taskkill /F /IM node.exe`
- Hoặc Task Manager → End Task

### 2. Port 8787 bị chiếm bởi process cũ

Nếu bridge cũ (PID 21480, 23464) chưa kill hết, bridge mới không start được (`EADDRINUSE`).

**Kiểm tra:**
```powershell
netstat -ano | findstr 8787
```

**Kill process chiếm port:**
```powershell
taskkill /F /PID 21480
taskkill /F /PID 23464
```

**Note:** Các process này có thể cần admin rights — mở PowerShell as Administrator.

### 3. Gateway không reach được bridge từ container

`host.docker.internal` có thể resolve sai IP trên một số phiên bản Docker Desktop.

**Kiểm tra từ container:**
```powershell
docker exec hermes python3 -c "import urllib.request; r = urllib.request.urlopen('http://host.docker.internal:8787/health', timeout=5); print(r.read().decode())"
```

**Nếu không reach được:** Restart Docker Desktop hoặc dùng IP host thực tế.

### 4. `zca-js` websocket disconnect code 1006 — ✅ Fixed via WS retry injection (Fix 24)

Bất chấp keepAlive 60s, session vẫn chết `code=1006` mỗi ~3 phút. **Fix 24** inject code 1006 vào zca-js retry list → WS reconnect nội bộ ~2s thay vì full relogin 7-12s.

**Cơ chế chịu đựng sau fix:**
- **Code 1006:** zca-js tự reconnect WS sau 2s (0 API call) — downtime ~2s
- **Code 1000:** zca-js tự reconnect WS sau 1s (0 API call) — downtime ~1s
- Fallback auto-relogin vẫn hoạt động nếu WS retry exhausted (999 lần)
- Watchdog restart bridge trong 3s nếu crash
- `uncaughtException` + `unhandledRejection` handlers → không crash khi async error

**Cần restart bridge** để load fix 24: xem hướng dẫn bên dưới.

### 5. Gateway reconnect watcher backoff mismatch (300s max)

**Vấn đề:** Gateway reconnect watcher dùng exponential backoff lên tới 300s (5 phút) giữa các lần thử kết nối lại bridge. Trong khoảng đó, bridge có thể đã online nhưng gateway không biết.

**Giải pháp hiện tại (adapter `start()`):** Khi reconnect watcher gọi `start()`, adapter poll `/health` mỗi 5s tới 60s → nếu bridge logged in trong lúc đợi, kết nối thành công ngay.

**Giới hạn:** Nếu watcher vừa fail ngay trước khi bridge online, phải chờ hết backoff (tối đa 300s từ fail trước). Với cơ chế mới, adapter đợi 60s nên xác suất miss giảm đáng kể.

### 6. s6-log lock file conflict trên volume mount

**Vấn đề:** `s6-log: fatal: unable to lock /opt/data/logs/gateways/default/lock: Resource busy`. Khi container restart, lock file cũ (0 bytes) còn tồn tại trên volume mount → s6-log mới không acquire được lock → stdout của container (docker logs) không show gateway output.

**Tác động:** Không ảnh hưởng tới gateway. Log vẫn ghi vào `gateway.log` qua Python logging.

**Fix:** Xoá lock file sau restart:
```bash
docker exec hermes rm -f /opt/data/logs/gateways/default/lock
```

### 7. 429 reconnect storm từ grace period single-client SSE (Fix 21)

**Vấn đề:** Grace period 10s (số lượng tin nhắn) → khi SSE disconnect vì Docker proxy, adapter retry trong 10s → bridge trả 429 → **reconnect loop ∞** kéo dài hàng phút. Trong storm:
- Adapter không nhận được event mới
- Khi reconnect thành công, bridge replay event từ `Last-Event-ID` qua ring buffer (200 events)
- Nếu ring buffer wrap, event bị replay → double reply hoặc lost message

**Fix 22 (server.js):** Xóa grace period + single-client eviction. Docker phantom connections coexists với client thật. Adapter `_dedup_set` xử lý duplicate event.

**Fix 23 (adapter.py _consume_sse):** Update `_last_event_id` BEFORE `_handle_sse_event` để tránh SSE replay khi disconnect trong lúc agent execution.

**Triệu chứng trong log:**
```
WARNING ... Zalo: SSE disconnected (SSE status 429); reconnecting in X.Xs
```
Hàng trăm dòng 429 liên tục trong nhiều phút.

### 26. Zalo Rich Text Formatting (Bold, Italic, Lists) (2026-06-29)

**Vấn đề:**
- Tin nhắn gửi qua Zalo Bridge bị mất in đậm (`**`), in nghiêng (`_`), số thứ tự (`1. `), và ký tự đầu dòng (`* `) do Zalo không hỗ trợ trực tiếp cú pháp markdown truyền thống và Bridge cũ đã xoá sạch markdown bằng biểu thức chính quy (regex) để tránh hiển thị literal dấu sao.
- Việc chuyển đổi in đậm text thuần dạng `**text**` -> `*text*` cũng bị thất bại do Zalo render plain text thuần túy.

**Nguyên nhân:**
- Thư viện `zca-js` của Zalo Bridge yêu cầu định dạng in đậm / in nghiêng thông qua tham số `styles` (mảng Style object dạng `{ start, len, st }`) đi kèm message gốc đã strip định dạng.
- Regex in nghiêng đơn cũ `\*(?!\*)(.+?)\*(?!\*)` nhận diện nhầm các ký tự gạch đầu dòng của list (`* Dòng 1`, `* Dòng 2`) là một khối in nghiêng siêu lớn và xoá sạch dấu sao đầu dòng.

**Cách khắc phục:**
1. **Parse Markdown sang Rich Styles:** Trong hàm `sendText` của `zaloClient.js`, bổ sung thuật toán duyệt chuỗi (regex matchAll) để bóc tách `**bold**`, `__bold__`, và `_italic_` thành các cặp `{ start, len, st }` tương ứng (với `st: "b"` cho bold và `st: "i"` cho italic) rồi gửi kèm object `content.styles`.
2. **Khắc phục List Bullet Point:** Sửa regex pattern chỉ match `_italic_` đối với in nghiêng, loại bỏ hoàn toàn việc match `*italic*` bằng dấu sao đơn để tránh nhận nhầm và nuốt mất ký tự gạch đầu dòng (`* `) của danh sách.

### 27. Lỗi SSE Client Kick Loop / Duplicate Gateway Process (2026-08-19)

**Vấn đề:**
- Bridge liên tục báo lỗi kick loop vô hạn:
  ```
  [bridge] SSE client disconnected, total: 1
  [bridge] Kicking old SSE client(s) to accept new connection.
  [bridge] SSE client connected, total: 1
  ```
- Kèm theo đó là Telegram adapter cũng báo conflict (`Conflict: terminated by other getUpdates request`).
- Agent log xuất hiện song song 2 luồng log với 2 timezone khác nhau (ví dụ: `14:41:xx` và `07:41:xx` trên cùng một event Zalo/Telegram).

**Nguyên nhân gốc rễ (có 2 nguyên nhân xếp chồng):**

1. **Bug trong ZaloAdapter (`adapter.py`):**
   Trong method `connect()`, khi _reconnect watcher_ gọi lại hàm này do lỗi mất kết nối cũ, dòng lệnh tạo `self._sse_task = asyncio.create_task(self._sse_loop())` đã ghi đè trực tiếp biến `_sse_task` **mà không cancel task SSE cũ**. Kết quả là task cũ (Task A) vẫn chạy ẩn và liên tục cố reconnect tới bridge, trong khi task mới (Task B) cũng làm tương tự → 2 task cùng chung 1 process tranh chấp nhau bridge slot, gây ra kick loop vô hạn.

2. **Container `hermes-dashboard` spawn Gateway thứ hai:**
   Trong `docker-compose.yml`, container `dashboard` và container `gateway` dùng chung volume `~/.hermes`. 
   Khi container `dashboard` boot, script `container_boot.py` (chạy qua s6 supervisor) quét thấy file `gateway_state.json` có trạng thái là `running`. Vì `dashboard` container không được cấu hình chặn s6-supervise, nó mặc định coi đây là mandate và tự động spawn thêm một process `hermes gateway run` song song với container `gateway` chính. Process ảo này không có biến `TZ` nên xuất log hệ giờ UTC, giải thích hiện tượng "1 luồng giờ VN, 1 luồng giờ UTC".

**Cách khắc phục:**

1. **Vá Zalo Adapter:** Sửa `C:\Users\Desktop\.hermes\plugins\zalo\adapter.py`, trước khi `create_task`, bổ sung block cancel:
   ```python
   if self._sse_task and not self._sse_task.done():
       self._sse_task.cancel()
       try:
           await self._sse_task
       except asyncio.CancelledError:
           pass
       self._sse_task = None
   ```
2. **Ngăn chặn s6-supervise tự spawn lại (Sửa `service_manager.py`):** Sửa hàm render script của `s6-supervise` (`_render_run_script`) để chèn logic chặn `exit 0` vào thẳng file bash script (không phụ thuộc file trạng thái tmpfs).
3. **Cập nhật `docker-compose.yml`:** Thêm `HERMES_GATEWAY_NO_SUPERVISE=1` và `TZ=Asia/Ho_Chi_Minh` vào biến môi trường của container `dashboard` để cấm container này tự ý spawn gateway process và đồng bộ timezone nếu có lỗi log ra.

### 28. Zalo API Error 112 khi gửi tin nhắn dài hoặc Rich Text lớn (2026-08-24)

**Vấn đề:**
- Khi bot gửi phản hồi dài (ví dụ: danh sách 20 tài liệu dài >2.000 ký tự có chứa bold/markdown), Bridge báo lỗi:
  ```
  [bridge] Express Error: ZaloApiError [ZcaApiError]: Lỗi không xác định { code: 112 }
  POST /send 500
  ```
- Agent log báo `[Zalo] Send failed: Lỗi không xác định`.

**Nguyên nhân:**
- Endpoint gửi tin nhắn của Zalo Web (`/api/message/sms` hoặc `/api/group/sendmsg`) qua thư viện `zca-js` áp đặt giới hạn kích thước payload mã hóa AES.
- Khi tin nhắn dài >1.500 ký tự kết hợp với mảng `styles` (bold/italic) dày đặc hoặc emoji đa byte, payload vượt quá ngưỡng xử lý của Zalo server dẫn đến trả về mã lỗi `112`.
- Trước đây `adapter.py` đặt `max_message_length = 4000` (quá lớn đối với API Zalo cá nhân) và `zaloClient.js` không có cơ chế retry tự động khi gửi có format bị lỗi.

**Cách khắc phục:**
1. **Giảm `max_message_length` trong `adapter.py`:** Đổi ngưỡng mặc định từ `4000` xuống `1500` ký tự (có thể override bằng biến môi trường `ZALO_MAX_MESSAGE_LENGTH`). Các tin nhắn dài sẽ được tự động chia nhỏ thành các chunk ~1.500 ký tự gửi cách nhau 0.5s.
2. **Cơ chế Fallback 2 lớp trong `zaloClient.js`:**
   - **Fallback 1 (Bỏ styles):** Nếu gọi `sendMessage` kèm mảng `styles` thất bại (gặp mã lỗi 112 hoặc lỗi offset), tự động bắt lỗi và thử lại ngay lập tức bằng tin nhắn văn bản thuần túy (plain text).
   - **Fallback 2 (Tự động chia nhỏ):** Nếu tin nhắn vẫn quá dài (>1.200 ký tự) và bị server Zalo reject, tự động tách đôi tin nhắn tại vị trí xuống dòng `\n` gần nhất và gửi nối tiếp nhau cách nhau 400ms.

### 29. Bot Zalo không phản hồi và Cron báo lỗi "unknown platform 'zalo'" (2026-10-13)

**Vấn đề:**
- Bot Zalo không phản hồi bất kỳ tin nhắn nào (cả DM và Group).
- Tất cả các tác vụ Cron định kỳ gửi thông báo qua Zalo (TKB, báo thức, tin tức...) đều không gửi được và log ra cảnh báo:
  ```
  WARNING cron.scheduler: Job '...': unknown platform 'zalo'
  ```
- Kiểm tra `docker exec hermes hermes plugins list` thấy `zalo-platform` không còn xuất hiện trong danh sách plugin.

**Nguyên nhân:**
- Cấu hình `config.yaml` vẫn khai báo nạp plugin `zalo-platform` và `platform_toolsets.zalo`.
- Tuy nhiên, toàn bộ thư mục plugin Zalo (`C:\Users\Desktop\.hermes\plugins\zalo\` tương ứng với `/opt/data/plugins/zalo/` trong container) bị thiếu hoặc đã bị xóa/thất lạc trong quá trình dọn dẹp file.
- Khi khởi động Gateway, Hermes quét thư mục plugin không tìm thấy `zalo-platform` nên bỏ qua việc nạp platform adapter này.
- Khi đó, Gateway chỉ chạy với `telegram` và `api_server`. Hệ thống không có adapter `zalo` nên các tin nhắn đến từ bridge không được tiếp nhận, và Cron Scheduler không thể định tuyến tin nhắn gửi tới kênh Zalo.

**Cách khắc phục:**
1. Khôi phục thư mục plugin Zalo từ bộ mã nguồn gốc sang thư mục cấu hình Hermes:
   ```powershell
   New-Item -ItemType Directory -Force -Path "C:\Users\Desktop\.hermes\plugins\zalo"
   Copy-Item -Path "D:\Antigravity\hermes-zalo-plugin\hermes-plugin\*" -Destination "C:\Users\Desktop\.hermes\plugins\zalo\" -Recurse -Force
   ```
2. Kiểm tra lại danh sách plugin:
   ```bash
   docker exec hermes hermes plugins list
   # zalo-platform xuất hiện với trạng thái "enabled"
   ```
3. Khởi động lại container Gateway:
   ```bash
   docker restart hermes
   ```
4. Kiểm tra log thấy:
   ```
   INFO hermes_plugins.zalo_platform.adapter: Zalo: connected to bridge http://host.docker.internal:8787 (ownId=...)
   INFO gateway.run: ✓ zalo connected
   INFO gateway.run: Gateway running with 3 platform(s)
   ```
   Trạng thái SSE client trên bridge chuyển sang `sseClients: 1` và `state: READY`.


### 30. Mất kết nối Zalo sau khi nâng cấp mã nguồn lên v0.22.1 (2026-10-15)

**Vấn đề:**
- Sau khi nâng cấp mã nguồn Hermes lên tag `v0.22.1` và build lại Docker container, bot Zalo không phản hồi tin nhắn.
- Bridge Node.js vẫn báo `loggedIn: true` nhưng `sseClients: 0`.
- Cron báo lỗi `WARNING cron.scheduler: Job '...': unknown platform 'zalo'`.
- Gateway chỉ kết nối `telegram` và `api_server`, hoàn toàn không khởi tạo kết nối tới Zalo (`Gateway running with 2 platform(s)`).

**Nguyên nhân:**
- **Thiếu plugin `zalo-platform` trên user home:** Thư mục `C:\Users\Desktop\.hermes\plugins\zalo-platform` chưa được sao chép/khôi phục từ `D:\Antigravity\hermes-zalo-plugin\hermes-plugin` sang data directory (`~/.hermes/plugins/`).
- **Thiếu cấu hình `platforms.zalo.enabled: true`:** Trong `C:\Users\Desktop\.hermes\config.yaml`, mục `plugins.enabled` có `zalo-platform` nhưng thiếu block:
  ```yaml
  platforms:
    zalo:
      enabled: true
  ```
  Theo cơ chế 2 lớp của Hermes Gateway (xem mục 12):
  1. `plugins.enabled` nạp plugin và đăng ký adapter factory vào `platform_registry`.
  2. `platforms.<name>.enabled: true` chỉ thị cho Gateway thực sự khởi tạo và kết nối adapter đó khi boot. Nếu thiếu 1 trong 2 thì Gateway sẽ bỏ qua platform.

**Cách khắc phục:**
1. Đồng bộ lại plugin `zalo-platform` sang thư mục cấu hình user:
   ```powershell
   Copy-Item -Path "D:\Antigravity\hermes-zalo-plugin\hermes-plugin" -Destination "C:\Users\Desktop\.hermes\plugins\zalo-platform" -Recurse -Force
   ```
2. Thêm khai báo `platforms.zalo.enabled: true` vào `~/.hermes/config.yaml`:
   ```yaml
   platforms:
     zalo:
       enabled: true
   ```
3. Khởi động lại container `hermes`:
   ```powershell
   docker restart hermes
   ```
4. Kiểm tra `agent.log` và endpoint bridge:
   - Gateway log: `INFO gateway.run: ✓ zalo connected` và `Gateway running with 3 platform(s)`.
   - Bridge `/health`: `sseClients: 1` và `state: READY`.

### 31. Catchup & Replay Engine Hardening và Trạng thái DM Safe Degrade (2026-10-22)

**Bối cảnh & Vấn đề:**
- Khi bot Zalo reconnect hoặc khởi động lại, catchup scan quét lại lịch sử các thread theo checkpoint.
- Nếu có thread group bị kick/rời nhóm, API trả về `404 Not Found`. Do thiếu pruning, mỗi lần reconnect bot lại quét lại đúng các thread 404 này, gây vòng lặp WAF rate-limit `429 Too Many Requests` và Zalo server ngắt kết nối WebSocket (`1000 NORMAL_CLOSURE`).
- Ban đầu một số tài liệu dự định dùng `/api/message/loadmsg` cho DM. Tuy nhiên, probe thực tế ngày 2026-10-22 với đúng session `zpw_cht` (`https://lp6-msg.chat.zalo.me`) và AES mã hoá trả về `400 Bad Request` do thiếu các tham số schema nội bộ chỉ có trên web client đầy đủ.

**Giải pháp đã triển khai:**
1. **Group Catchup chính thức (`zaloClient.js`)**:
   - Sử dụng duy nhất `this.api.getGroupChatHistory(threadId, count)` chuẩn từ `zca-js`.
   - **429 Circuit Breaker**: Nếu gặp lỗi `429` / rate limit, `throw` ngay lập tức để dừng toàn bộ pass catchup hiện tại, bảo vệ tài khoản khỏi bị Zalo WAF kick.
2. **Quản lý Dead Thread & Pruning (`message-repository.js`, `zaloClient.js`)**:
   - Thêm cột `is_hidden` vào bảng `threads`.
   - `getCheckpointsForCatchup` lọc nghiêm ngặt `WHERE is_hidden = 0`.
   - Cơ chế 404-tracker với debounce 3 phút (180s): thread bị 404 liên tiếp 3 lần sẽ tự động ẩn (`hideThread(id)`).
   - Auto-unhide: Khi có tin nhắn live (`saveIncoming` hoặc `upsertCheckpoint`), thread tự động được mở ẩn (`is_hidden = 0`).
3. **Trạng thái DM Catchup (Safe Degrade)**:
   - Vì Zalo Web API không công khai schema hoàn chỉnh cho `loadmsg` DM cá nhân, `_fetchThreadHistory` cho DM được đưa về stub an toàn (trả về `[]`).
   - Loại bỏ hoàn toàn request phỏng đoán không mã hoá tới `wpa.chat.zalo.me` để tránh tự gây lỗi 404/429.
   - Tin nhắn DM 1-1 tiếp tục được tiếp nhận realtime qua WebSocket live (`listener.on("message")`) và lưu vào SQLite bình thường.

### 32. Treo Bridge do đụng độ Process (Zombie collision) và Sửa triệt để DM loadmsg (2026-10-28)

**Vấn đề:**
- Bot Zalo thỉnh thoảng bị treo, không phản hồi hoặc phản hồi lặp tin (double responses).
- Kiểm tra `/health` thấy `state: "DISCONNECTED"` với `historyFetchErrors` tăng cao.
- Kiểm tra process phát hiện có 2 phiên bản `server.js` chạy song song (PID cũ từ ngày trước chiếm loopback `127.0.0.1:8787`, còn instance mới chiếm `0.0.0.0:8787`), gây tranh chấp session Zalo WebSocket và phản hồi kép.
- Đồng thời `lib/message-repository.js` vẫn còn 2 điểm gọi `api.callRaw("loadmsg")` cho DM (`getRecentMessages` và `syncDMHistory`), gây lỗi `unknown zca-js API method: loadmsg`.
- `bridge-watchdog.js` trước đây chỉ gọi `/relogin` mà không set `{ forceQR: false }`, dẫn đến bridge bật cơ chế QR scan thay vì cookie relogin tự động. File `start_bridge.vbs` chạy trực tiếp `server.js` mà không qua watchdog.

**Nguyên nhân:**
1. Khởi động bridge thủ công không qua watchdog làm sót PID nền khi terminal đóng, dẫn tới đụng độ port và phiên Zalo khi khởi động lại.
2. Thiếu đồng bộ triệt để chính sách Safe Degrade cho DM trong `message-repository.js` (theo Fix 31).

**Cách khắc phục:**
1. **Dọn sạch process và chạy qua Watchdog duy nhất:**
   - Terminate toàn bộ các PID node orphan/xung đột.
   - Sửa `start_bridge.vbs` trỏ trực tiếp vào `bridge-watchdog.js` thay vì `server.js`.
2. **Cập nhật `bridge-watchdog.js`:**
   - Khi phát hiện `sessionDead` hoặc `!loggedIn`, gửi POST `/relogin` với body `{ forceQR: false }` để ưu tiên phục hồi bằng cookie tự động.
3. **Vá `message-repository.js`:**
   - Trong `getRecentMessages`: DM thread thực hiện safe degrade (trả về trực tiếp messages đã lưu trong SQLite, không fallback vào API `loadmsg`).
   - Trong `syncDMHistory`: Trả về `{ userId, status: "done", synced: 0 }` để hoàn tất sync an toàn không ném exception.

### 33. Vòng lặp tử thần Catchup WAF (Catchup Reconnect Death Loop) (2026-10-28 chiều)

**Vấn đề:**
- Bot Zalo đột ngột mất khả năng phản hồi tin nhắn; kiểm tra log thấy WebSocket liên tục bị ngắt kết nối với mã `1000 NORMAL_CLOSURE` mỗi 2-3 giây không ngừng (`disconnectCount` tăng vọt lên gần 100 lần).
- Trong khi vòng lặp xảy ra, socket không thể duy trì để nhận hoặc gửi tin nhắn bình thường.

**Nguyên nhân gốc rễ:**
- Khi kết nối WebSocket bị transient drop (code 1006 hoặc mạng chập chờn ~1s), `zca-js` tự reconnect.
- Sau khi reconnect, event `connected` kích hoạt hàm `_catchupMissedMessages()`.
- Hàm catchup quét lịch sử các thread theo checkpoint SQLite và gọi `getGroupChatHistory()` trên các nhóm chat lớn/hoạt động nhiều (như nhóm `6641674278740425467`).
- Phía máy chủ Zalo (WAF) phát hiện hành vi quét API lịch sử tự động ngay sau khi vừa mở socket nên chủ động gửi lệnh đóng WebSocket `1000 NORMAL_CLOSURE`.
- Sau khi bị đóng với code 1000, `zca-js` reconnect ngay lập tức → lại kích hoạt `_catchupMissedMessages()` → Zalo WAF lại đá văng → tạo thành một **vòng lặp vô tận (Death Loop)** ngắt kết nối liên tục.

**Cách khắc phục:**
1. **Khóa Catchup qua biến môi trường:**
   - Trong `bridge-watchdog.js` và `start-bridge.ps1`: đặt mặc định `ZALO_ENABLE_CATCHUP: "false"`.
   - Bổ sung `ZALO_LOG_MESSAGES: "1"` để hỗ trợ debug tin nhắn realtime.
2. **Cơ chế phòng vệ 2 lớp trong `zaloClient.js`:**
   - **Bỏ qua Catchup khi drop ngắn (< 30s):** Trong `_wireListeners()`, nếu ngắt kết nối tạm thời chỉ kéo dài dưới 30s thì chuyển thẳng sang `READY`, tuyệt đối không gọi `_catchupMissedMessages()`.
   - **Cooldown 5 phút:** Trong `_catchupMissedMessages()`, nếu lần catchup gần nhất cách chưa tới 5 phút (300.000ms), tự động bỏ qua và chuyển trạng thái về `READY`.

### 34. Sửa lỗi lệch 1-2 ký tự định dạng Markdown (In đậm, In nghiêng) (2026-11-03)

**Vấn đề:**
- Tin nhắn gửi qua Zalo có in đậm (`**bold**`), in nghiêng (`*italic*` hoặc `_italic_`), tiêu đề (`# Title`) bị bôi đậm/nghiêng lệch 1-2 chữ sang từ bên cạnh hoặc nuốt nhầm ký tự.

**Nguyên nhân:**
- Cơ chế parse regex cũ thay thế chuỗi trực tiếp hoặc tính chỉ số `start`, `len` dựa trên chuỗi gốc trước khi bóc tách cú pháp markdown.
- Khi các cú pháp như `**`, `*`, `_`, `~~`, `#` bị bóc tách khỏi văn bản, độ dài và chỉ mục ký tự trong chuỗi kết quả cuối cùng bị co ngắn lại. Nếu không tích lũy vị trí tuần tự theo chuỗi kết quả thuần (plain string), chỉ số offset sẽ bị trôi (offset drift) từ 1 đến 2 ký tự (hoặc nhiều hơn đối với tin nhắn dài hoặc có emoji/tiếng Việt).

**Cách khắc phục:**
1. **Viết lại bộ bóc tách Markdown tuần tự (`markdownToZalo.js`):**
   - Sử dụng thuật toán duyệt chuỗi lũy tiến (sequential accumulative regex parsing):
     ```javascript
     let lastIndex = 0;
     for (const match of src.matchAll(pattern)) {
       // Thêm phần text thuần nằm trước match vào chuỗi plain
       plain += src.slice(lastIndex, match.index);
       // Ghi nhận vị trí start CHÍNH XÁC theo độ dài chuỗi plain hiện tại
       const start = plain.length;
       plain += inner; // Thêm nội dung hiển thị đã lược bỏ cú pháp markdown
       const len = inner.length;
       styles.push({ start, len, st: styleType });
       lastIndex = match.index + match[0].length;
     }
     plain += src.slice(lastIndex);
     ```
   - Chuẩn hóa Unicode bằng `src.normalize("NFC")` giúp các dấu thanh tiếng Việt đồng nhất về độ dài ký tự trong JavaScript.
   - Sắp xếp và gộp các styles liền kề cùng loại (`styles.sort` & merge).

### 35. Lỗi Gateway không kết nối được Bridge do Windows Firewall chặn Docker (2026-11-03)

**Vấn đề:**
- Bot Zalo không phản hồi tin nhắn; Bridge Node.js đã bật và đang lắng nghe trên cổng `8787` (`0.0.0.0:8787`).
- Gateway log báo lỗi liên tục:
  ```
  ERROR hermes_plugins.zalo_platform.adapter: Zalo: cannot reach bridge at http://host.docker.internal:8787 — Cannot connect to host host.docker.internal:8787 ssl:default [Connect call failed ('192.168.65.254', 8787)]
  INFO gateway.run: Reconnect zalo failed, next retry in 300s
  ```

**Nguyên nhân:**
- Khi chạy Hermes Gateway bên trong Docker container, container gọi ngược về máy chủ Windows qua `host.docker.internal` (IP NAT của Docker Desktop là `192.168.65.254`).
- Windows Firewall chặn các kết nối Inbound từ dải mạng Docker tới cổng `8787` của host Windows nếu chưa có rule cho phép rõ ràng.

**Cách khắc phục:**
- Mở PowerShell với quyền **Administrator** trên Windows và tạo rule cho phép kết nối cổng 8787:
  ```powershell
  New-NetFirewallRule -DisplayName "Zalo Bridge 8787 (Docker)" `
    -Direction Inbound -Protocol TCP -LocalPort 8787 `
    -Action Allow -Profile Any
  ```
- Sau khi thêm rule, Gateway tự động kết nối lại thành công (`Zalo: connected to bridge http://host.docker.internal:8787`).

### 36. Lỗi Cronjob quét Văn bản đi: "Playwright not available, cannot scrape Văn bản đi" (2026-11-19)

**Vấn đề:**
- Cronjob "Quet cong van di" (job_id: `d7f9e2c1a4b6`) định kỳ lúc 08h và 15h các ngày T2-T6 gửi tin nhắn cảnh báo lỗi qua Zalo:
  ```
  Cronjob Response: Quet cong van di
  (job_id: d7f9e2c1a4b6)

  Playwright not available, cannot scrape Văn bản đi

  To stop or manage this job, send me a new message (e.g. "stop reminder Quet cong van di").
  ```

**Nguyên nhân gốc rễ:**
1. **Môi trường venv container thiếu Playwright:**
   - Khi container `hermes` được build/recreate từ Dockerfile, thư viện Python `playwright` chưa được đưa vào danh sách gói cài sẵn của `/opt/hermes/.venv`.
   - Trước đó gói `playwright` được cài đặt riêng lẻ vào thư mục người dùng trên volume (`~/.hermes/home/.local/lib/python3.14/site-packages`), nhưng khi Cronjob chạy dưới dạng subprocess qua `_posix_cron_script_argv`, Python venv chuẩn chỉ nạp `sys.path` của chính nó và thư mục gốc của repo, không nạp `~/.local` của thư mục home khác. Khi `congchuc_vbdi_scrape.py` gọi `import playwright.sync_api`, module bị `ImportError` -> gán `PLAYWRIGHT_AVAILABLE = False` -> in ra thông báo lỗi và thoát.
2. **Thiếu browser binary của Playwright:**
   - Pinned Chromium của image nằm tại `/opt/hermes/tools/chromium-1208`, trong khi Playwright phiên bản mới yêu cầu bản build Chromium headless shell phù hợp hoặc cấu hình `executable_path`.
3. **Lỗi `page.fill` trên Telerik RadDatePicker (Hidden Element):**
   - Script gốc `congchuc_vbdi_scrape.py` dùng `page.fill()` cho các trường nhập ngày tháng của Telerik RadGrid. Do các thẻ input này bị ẩn (hidden/styled), `page.fill()` bị timeout 60s trên mỗi lần thử.

**Cách khắc phục:**
1. **Cài đặt Playwright & Chromium vào môi trường runtime container:**
   - Chạy `uv pip install playwright` trực tiếp vào môi trường `/opt/hermes/.venv`.
   - Chạy `python3 -m playwright install chromium` để tải Chromium headless shell (`chromium_headless_shell-1255`) về `/opt/hermes/tools`.
   - Cập nhật `Dockerfile` (dòng 402) thêm `playwright` vào lệnh cài đặt gói venv cố định (`uv pip install ... openpyxl pandas playwright`) để không bị mất khi build lại container trong tương lai.
2. **Nâng cấp và vá lỗi script `congchuc_vbdi_scrape.py`:**
   - Bổ sung cơ chế auto-fallback `sys.path` tìm kiếm Playwright trong thư mục `.local` và tự động khôi phục bằng `uv` nếu thiếu.
   - Bổ sung hàm `_get_browser_executable()` đọc đường dẫn browser chuẩn từ `/etc/hermes/agent-browser-executable-path` hoặc `AGENT_BROWSER_EXECUTABLE_PATH`.
   - Chuyển thao tác điền ngày tháng từ `page.fill()` sang `page.evaluate()` bằng JavaScript kích hoạt sự kiện `change` trên DOM của Telerik, giúp bỏ qua tình trạng kẹt timeout 60s và quét dữ liệu xong chỉ trong ~10s.
   - Đồng bộ file script đã vá sang toàn bộ các thư mục script liên quan (`~/.hermes/scripts/congchuc/`, `~/.hermes/home/scripts/congchuc/`, `~/.hermes/skills/cc/scripts/`).

**Kết quả:**
- Chạy thử nghiệm thành công 100%: Quét chính xác 10 văn bản đi mới nhất ngày 19/11/2026, cập nhật trạng thái vào `vbdidi_state.json` và tái sử dụng session đăng nhập thành công. Ở các lần quét tiếp theo khi không có văn bản mới, script kết thúc im lặng và không làm phiền người dùng.

---

## 📚 Tham khảo

- [zaloclaw](https://github.com/monas-team/zaloclaw) — Plugin Zalo cho OpenClaw, nguồn cảm hứng cho keepAlive mechanism
- [zca-js](https://github.com/nicholasxuu/zca-js) — Thư viện Zalo unofficial API
- `D:\Antigravity\hermes-zalo-plugin\zaloClient.js` — File đã sửa
- `D:\Antigravity\hermes-zalo-plugin\server.js` — Bridge chính (đã có auto-relogin)


