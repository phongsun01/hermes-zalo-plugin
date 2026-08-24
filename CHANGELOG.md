# Changelog

All notable changes to the `hermes-zalo-plugin` project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Inbound Styled Text to Markdown (`zaloClient.js`)**: Converts received Zalo styled messages (bold, italic) into standard Markdown formatting (`**bold**`, `_italic_`) so LLMs and downstreams receive structured text.
- **Send Images from URL (`adapter.py`)**: `send_image` / `send_image_file` now automatically downloads images from HTTP/HTTPS URLs and encodes them as base64 attachments.
- **Rich Text Formatting for Outbound Messages (`zaloClient.js`)**: Parses outbound markdown bold (`**bold**` / `__bold__`) and italic (`_italic_`) into Zalo native `styles` objects while preserving markdown bullet points and ordered lists.
- **SQLite Persistent Storage (`zaloClient.js`)**: Replaced file-based JSON state with SQLite (`sql.js`) at `~/.hermes-zalo/zalo.sqlite` for persistent `cliMsgId` mapping and checkpoints.

### Fixed
- **Large Message Payload & Rich Text Fallback (Zalo Error 112)**:
  - Reduced default `max_message_length` in `adapter.py` from `4000` to `1500` chars (with `ZALO_MAX_MESSAGE_LENGTH` env override) to stay well within Zalo unofficial API single-message payload limits.
  - Added auto-fallback in `zaloClient.js` `sendText`: if sending with rich text `styles` fails (error code 112 / offset mismatch), it automatically retries as clean plain text.
  - Added auto-split in `zaloClient.js` `sendText`: if a large message (>1200 chars) fails, it automatically splits at paragraph breaks and delivers sequentially.
- **SSE Client Kick Loop on Reconnect (`adapter.py`)**: `connect()` now cancels any existing/dangling `_sse_task` before launching a new SSE inbound loop, preventing concurrent SSE tasks from competing and causing infinite kick-reconnect loops.
- **List Bullet Point Stripping**: Fixed regex patterns in `sendText` so single-asterisk bullet points (`* item`) are not mistakenly parsed and erased as italic markers.

## [v1.0.8] - Previous

### Changed
- **`zaloClient.js` — Shared content classification + quote media extraction**: Inline ~70-line content classification refactored into shared `classifyContent(msgType, c)` function reused for both `data.content` and `data.quote.attach`. Added `CLIMSGTYPE_TO_MSGTYPE` map for numeric→string msgType conversion. `_normaliseMessage` now returns `quotedText`, `quotedFrom`, `quotedMedia`, `quotedAttachment` from the quoted message.
- **`adapter.py` — `_parse_home_channel` rejects bare IDs**: Bare thread IDs without `group:`/`user:` prefix now return empty (no-op delivery) with a warning, preventing silent misrouting to wrong thread.

### Added
- **Quote reply context for AI**: Bridge now forwards `quotedText` (text content of the replied-to message), `quotedFrom` (sender name), `quotedMedia` (media object via `classifyContent` on `data.quote.attach`), and `quotedAttachment` to the adapter. Adapter downloads quoted media so the agent can see replied-to images/files, and prepends a `[Trả lời <name>: "text" (kèm media)]\n` prefix to the message text.

### Fixed
- **ZALO_HOME_CHANNEL bare ID footgun**: IDs without `group:`/`user:` prefix are now rejected with a clear warning, preventing cron delivery to wrong threads.
- **`quotedOwnerId` undeclared variable**: Fixed ReferenceError in strict ESM mode — `let quotedOwnerId` was being assigned without declaration in `_normaliseMessage`.

### Removed
- **Reverted thread routing bridge lookup**: `/thread-type/:threadId` route in `server.js` and async bridge fallback in `_thread_type_from_chat_id` removed — the bridge SQLite lookup approach did not resolve the cron thread routing issue. `_thread_type_from_chat_id` restored to simple sync cache-check with `"user"` default; all 9 callers restored to sync calls.

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
