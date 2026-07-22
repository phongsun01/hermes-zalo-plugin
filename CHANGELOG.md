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
- **Foreign key schema**: `messages.message_id` is now `UNIQUE` so `attachments` FK constraint works correctly with `ON DELETE CASCADE`.

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
