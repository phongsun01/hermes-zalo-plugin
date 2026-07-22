# Changelog

All notable changes to the `hermes-zalo-plugin` project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **SQLite Message Store (replaces JSON checkpoint)**:
  - New `lib/sqlite-store.js` — pure DAO with `sql.js` (WASM, no native deps): 5 tables (`messages`, `attachments`, `threads`, `friends`, `sync_state`), WAL-like journal, `PRAGMA user_version`-based migrations, `chmod 600` on db file, transaction helper.
  - New `lib/message-repository.js` — orchestrator: `saveIncoming()` (insert + checkpoint + thread upsert in one transaction), `saveHistory()` (batch), `getContext()`, `search()`, checkpoint CRUD, `migrateFromJson()` (legacy → SQLite), sync state tracking.
- **Live message persistence**: `zaloClient.js` now fire-and-forgets `repository.saveIncoming(ev)` on every live message (non-blocking, SSE emits first).
- **Self-loop aware direction**: Messages are stored with `direction: 'incoming'` or `'outgoing'` based on the `isSelf` flag.
- **SQLite health status**: `/health` endpoint now exposes `sqlite.messages|threads|attachments|syncPending|syncTotal` instead of the old JSON checkpoint fields.
- **`lib/` index & smoke tests**: `lib/index.js` re-exports; `scratch/test_sqlite_store.js` (13 tests) + updated `scratch/test_checkpoint.js` (15 tests, all green).

### Changed
- **zaloClient.js checkpoint engine**: Replaced `_checkpoint` (in-memory JSON), `_loadCheckpoint`, `_saveCheckpoint`, `_checkpointChanged`, `_checkpointTimer` with SQLite-backed `_store`/`_repository`/`_dbChanged`/`_dbTimer`. Migration path: `migrateFromJson()` reads legacy `thread_checkpoint.json` and upserts into SQLite `threads` table.
- **Graceful shutdown**: `_setupGracefulFlush` and `shutdown()` now persist db + close store instead of writing JSON.
- **Catchup**: `_catchupMissedMessages()` reads checkpoints from `repository.getCheckpointsForCatchup()` instead of in-memory dict.
- **Dependency**: Added `sql.js` (pure JS SQLite, no native compilation) instead of `better-sqlite3`.

### Fixed
- **Atomic persist**: `persist()` now writes to `.tmp` then `renameSync` để tránh corruption nếu crash giữa lúc ghi file.
- **message_uid compound key**: Đổi từ `message_id UNIQUE` sang `message_uid = threadId:msgId` để tránh duplicate key crash khi 2 thread khác nhau có cùng msgId (hoặc msgId rỗng).
- **getContext sai thứ tự**: Sửa `ORDER BY ts ASC LIMIT N` → subquery `DESC LIMIT N` rồi outer `ASC` — trả về N tin mới nhất (không phải cũ nhất).
- **Duplicate checkpoint upsert**: Live handler không còn gọi `_updateThreadLastSeen` — `saveIncoming` tự upsert checkpoint + trigger persist qua `onDirty`.
- **onDirty callback**: Repository tự gọi `onDirty()` sau mọi write operation, không cần zaloClient quản lý cờ `_dbChanged` thủ công.

### Added (Phase 2 — Sync)
- **HistorySync (`lib/history-sync.js`)**: Resumable sync engine. `start()` syncs friends + resumes pending/error entities; `resume()` continues from `sync_state`; `stop()` sets flag. Non-blocking, runs after login.
- **InMemoryCache (`lib/in-memory-cache.js`)**: LRU msgId→cliMsgId (500 entries), Set groupId, Map friend (2000 entries). Best-effort, persistence in SQLite only.
- **Repository sync methods**: `syncGroupHistory()` — fetch group chat history via API, batch insert with `source='sync'`, update `sync_state` with cursor; `syncDMHistory()` — DM via `loadmsg` API; `syncFriends()` — upsert full friend directory; `syncResume()` — continue pending/error entities.
- **DM catchup via loadmsg**: `_fetchThreadHistory()` now calls `api.callRaw('loadmsg', ...)` for DM threads (previously skipped silently).
- **Schema v3**: Added `cli_msg_id`, `quote_msg_id`, `quote_cli_msg_id`, `quote_owner_id`, `status`, `source` columns to `messages`; `mime_type`, `file_path`, `raw_json` to `attachments`; `title`, `peer_id`, `avatar_url`, `is_hidden`, `raw_json` to `threads`; `zalo_name`, `raw_json` to `friends`. Recreated `sync_state` with composite PK `(entity_type, entity_id)` + `cursor` and `synced_count` columns.
- **Quote persistence**: `saveIncoming()` now stores `quote_msg_id`, `quote_cli_msg_id`, `quote_owner_id` from the normalized event.
- **Source tracking**: Each message row records `source` (`live`, `catchup`, `sync`) to distinguish origin.
- **/health enhancements**: Exposes `sqlite.dbVersion`, `cache.*`, `historySync.*` (running, startedAt, lastError), `sqlite.syncDone`.

### Changed
- **saveHistory()** accepts optional `source` parameter (default `'sync'`).
- **upsertSyncState()** now uses composite PK + cursor/synced_count.
- **sync_state** queries use composite PK ordering.
- **Dependency**: No new packages (sql.js already added in Phase 1).

## [Unreleased] (previous)

### Added
- **Group Image Bulk Downloader (`/group/download-images` & `/zl taianh`)**:
  - Added new REST endpoint `POST /group/download-images` with job tracking and SSE `download_progress` event streaming.
  - Added `/zl taianh` slash command & natural language handler ("tải hết ảnh trong group", "tải ảnh từ ngày DD/MM/YYYY") in Python `adapter.py`.
  - Added fallback to Zalo `loadmsg` API (`https://wpa.chat.zalo.me/api/message/loadmsg`) via zca-js authenticated session context.
  - Added parallel batch downloading with concurrency limit (`5` parallel downloads) and image magic byte validation.
- **Security & Stability Safeguards**:
  - Added rate limiting (`express-rate-limit`) on outbound routes (`/send`, `/send-attachment`, `/send-voice`, `/api/*`) capping requests at 60/min to prevent AI loop account blocks.
  - Added HTTP request logging middleware (`morgan("dev")`).
  - Added global Express error handling middleware to catch unhandled async errors cleanly.
  - Added 30-second timeout guard (`Promise.race`) for generic passthrough `/api/:method` calls to prevent hanging sockets.
  - Added `ZALO_LOG_MESSAGES` environment variable flag (default off) to prevent sensitive raw chat payloads from leaking into console logs.
- **Process Boot ID Tracking (`X-Bridge-Boot-Id`)**: Introduced process-unique `BOOT_ID` to `/health` and SSE `/events` response header `X-Bridge-Boot-Id` so SSE consumers can differentiate process restarts from transient network drops.

### Fixed
- **Markdown Style Index Shift (`sendText`)**: Strip structural markdown tags (`code`, `header`, `link`, `blockquote`) *before* matching bold/italic styles to preserve exact character index offsets on Zalo.
- **Italic Regex Word Boundary Guard**: Added non-whitespace boundary guards to italic regex matching (`(?<=\s|^)_(?!\s)...(?<!\s)_(?=\s|$)`) to prevent false-positive italic matches on filenames, variables, and phone numbers.
- **File Extension Extraction (`_normaliseMessage`)**: Fixed bug where files without dots incorrectly returned the entire title as the file extension instead of falling back to `"bin"`.
- **Memory Leak in Info Cache (`_infoCache`)**: Added size bounding (max 10,000 items) to automatically trim old cache entries.
- **Ring Buffer Optimization**: Replaced continuous `.shift()` on arrays with chunked `.splice()` when exceeding threshold ($1.5 \times \text{SIZE}$).
- **SSE Frame Pre-Serialization**: Pre-serialized SSE frames in `pushEvent()` to eliminate repetitive `JSON.stringify()` calls on SSE event replay.
- **SSE Replay Over-Correction (`adapter.py`)**: Adapter no longer blindly drops `Last-Event-ID` on every disconnect. Bridge now sends `X-Bridge-Boot-Id`; adapter only resets its event cursor when this boot ID changes (i.e., when the bridge process actually restarted), preserving replay functionality across transient network drops.
- **Media Download I/O Blocking (`adapter.py`)**: Added bounded `total=30s` and `sock_read=25s` timeout to `_download_media()`.
- **CLI Terminal Layout Breaking (`adapter.py`)**: Truncated long group/contact names (>50 chars) in the interactive setup wizard picker.

### Changed
- **Direct Voice Path Routing (`adapter.py`)**: Routed local audio paths directly to `/send-voice` instead of unnecessary fallback to `/send-attachment`.
- **Message Splitting Sleep (`adapter.py`)**: Increased sleep between long message chunks from `0.2s` to `0.5s` to reduce rate-limit & spam detection risks.
