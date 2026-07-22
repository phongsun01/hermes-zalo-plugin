// zaloClient.js
// Thin wrapper around zca-js handling login (cookie-first, QR fallback),
// message listening, and outbound sends. Emits normalised inbound events.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Zalo, ThreadType, LoginQRCallbackEventType, Reactions } from "zca-js";
import { createStore, createRepository, createCache, HistorySync } from "./lib/index.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

// Zalo drops idle/old sessions even while the websocket is technically open.
// zca-js sends a WS-level ping (cmd:2) automatically, but never calls the
// HTTP /keepalive endpoint — so we poke it ourselves to keep the session warm.
const KEEPALIVE_INTERVAL_MS = 60_000;
// When the listener permanently CLOSES on a non-fatal code, try to recover the
// session automatically with the saved cookie (no QR) before giving up. Linear
// backoff (attempt * base, capped); the budget is replenished on every healthy
// reconnect (the "connected" event), so only a sustained outage exhausts it.
const AUTO_RELOGIN_BASE_MS = 5_000;
const AUTO_RELOGIN_MAX_MS = 60_000;
const MAX_AUTO_RELOGIN_ATTEMPTS = 5;

// TQuote.cliMsgType (numeric) → msgType string, inverse of zca-js's
// getClientMessageType(). Used when reclassifying quoted-message content
// (data.quote.attach), which only has cliMsgType, not msgType.
const CLIMSGTYPE_TO_MSGTYPE = {
  1: "webchat",
  31: "chat.voice",
  32: "chat.photo",
  36: "chat.sticker",
  37: "chat.doodle",
  38: "chat.recommended",
  43: "chat.location.new",
  44: "chat.video.msg",
  46: "share.file",
  49: "chat.gif",
};

/**
 * Classify a content object by msgType into {text, attachment, media}.
 * Shared between main message content (data.content) and quoted-message
 * content (JSON.parse(data.quote.attach)).
 */
function classifyContent(msgType, c) {
  let text = "";
  let attachment = null;
  let media = null;

  if (typeof c === "string") {
    return { text: c, attachment: null, media: null };
  }
  if (!c || typeof c !== "object") {
    return { text: "", attachment: null, media: null };
  }

  let params = {};
  try {
    params = typeof c.params === "string" ? JSON.parse(c.params) : c.params || {};
  } catch {
    params = {};
  }

  attachment = {
    title: c.title || "",
    description: c.description || "",
    href: c.href || "",
    thumb: c.thumb || "",
    type: c.type || msgType || "",
    params,
  };

  const kindMap = {
    "chat.photo": "image",
    "chat.gif": "image",
    "chat.voice": "voice",
    "chat.video.msg": "video",
    "share.file": "file",
    "chat.sticker": "sticker",
    "chat.recommended": "contact",
    "chat.location.new": "location",
  };
  const kind = kindMap[msgType] || "other";

  if (kind === "voice") {
    const url = params.m4a || c.href || "";
    media = { kind, url, fileName: "voice.aac", ext: "aac", mime: "audio/aac", size: params.fileSize || 0 };
    text = "[voice message]";
  } else if (kind === "image") {
    media = {
      kind,
      url: params.hd || c.href || "",
      fileName: "image.jpg",
      ext: "jpg",
      mime: "image/jpeg",
      size: params.fileSize || 0,
      width: params.width || 0,
      height: params.height || 0,
    };
    text = c.description || "";
  } else if (kind === "video") {
    media = { kind, url: c.href || "", fileName: "video.mp4", ext: "mp4", mime: "video/mp4", size: params.fileSize || 0 };
    text = c.description || "";
  } else if (kind === "file") {
    const parts = (c.title || "").split(".");
    const ext = params.fileExt || (parts.length > 1 ? parts.pop().toLowerCase() : "bin");
    media = { kind, url: c.href || "", fileName: c.title || `file.${ext}`, ext, mime: "application/octet-stream", size: params.fileSize || 0 };
    text = `[file: ${c.title || ""}]`;
  } else if (kind === "contact") {
    let info = {};
    try {
      info = typeof c.description === "string" ? JSON.parse(c.description) : c.description || {};
    } catch {
      info = {};
    }
    attachment.contact = { name: c.title || "", phone: info.phone || "", gUid: info.gUid || "" };
    text = `[contact: ${c.title || ""}${info.phone ? " " + info.phone : ""}]`;
  } else if (kind === "sticker") {
    text = "[sticker]";
  } else if (kind === "location") {
    text = "[location]";
  } else {
    text = c.title || c.description || "";
  }

  return { text, attachment, media };
}

/**
 * Read image dimensions from a local file by parsing the header bytes.
 * Supports PNG, JPEG, GIF, WebP, BMP — no external deps. Returns null if
 * dimensions can't be determined (zca-js then errors, surfaced to caller).
 */
async function readImageMetadata(filePath) {
  try {
    const buf = await fs.promises.readFile(filePath);
    const size = buf.length;
    let width = 0;
    let height = 0;

    if (buf.length >= 24 && buf.toString("ascii", 1, 4) === "PNG") {
      // PNG: IHDR at offset 16
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG: scan SOF markers
      let off = 2;
      while (off < buf.length) {
        if (buf[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = buf[off + 1];
        // SOF0..SOF15 except DHT(c4)/DNL(c8)/DAC(cc)
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          height = buf.readUInt16BE(off + 5);
          width = buf.readUInt16BE(off + 7);
          break;
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    } else if (buf.toString("ascii", 0, 3) === "GIF") {
      width = buf.readUInt16LE(6);
      height = buf.readUInt16LE(8);
    } else if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const fmt = buf.toString("ascii", 12, 16);
      if (fmt === "VP8 ") {
        width = buf.readUInt16LE(26) & 0x3fff;
        height = buf.readUInt16LE(28) & 0x3fff;
      } else if (fmt === "VP8L") {
        const b = buf.readUInt32LE(21);
        width = (b & 0x3fff) + 1;
        height = ((b >> 14) & 0x3fff) + 1;
      } else if (fmt === "VP8X") {
        width = (buf.readUIntLE(24, 3) & 0xffffff) + 1;
        height = (buf.readUIntLE(27, 3) & 0xffffff) + 1;
      }
    } else if (buf.toString("ascii", 0, 2) === "BM") {
      width = buf.readInt32LE(18);
      height = Math.abs(buf.readInt32LE(22));
    }

    if (!width || !height) return null;
    return { width, height, size };
  } catch {
    return null;
  }
}

export class ZaloClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.credentialsPath  Where to persist credentials JSON.
   * @param {string} opts.qrPath           Where to write the QR PNG during login.
   * @param {boolean} opts.selfListen      Whether to receive our own messages.
   */
  constructor({ credentialsPath, qrPath, selfListen = false, dbPath = null, cliMsgDir = null, cliMsgRetentionDays = 30, infoCacheTtlMs = 600000, infoMinIntervalMs = 1500 }) {
    super();
    this.credentialsPath = credentialsPath;
    this.qrPath = qrPath;
    this.selfListen = selfListen;
    this.api = null;
    this.ownId = null;
    this.loggedIn = false;
    this.sessionDead = false;
    this.sessionDeadReason = null;
    this._qrState = null; // { image, status } during a QR login flow
    // Session keepalive + auto-recovery timers/state (see _startKeepAlive,
    // _scheduleAutoRelogin). _reconnecting guards against overlapping attempts.
    this._keepAliveTimer = null;
    this._autoReloginTimer = null;
    this._autoReloginAttempts = 0;
    this._reconnecting = false;
    // Cache msgId -> { cliMsgId, ts } so undo() works without the caller
    // knowing the client id (zca-js generates clientId internally and doesn't
    // return it; the listener echo carries the real cliMsgId).
    // Persisted to daily-rotated JSONL files under cliMsgDir, kept 30 days,
    // and reloaded on startup so undo survives restarts. In-memory Map is the
    // fast path, bounded so RAM can't grow unbounded.
    this._cliMsgIds = new Map();
    this._cliMsgMaxEntries = 50000;
    // Retention window for the persisted cache. Configurable; 0 or negative
    // disables persistence (memory-only). Default 30 days.
    this._cliMsgRetentionDays = Number.isFinite(cliMsgRetentionDays) ? cliMsgRetentionDays : 30;
    this._cliMsgPersist = this._cliMsgRetentionDays > 0;
    this._cliMsgDir =
      cliMsgDir || path.join(path.dirname(this.credentialsPath), "climsgids");
    this._cliMsgStream = null;
    this._cliMsgStreamDay = null;

    // ── Info cache + rate limiter (anti rate-limit / account-lock) ──────────
    // zca-js is an unofficial API; hammering getUserInfo/getGroupInfo/getAll*
    // risks a temporary block or "abnormal activity" flag. We:
    //   1) cache read-info results by key with a TTL (default 10 min);
    //   2) serialize info calls through a queue with a minimum gap between them;
    //   3) on a suspected rate-limit error, apply exponential backoff and serve
    //      stale cache (if any) instead of hammering further.
    this._infoCache = new Map(); // key -> { value, ts }
    this._infoCacheTtlMs = Number.isFinite(infoCacheTtlMs) ? infoCacheTtlMs : 600000;
    this._infoMinIntervalMs = Number.isFinite(infoMinIntervalMs) ? infoMinIntervalMs : 1500;
    this._infoLastCallAt = 0;
    this._infoQueue = Promise.resolve(); // serializes info calls
    this._infoBackoffUntil = 0; // epoch ms; while > now, refuse fresh calls
    this._infoBackoffMs = 0; // current backoff window (grows on repeated limits)

    // ── SQLite store & repository (replaces JSON checkpoint) ───────────────
    this._dbPath = dbPath || path.join(path.dirname(this.credentialsPath), "zalo.sqlite");
    this.checkpointPath = path.join(path.dirname(this.credentialsPath), "thread_checkpoint.json");
    this._store = null;
    this._repository = null;
    this._dbChanged = false;
    this._dbTimer = null;

    // Config clamping
    const clamp = (val, min, max, def) => {
      const n = parseInt(val, 10);
      return Number.isInteger(n) ? Math.max(min, Math.min(n, max)) : def;
    };
    this.maxTrackedThreads = clamp(process.env.ZALO_MAX_TRACKED_THREADS, 10, 500, 100);
    this.maxMessagesPerThread = clamp(process.env.ZALO_MAX_MESSAGES_PER_THREAD, 1, 200, 50);
    this.maxCatchupWindowMs = clamp(process.env.ZALO_CATCHUP_MAX_WINDOW_MS, 300000, 86400000, 7200000); // 5m to 24h, default 2h

    // State machine & Lifecycle
    this.state = "DISCONNECTED"; // DISCONNECTED, CONNECTING, CONNECTED, CATCHUP, READY
    this._hasConnectedOnce = false;
    this._catchingUp = false;
    this._keepAliveConsecutiveFailures = 0;

    // Statistics
    this._stats = {
      disconnectCount: 0,
      lastDisconnectDurationMs: 0,
      keepAliveFailures: 0,
      lastCatchupAt: 0,
      recoveredCount: 0,      // cumulative (all-time)
      lastRecoveredCount: 0,  // per-catchup count
      historyFetchErrors: 0,
    };
    this._lastDisconnectAt = 0;

    // Setup graceful flush handlers for process signals
    this._setupGracefulFlush();
  }

  // ── Rate-limited, cached read-info gateway ────────────────────────────────
  _isRateLimitError(err) {
    const msg = String((err && err.message) || err || "").toLowerCase();
    return (
      msg.includes("rate") ||
      msg.includes("too many") ||
      msg.includes("limit") ||
      msg.includes("429") ||
      msg.includes("abnormal") ||
      msg.includes("spam")
    );
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Run a read-info fetch with caching + serialized rate limiting + backoff.
   * @param {string} key      cache key (e.g. "group:123")
   * @param {Function} fetcher async () => value
   * @param {object} opts      { ttlMs?, force? }
   */
  async _cachedInfo(key, fetcher, { ttlMs = this._infoCacheTtlMs, force = false } = {}) {
    const now = Date.now();
    const hit = this._infoCache.get(key);
    if (!force && hit && now - hit.ts < ttlMs) {
      return hit.value;
    }
    // If we're in a backoff window, serve stale cache rather than hammering.
    if (now < this._infoBackoffUntil) {
      if (hit) {
        console.warn(`[zalo] info backoff active; serving stale cache for ${key}`);
        return hit.value;
      }
      const waitS = Math.ceil((this._infoBackoffUntil - now) / 1000);
      throw new Error(`Zalo info calls are backing off (rate-limited); retry in ~${waitS}s`);
    }
    // Serialize through the queue so concurrent callers don't burst.
    const run = this._infoQueue.then(async () => {
      const gap = Date.now() - this._infoLastCallAt;
      if (gap < this._infoMinIntervalMs) await this._sleep(this._infoMinIntervalMs - gap);
      try {
        const value = await fetcher();
        this._infoLastCallAt = Date.now();
        this._infoCache.set(key, { value, ts: Date.now() });
        // Prevent memory leak by bounding cache size
        if (this._infoCache.size > 10000) {
          const it = this._infoCache.keys();
          for (let i = 0; i < 1000; i++) this._infoCache.delete(it.next().value);
        }
        // success resets backoff
        this._infoBackoffMs = 0;
        this._infoBackoffUntil = 0;
        return value;
      } catch (e) {
        this._infoLastCallAt = Date.now();
        if (this._isRateLimitError(e)) {
          this._infoBackoffMs = Math.min(this._infoBackoffMs ? this._infoBackoffMs * 2 : 5000, 300000);
          this._infoBackoffUntil = Date.now() + this._infoBackoffMs;
          console.warn(`[zalo] rate-limit suspected on ${key}; backing off ${this._infoBackoffMs}ms`);
          if (hit) return hit.value; // serve stale on limit
        }
        throw e;
      }
    });
    // keep the queue chained but don't let a rejection break it
    this._infoQueue = run.catch(() => {});
    return run;
  }

  _loadCredentials() {
    try {
      if (fs.existsSync(this.credentialsPath)) {
        const raw = fs.readFileSync(this.credentialsPath, "utf-8");
        const c = JSON.parse(raw);
        if (c && c.cookie && c.imei && c.userAgent) return c;
      }
    } catch (e) {
      console.error("[zalo] failed to read credentials:", e.message);
    }
    return null;
  }

  _saveCredentials(cred) {
    try {
      fs.mkdirSync(path.dirname(this.credentialsPath), { recursive: true });
      fs.writeFileSync(this.credentialsPath, JSON.stringify(cred, null, 2), "utf-8");
      console.log("[zalo] credentials saved to", this.credentialsPath);
    } catch (e) {
      console.error("[zalo] failed to save credentials:", e.message);
    }
  }

  get qrState() {
    return this._qrState;
  }

  // ── cliMsgId persistence (daily-rotated JSONL, 30-day retention) ──────────

  _cliMsgDayStr(d = new Date()) {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  _cliMsgFilePath(day) {
    return path.join(this._cliMsgDir, `climsgids-${day}.jsonl`);
  }

  /** Record a msgId -> cliMsgId mapping in memory and append to today's file. */
  _recordCliMsgId(msgId, cliMsgId) {
    const key = String(msgId);
    if (this._cliMsgIds.has(key)) return; // already known
    const ts = Date.now();
    this._cliMsgIds.set(key, { cliMsgId: String(cliMsgId), ts });

    // Bound RAM (rare; persistence holds the durable copy).
    if (this._cliMsgIds.size > this._cliMsgMaxEntries) {
      const it = this._cliMsgIds.keys();
      for (let i = 0; i < 5000; i++) {
        const k = it.next().value;
        if (k === undefined) break;
        this._cliMsgIds.delete(k);
      }
    }

    try {
      if (!this._cliMsgPersist) return; // persistence disabled (retention<=0)
      const day = this._cliMsgDayStr();
      if (!this._cliMsgStream || this._cliMsgStreamDay !== day) {
        if (this._cliMsgStream) this._cliMsgStream.end();
        fs.mkdirSync(this._cliMsgDir, { recursive: true });
        this._cliMsgStream = fs.createWriteStream(this._cliMsgFilePath(day), { flags: "a" });
        this._cliMsgStreamDay = day;
        this._pruneCliMsgFiles(); // prune on each daily rotation
      }
      this._cliMsgStream.write(JSON.stringify({ m: key, c: String(cliMsgId), t: ts }) + "\n");
    } catch (e) {
      console.error("[zalo] cliMsgId persist failed:", e.message);
    }
  }

  /** Resolve a cliMsgId from memory (fast path). */
  _lookupCliMsgId(msgId) {
    const rec = this._cliMsgIds.get(String(msgId));
    return rec ? rec.cliMsgId : null;
  }

  /** Load the last `retentionDays` of JSONL files into memory on startup. */
  _loadCliMsgCache() {
    try {
      if (!this._cliMsgPersist) return; // persistence disabled
      if (!fs.existsSync(this._cliMsgDir)) return;
      const cutoff = Date.now() - this._cliMsgRetentionDays * 86400_000;
      const files = fs
        .readdirSync(this._cliMsgDir)
        .filter((f) => /^climsgids-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort(); // chronological; later files overwrite earlier (newest wins)
      let loaded = 0;
      for (const f of files) {
        const dayStr = f.slice("climsgids-".length, "climsgids-".length + 10);
        const dayMs = Date.parse(dayStr + "T00:00:00Z");
        if (!Number.isNaN(dayMs) && dayMs < cutoff - 86400_000) continue; // skip too-old files
        const full = path.join(this._cliMsgDir, f);
        for (const line of fs.readFileSync(full, "utf-8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.m && o.c && (o.t || 0) >= cutoff) {
              this._cliMsgIds.set(String(o.m), { cliMsgId: String(o.c), ts: o.t || 0 });
              loaded++;
            }
          } catch {
            /* skip corrupt line */
          }
        }
      }
      if (loaded) console.log(`[zalo] loaded ${loaded} cached cliMsgId mappings (<=30d)`);
    } catch (e) {
      console.error("[zalo] cliMsgId cache load failed:", e.message);
    }
  }

  /** Delete JSONL files older than the retention window. */
  _pruneCliMsgFiles() {
    try {
      if (!fs.existsSync(this._cliMsgDir)) return;
      const cutoffDay = this._cliMsgDayStr(new Date(Date.now() - this._cliMsgRetentionDays * 86400_000));
      for (const f of fs.readdirSync(this._cliMsgDir)) {
        const m = f.match(/^climsgids-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m && m[1] < cutoffDay) {
          try {
            fs.unlinkSync(path.join(this._cliMsgDir, f));
            console.log("[zalo] pruned old cliMsgId file:", f);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      console.error("[zalo] cliMsgId prune failed:", e.message);
    }
  }

  /**
   * Attempt login. If saved credentials exist, use them. Otherwise run the
   * QR flow: writes the QR PNG, exposes base64 via qrState, resolves once the
   * phone confirms. Throws on hard failure.
   */
  async login({ forceQR = false, cookieOnly = false } = {}) {
    const zalo = new Zalo({
      // Always self-listen at the zca-js layer so we can capture the real
      // cliMsgId of our own sent messages (needed for undo). We still filter
      // self messages before emitting to SSE (see _normaliseMessage), unless
      // the operator explicitly opted into selfListen.
      selfListen: true,
      logging: false,
      imageMetadataGetter: readImageMetadata,
    });

    const saved = forceQR ? null : this._loadCredentials();
    if (saved) {
      try {
        console.log("[zalo] logging in with saved credentials...");
        this.api = await zalo.login(saved);
        await this._afterLogin();
        return { method: "cookie" };
      } catch (e) {
        console.error("[zalo] cookie login failed:", e.message);
        // Headless auto-relogin must NOT drop into an interactive QR flow that
        // would block forever in a service. Surface the failure to the caller.
        if (cookieOnly) throw e;
        console.error("[zalo] falling back to QR.");
      }
    } else if (cookieOnly) {
      throw new Error("cookie relogin requested but no saved credentials");
    }

    // QR login. Renders a scannable QR + live countdown in the terminal when
    // stdout is a TTY (interactive `login`/`setup`); a background service (no
    // TTY) just logs one line so its log files stay clean.
    console.log("[zalo] starting QR login...");
    this._qrState = { status: "generating", image: null };

    const tty = !!process.stdout.isTTY;
    let qrterm = null; // optional dep, imported lazily on first QR
    let countdownTimer = null;
    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const stopCountdown = (finalLine) => {
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      if (tty) process.stdout.write("\r\x1b[2K" + (finalLine ? finalLine + "\n" : ""));
    };
    const startCountdown = () => {
      if (!tty) return;
      let left = 100; // zca-js expires the QR after 100s
      const tick = () => {
        process.stdout.write(
          `\r\x1b[2K  ⏳ Auto-refreshes in ${fmt(Math.max(left, 0))} if not scanned  ·  Ctrl-C to cancel`,
        );
        left--;
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
      if (countdownTimer.unref) countdownTimer.unref();
    };
    const showQr = async (token) => {
      if (!tty) {
        console.log("[zalo] QR generated. Scan", this.qrPath, "with the Zalo app.");
        return;
      }
      if (qrterm === null) {
        try { qrterm = (await import("qrcode-terminal")).default; } catch { qrterm = false; }
      }
      const finishWith = (qrText) => {
        console.log("");
        if (qrText) console.log(qrText);
        console.log("  📱 Open Zalo → (+) → Scan QR code, point your phone at the screen");
        console.log(`  (fallback) or open the image: ${this.qrPath}`);
        startCountdown();
      };
      if (qrterm) qrterm.generate(token, { small: true }, finishWith);
      else finishWith(null);
    };

    this.api = await zalo.loginQR(
      { userAgent: DEFAULT_UA, qrPath: this.qrPath },
      (event) => {
        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            this._qrState = { status: "waiting_scan", image: event.data.image };
            // zca-js does NOT auto-save the PNG when a callback is supplied, so
            // persist it ourselves (for /qr.png and the file fallback).
            try {
              fs.writeFileSync(
                this.qrPath,
                String(event.data.image || "").replace(/^data:image\/png;base64,/, ""),
                "base64",
              );
            } catch {
              /* ignore */
            }
            // The QR image encodes event.data.token (a zaloapp.com/qr URL), NOT
            // event.data.code (the polling session id) — render the token.
            showQr(event.data.token);
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            this._qrState = {
              status: "scanned",
              image: null,
              displayName: event.data.display_name,
            };
            stopCountdown(`  ✓ Scanned by ${event.data.display_name} — confirm on your phone…`);
            if (!tty) console.log("[zalo] QR scanned by", event.data.display_name, "- confirm on phone.");
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            this._qrState = { status: "expired", image: null };
            stopCountdown("  ⏳ QR expired — generating a new one…");
            if (!tty) console.log("[zalo] QR expired; regenerating.");
            try { event.actions?.retry?.(); } catch {
              /* ignore */
            }
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            this._qrState = { status: "declined", image: null };
            stopCountdown("  ✗ Declined on your phone — generating a new one…");
            if (!tty) console.log("[zalo] QR login declined; regenerating.");
            try { event.actions?.retry?.(); } catch {
              /* ignore */
            }
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            // Persist cookie/imei/userAgent so we don't need QR next time.
            stopCountdown();
            this._saveCredentials({
              cookie: event.data.cookie,
              imei: event.data.imei,
              userAgent: event.data.userAgent,
            });
            this._qrState = { status: "logged_in", image: null };
            break;
        }
      },
    );

    await this._afterLogin();
    return { method: "qr" };
  }

  async _afterLogin() {
    this.loggedIn = true;
    this._loadCliMsgCache(); // reload persisted msgId→cliMsgId (<=30d) for undo
    try {
      this.ownId = await this.api.getOwnId();
    } catch {
      this.ownId = null;
    }
    console.log("[zalo] logged in. ownId =", this.ownId);
    // Init SQLite store + repository (ownId known now)
    if (!this._store) {
      this._store = await createStore(this._dbPath);
      this._repository = createRepository(this._store, {
        api: this.api,
        onDirty: () => {
          this._dbChanged = true;
          this._schedulePersistDb();
        },
      });
      // Migrate legacy JSON → SQLite
      this._repository.migrateFromJson(this.checkpointPath);
      console.log("[zalo] SQLite store ready at", this._dbPath);
    }
    // Init in-memory cache
    if (!this._cache) {
      this._cache = createCache();
    }
    // Init HistorySync on first login (background, async)
    if (!this._historySync) {
      this._historySync = new HistorySync(this._repository);
      this._historySync.start().catch((e) => {
        console.warn("[zalo] initial HistorySync failed:", e.message);
      });
    }
    this._wireListeners();
    // retryOnClose: zca-js auto-reconnects the Zalo websocket on drop.
    // Inject code 1000 + 1006 into zca-js retry system so WS reconnects
    // internally (no API call) for both normal close and abnormal close.
    // code 1000 = Zalo server normal closure every ~6s
    // code 1006 = abnormal closure (network glitch) — retry every 2s, up to 999x
    const listener = this.api.listener;
    if (listener && listener.ctx?.settings?.features?.socket) {
      const codes = listener.ctx.settings.features.socket.close_and_retry_codes;
      if (!codes.includes(1000)) codes.push(1000);
      if (!codes.includes(1006)) codes.push(1006);
      if (!listener.retryCount["1000"]) {
        listener.retryCount["1000"] = {
          count: 0, max: 999, times: [1000],
        };
      }
      if (!listener.retryCount["1006"]) {
        listener.retryCount["1006"] = {
          count: 0, max: 999, times: [2000],
        };
      }
    }
    this.setState("CONNECTED"); // PR2: connection state machine trigger (initial login flow)
    this.api.listener.start({ retryOnClose: true });
    this._startKeepAlive();
  }

  // ── PR1: Checkpoint Persistence Helpers ──────────────────────────────────
  _updateThreadLastSeen(threadId, messageId, timestamp, threadType = "user") {
    if (!threadId || !this._repository) return;
    try {
      this._repository.upsertCheckpoint(threadId, threadType, messageId, timestamp);
      this._dbChanged = true;
      this._schedulePersistDb();
    } catch (e) {
      console.error("[zalo] failed to update checkpoint:", e.message);
    }
  }

  _schedulePersistDb() {
    if (this._dbTimer) return;
    this._dbTimer = setTimeout(() => {
      this._dbTimer = null;
      this._persistDb();
    }, 10000);
    if (this._dbTimer.unref) this._dbTimer.unref();
  }

  _persistDb() {
    if (!this._dbChanged || !this._store) return;
    try {
      this._store.persist();
      this._dbChanged = false;
    } catch (e) {
      console.error("[zalo] failed to persist db:", e.message);
    }
  }

  _setupGracefulFlush() {
    const flush = () => {
      this._persistDb();
      if (this._store) {
        console.log("[zalo] closing SQLite store...");
        this._store.close();
      }
    };
    process.once("SIGTERM", flush);
    process.once("SIGINT", flush);
  }

  /**
   * Periodically hit Zalo's HTTP /keepalive endpoint so the server doesn't
   * expire an otherwise-quiet session. zca-js exposes api.keepAlive() but never
   * calls it; only the WS-level ping (cmd:2) is automatic. Best-effort: a failed
   * keepalive is logged, not fatal (a truly dead session surfaces via "closed").
   */
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAliveTimer = setInterval(() => {
      const api = this.api;
      if (!api || typeof api.keepAlive !== "function") return;
      Promise.resolve()
        .then(() => api.keepAlive())
        .then(() => {
          this._keepAliveConsecutiveFailures = 0; // reset failures
          // Refresh cookies after keepAlive — the server may have issued new ones.
          const jar = api.getCookie?.();
          if (jar) {
            const serialized = jar.serializeSync?.()?.cookies ?? jar.toJSON?.()?.cookies;
            if (serialized) {
              const creds = this._loadCredentials();
              if (creds) {
                creds.cookie = serialized;
                this._saveCredentials(creds);
              }
            }
          }
        })
        .catch((e) => {
          this._keepAliveConsecutiveFailures++;
          this._stats.keepAliveFailures++;
          console.warn(`[zalo] keepAlive failed (${this._keepAliveConsecutiveFailures}x):`, e && e.message ? e.message : e);
          if (this._keepAliveConsecutiveFailures >= 3 && !this._reconnecting && !this.sessionDead) {
            console.warn("[zalo] keepAlive failed 3 consecutive times; triggering relogin...");
            this._scheduleAutoRelogin(0, "keepalive 3x failure");
          }
        });
    }, KEEPALIVE_INTERVAL_MS);
    if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  // ── PR2: State Machine ───────────────────────────────────────────────────
  setState(newState) {
    // If session is dead, state MUST be SESSION_DEAD regardless of transitions
    if (this.sessionDead) {
      newState = "SESSION_DEAD";
    }
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    console.log(`[zalo] State transition: ${oldState} -> ${newState}`);
    this.emit("state_change", { oldState, newState });
  }

  /** Cancel any pending auto-relogin and clear the in-flight guard. */
  _stopReconnect() {
    if (this._autoReloginTimer) {
      clearTimeout(this._autoReloginTimer);
      this._autoReloginTimer = null;
    }
    this._reconnecting = false;
  }

  /**
   * Mark the session permanently dead and notify listeners. Recovery from here
   * is manual: re-scan QR via POST /relogin.
   */
  _declareSessionDead(code, reason) {
    this.loggedIn = false;
    this.sessionDead = true;
    this.sessionDeadReason = `code=${code} reason=${reason || ""}`.trim();
    this.setState("SESSION_DEAD"); // PR2: set session dead state
    this.emit("status", { connected: false, dead: true, code, reason });
    this.emit("session_dead", {
      code,
      reason: reason || "",
      message:
        code === 3000
          ? "Zalo session ended: account logged in from another device/Zalo Web."
          : code === 3003
            ? "Zalo session was kicked by the server."
            : "Zalo session closed (cookie expired or network). Re-scan QR to recover.",
    });
  }

  /**
   * Attempt to recover a permanently-closed session with the saved cookie
   * (no QR), with linear backoff. On success the new "connected" event resets
   * the attempt budget; once the budget is exhausted (or the cookie itself is
   * dead) we fall back to declaring the session dead for manual QR recovery.
   */
  _scheduleAutoRelogin(code, reason) {
    if (this._reconnecting) return;
    if (this._autoReloginAttempts >= MAX_AUTO_RELOGIN_ATTEMPTS) {
      this._declareSessionDead(code, reason);
      return;
    }
    this.setState("CONNECTING"); // PR2: State Machine connecting trigger
    this._reconnecting = true;
    this._autoReloginAttempts++;
    const attempt = this._autoReloginAttempts;
    const delay = Math.min(attempt * AUTO_RELOGIN_BASE_MS, AUTO_RELOGIN_MAX_MS);
    console.log(
      `[zalo] auto-relogin attempt ${attempt}/${MAX_AUTO_RELOGIN_ATTEMPTS} ` +
         `in ${Math.round(delay / 1000)}s (code=${code})`,
    );
    this.emit("status", { connected: false, reconnecting: true, code, reason });
    this._autoReloginTimer = setTimeout(() => {
      this._autoReloginTimer = null;
      this.relogin({ forceQR: false, cookieOnly: true })
        .then((r) => {
          console.log("[zalo] auto-relogin succeeded via", r.method);
          this._reconnecting = false;
          // The fresh listener's "connected" event resets _autoReloginAttempts.
        })
        .catch((e) => {
          console.error(
            "[zalo] auto-relogin failed:",
            e && e.message ? e.message : e,
          );
          this._reconnecting = false;
          if (this._autoReloginAttempts >= MAX_AUTO_RELOGIN_ATTEMPTS) {
            this._declareSessionDead(code, reason);
          } else {
            this._scheduleAutoRelogin(code, reason);
          }
        });
    }, delay);
    if (this._autoReloginTimer.unref) this._autoReloginTimer.unref();
  }

  _wireListeners() {
    const listener = this.api.listener;

    listener.on("connected", () => {
      console.log("[zalo] listener connected");
      const isFirstConnect = !this._hasConnectedOnce;
      this._hasConnectedOnce = true;
      this.sessionDead = false;
      this.loggedIn = true; // Restore after transient drops
      
      // Update statistics
      if (this._lastDisconnectAt > 0) {
        this._stats.lastDisconnectDurationMs = Date.now() - this._lastDisconnectAt;
        this._lastDisconnectAt = 0;
      }
      
      // A healthy connection replenishes the auto-relogin budget so periodic
      // drops don't slowly exhaust it over the session's lifetime.
      this._autoReloginAttempts = 0;
      this._reconnecting = false;
      this.emit("status", { connected: true });

      // PR2 & PR3: Trigger catchup or transition directly to READY
      this.setState("CONNECTED"); // Ensure state transition CONNECTING/DISCONNECTED -> CONNECTED first
      if (isFirstConnect) {
        this.setState("READY"); // First connect doesn't catch up
      } else {
        this._catchupMissedMessages().catch((e) => {
          console.error("[zalo] catch-up failed:", e.message);
        });
      }
    });
    listener.on("disconnected", (code, reason) => {
      // Transient drop; zca-js will auto-retry (retryOnClose). Just surface it.
      console.log("[zalo] listener disconnected", code, reason);
      this.setState("DISCONNECTED"); // PR2: State Machine transition
      this._stats.disconnectCount++;
      this._lastDisconnectAt = Date.now();
      this.emit("status", { connected: false, transient: true, code, reason });
    });
    listener.on("closed", (code, reason) => {
      // Permanent close: zca-js's retry budget is exhausted OR a fatal code.
      // 3000 = DuplicateConnection (logged in elsewhere), 3003 = KickConnection
      // are terminal — re-scanning QR is the only recovery, so don't auto-retry.
      // Anything else (cookie/network) gets an automatic cookie relogin first.
      console.log("[zalo] listener CLOSED", code, reason);
      this.setState("DISCONNECTED"); // PR2: State Machine transition
      this.loggedIn = false;
      this._reconnecting = false; // ★ avoid starvation when code 1000 fires
      // immediately after relogin's _afterLogin(), before .then() clears the flag.
      this._stopKeepAlive();
      const fatal = code === 3000 || code === 3003;
      if (fatal) {
        this._declareSessionDead(code, reason);
      } else {
        this._scheduleAutoRelogin(code, reason);
      }
    });
    listener.on("error", (err) => {
      console.error("[zalo] listener error:", err);
    });

    listener.on("message", (message) => {
      try {
        const isGroup = message.type === ThreadType.Group;
        const d = message.data || {};
        // Always cache msgId -> cliMsgId (incl. our own messages) for undo.
        if (d.msgId && d.cliMsgId) {
          this._recordCliMsgId(d.msgId, d.cliMsgId);
        }
        if (process.env.ZALO_LOG_MESSAGES === "1" || process.env.ZALO_LOG_MESSAGES === "true") {
          console.log(
            `[zalo] RAW message: type=${isGroup ? "group" : "user"} thread=${message.threadId} ` +
              `from=${d.uidFrom} self=${message.isSelf} msgType=${d.msgType} ` +
              `content=${typeof d.content === "string" ? JSON.stringify(d.content).slice(0, 80) : JSON.stringify(d.content).slice(0, 400)}`,
          );
        }
        const ev = this._normaliseMessage(message);
        if (ev) {
          // Save to SQLite asynchronously (non-blocking SSE; saveIncoming
          // internally handles thread checkpoint upsert + persist trigger)
          if (this._repository) {
            void this._repository.saveIncoming(ev).catch((e) => {
              console.error("[zalo] failed to save incoming message:", e.message);
            });
          }
          this.emit("message", ev);
        }
      } catch (e) {
        console.error("[zalo] failed to normalise message:", e.message);
      }
    });

    // Reactions (thả tim/like…) on messages.
    listener.on("reaction", (reaction) => {
      try {
        const d = reaction.data || {};
        this.emit("reaction", {
          threadId: String(reaction.threadId),
          threadType: reaction.type === ThreadType.Group ? "group" : "user",
          senderId: String(d.uidFrom || ""),
          msgId: String(d.content?.rMsg?.[0]?.gMsgID || d.msgId || ""),
          icon: d.content?.rIcon || "",
          rType: d.content?.rType,
          isSelf: !!reaction.isSelf,
        });
      } catch (e) {
        console.error("[zalo] reaction normalise failed:", e.message);
      }
    });

    // Message undo/recall (thu hồi).
    listener.on("undo", (undo) => {
      try {
        const d = undo.data || {};
        this.emit("undo", {
          threadId: String(undo.threadId),
          threadType: undo.type === ThreadType.Group ? "group" : "user",
          senderId: String(d.uidFrom || ""),
          msgId: String(d.content?.globalMsgId || d.msgId || ""),
          isSelf: !!undo.isSelf,
        });
      } catch (e) {
        console.error("[zalo] undo normalise failed:", e.message);
      }
    });

    // Friend events (requests, accepts, etc.).
    listener.on("friend_event", (ev) => {
      try {
        this.emit("friend_event", { type: ev.type, data: ev.data, isSelf: !!ev.isSelf });
      } catch (e) {
        console.error("[zalo] friend_event failed:", e.message);
      }
    });

    // Group events (join/leave/rename/admin, etc.).
    listener.on("group_event", (ev) => {
      try {
        this.emit("group_event", { type: ev.type, data: ev.data, isSelf: !!ev.isSelf });
      } catch (e) {
        console.error("[zalo] group_event failed:", e.message);
      }
    });
  }

  /**
   * Convert a zca-js Message into a flat inbound event for Hermes.
   * Skips our own messages unless selfListen is on.
   */
  _normaliseMessage(message) {
    const isGroup = message.type === ThreadType.Group;
    const data = message.data || {};

    if (message.isSelf && !this.selfListen) return null;

    const msgType = data.msgType || "";
    let text = "";
    let attachment = null;
    let media = null; // { kind, url, fileName, ext, mime, size }

    if (typeof data.content === "string") {
      text = data.content;
    } else if (data.content && typeof data.content === "object") {
      const r = classifyContent(msgType, data.content);
      text = r.text;
      attachment = r.attachment;
      media = r.media;
    }

    // ── Quote content (text + media of the message being replied to) ────────
    let quotedText = "";
    let quotedFrom = "";
    let quotedOwnerId = "";
    let quotedMedia = null;
    let quotedAttachment = null;
    if (data.quote) {
      quotedText = typeof data.quote.msg === "string" ? data.quote.msg : "";
      quotedFrom = data.quote.fromD ? String(data.quote.fromD) : "";
      quotedOwnerId = data.quote.ownerId ? String(data.quote.ownerId) : "";
      // data.quote.attach is a JSON string describing the quoted message's
      // content object — reuse classifyContent to extract media for download.
      if (data.quote.attach) {
        try {
          const qc = typeof data.quote.attach === "string" ? JSON.parse(data.quote.attach) : data.quote.attach;
          const quotedMsgType = CLIMSGTYPE_TO_MSGTYPE[data.quote.cliMsgType] || "";
          const r = classifyContent(quotedMsgType, qc);
          quotedMedia = r.media;
          quotedAttachment = r.attachment;
        } catch (e) {
          console.error("[zalo] failed to parse quote.attach:", e.message);
        }
      }
    } else {
      quotedOwnerId = "";
    }

    return {
      messageId: String(data.msgId || data.cliMsgId || Date.now()),
      cliMsgId: String(data.cliMsgId || ""),
      threadId: String(message.threadId),
      threadType: isGroup ? "group" : "user",
      senderId: String(data.uidFrom || ""),
      senderName: data.dName || "",
      text,
      attachment,
      media,
      msgType,
      ts: String(data.ts || Date.now()),
      isSelf: !!message.isSelf,
      mentions: Array.isArray(data.mentions)
        ? data.mentions.map((mn) => String(mn && mn.uid ? mn.uid : "")).filter(Boolean)
        : [],
      quotedOwnerId,
      quotedText,
      quotedFrom,
      quotedMedia,
      quotedAttachment,
      quote: {
        content: typeof data.content === "string" ? data.content : data.content,
        msgType: data.msgType,
        propertyExt: data.propertyExt,
        uidFrom: data.uidFrom,
        msgId: data.msgId,
        cliMsgId: data.cliMsgId,
        ts: data.ts,
        ttl: data.ttl,
      },
    };
  }

  _threadTypeEnum(threadType) {
    return threadType === "group" ? ThreadType.Group : ThreadType.User;
  }

  // ── Outbound ──────────────────────────────────────────────────────────

  async sendText(threadId, threadType, text, mentions, quote) {
    const styles = [];
    let plain = "";

    // Clean structural markdown tags FIRST to preserve correct character indices
    const cleanedRaw = String(text)
      .replace(/`{1,3}(.+?)`{1,3}/gs, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^>\s+/gm, "")
      .replace(/^---+$/gm, "")
      .replace(/\n{3,}/g, "\n\n");
    
    // Pattern to match bold (** or __) and italic (_ only with non-space boundaries) on cleaned text
    const pattern = /\*\*(.+?)\*\*|__(.+?)__|(?<=\s|^)_(?!\s)(.+?)(?<!\s)_(?=\s|$)/gs;
    let lastIndex = 0;

    for (const match of cleanedRaw.matchAll(pattern)) {
      // Add plain text before match
      plain += cleanedRaw.slice(lastIndex, match.index);

      let inner = "";
      let styleType = "";

      if (match[1] !== undefined) {
        inner = match[1];
        styleType = "b";
      } else if (match[2] !== undefined) {
        inner = match[2];
        styleType = "b";
      } else if (match[3] !== undefined) {
        inner = match[3];
        styleType = "i";
      }

      const start = plain.length;
      plain += inner;
      styles.push({ start, len: inner.length, st: styleType });

      lastIndex = match.index + match[0].length;
    }

    plain += cleanedRaw.slice(lastIndex);

    const content = { msg: plain };
    if (styles.length > 0) content.styles = styles;
    if (Array.isArray(mentions) && mentions.length) content.mentions = mentions;
    if (quote) content.quote = quote;
    
    return await this.api.sendMessage(content, String(threadId), this._threadTypeEnum(threadType));
  }

  // ── Reactions ──────────────────────────────────────────────────────────
  /** React to a message. iconName is a key of Reactions (HEART, LIKE, HAHA…) or a raw icon string. */
  async react(threadId, threadType, msgId, cliMsgId, iconName) {
    const icon = Reactions[iconName] !== undefined ? Reactions[iconName] : iconName;
    const dest = {
      data: { msgId: String(msgId), cliMsgId: String(cliMsgId || msgId) },
      threadId: String(threadId),
      type: this._threadTypeEnum(threadType),
    };
    return await this.api.addReaction(icon, dest);
  }

  // ── Undo (thu hồi) ───────────────────────────────────────────────────────
  async undo(threadId, threadType, msgId, cliMsgId) {
    let cli = cliMsgId && String(cliMsgId) !== String(msgId) ? String(cliMsgId) : null;
    // Resolve the real cliMsgId from the persisted cache. A just-sent message
    // may take ~1s to echo back through the listener, so poll briefly.
    if (!cli) {
      for (let i = 0; i < 12 && !cli; i++) {
        cli = this._lookupCliMsgId(msgId);
        if (!cli) await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!cli) {
      throw new Error(
        "undo: real cliMsgId not found for this msgId (need the message to have passed through the listener)",
      );
    }
    return await this.api.undo(
      { msgId: String(msgId), cliMsgId: cli },
      String(threadId),
      this._threadTypeEnum(threadType),
    );
  }

  // ── Contact card (danh thiếp) ─────────────────────────────────────────────
  async sendCard(threadId, threadType, userId, phoneNumber) {
    const opts = { userId: String(userId) };
    if (phoneNumber) opts.phoneNumber = String(phoneNumber);
    return await this.api.sendCard(opts, String(threadId), this._threadTypeEnum(threadType));
  }

  // ── Friends ───────────────────────────────────────────────────────────────
  async sendFriendRequest(userId, msg) {
    return await this.api.sendFriendRequest(String(msg || "Xin chào"), String(userId));
  }
  async acceptFriendRequest(userId) {
    return await this.api.acceptFriendRequest(String(userId));
  }
  async rejectFriendRequest(userId) {
    return await this.api.rejectFriendRequest(String(userId));
  }
  async getAllFriends() {
    return await this._cachedInfo("friends:all", () => this.api.getAllFriends());
  }
  async findUser(phoneNumber) {
    return await this.api.findUser(String(phoneNumber));
  }

  // ── Groups ────────────────────────────────────────────────────────────────
  async getAllGroups() {
    return await this._cachedInfo("groups:all", () => this.api.getAllGroups());
  }
  async getGroupMembers(groupId) {
    // getGroupInfo returns membership; getGroupMembersInfo enriches profiles.
    return await this.api.getGroupInfo(String(groupId));
  }
  async createGroup(name, members) {
    return await this.api.createGroup({ name: name || undefined, members: members.map(String) });
  }
  async addUserToGroup(groupId, memberIds) {
    return await this.api.addUserToGroup(memberIds.map(String), String(groupId));
  }
  async removeUserFromGroup(groupId, memberIds) {
    return await this.api.removeUserFromGroup(memberIds.map(String), String(groupId));
  }
  async changeGroupName(groupId, name) {
    return await this.api.changeGroupName(String(name), String(groupId));
  }
  async addGroupDeputy(groupId, memberIds) {
    return await this.api.addGroupDeputy(memberIds.map(String), String(groupId));
  }
  async leaveGroup(groupId, silent = false) {
    return await this.api.leaveGroup(String(groupId), !!silent);
  }

  // ── Poll ──────────────────────────────────────────────────────────────────
  async createPoll(groupId, question, options, extra = {}) {
    return await this.api.createPoll(
      { question: String(question), options: options.map(String), ...extra },
      String(groupId),
    );
  }

  /**
   * Send one or more local file paths as attachments (images, files, video).
   * zca-js routes by extension automatically.
   */
  async sendAttachment(threadId, threadType, filePaths, caption) {
    const attachments = Array.isArray(filePaths) ? filePaths : [filePaths];
    const content = { msg: caption ? String(caption) : "", attachments };
    return await this.api.sendMessage(content, String(threadId), this._threadTypeEnum(threadType));
  }

  async sendSticker(threadId, threadType, sticker) {
    // sticker: { id, cateId, type } per zca-js StickerDetail
    return await this.api.sendSticker(sticker, String(threadId), this._threadTypeEnum(threadType));
  }

  async sendVoice(threadId, threadType, voiceUrl) {
    return await this.api.sendVoice({ voiceUrl }, String(threadId), this._threadTypeEnum(threadType));
  }

  /**
   * Send a LOCAL audio file as a real voice bubble: upload it (as "others")
   * to obtain a public fileUrl, then call sendVoice with that URL.
   * Zalo voice bubbles want m4a/aac. Returns the sendVoice result.
   */
  async sendVoiceLocal(threadId, threadType, filePath) {
    const type = this._threadTypeEnum(threadType);
    const uploaded = await this.api.uploadAttachment([filePath], String(threadId), type);
    const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    const url = first && (first.fileUrl || first.normalUrl);
    if (!url) throw new Error("upload did not return a fileUrl for voice");
    return await this.api.sendVoice({ voiceUrl: url }, String(threadId), type);
  }

  async sendTyping(threadId, threadType) {
    try {
      return await this.api.sendTypingEvent(String(threadId), this._threadTypeEnum(threadType));
    } catch {
      return null;
    }
  }

  async getUserInfo(userId) {
    try {
      return await this._cachedInfo(`user:${userId}`, () => this.api.getUserInfo(String(userId)));
    } catch {
      return null;
    }
  }

  /** Search stickers by keyword and return full details ({id, cateId, type, ...}). */
  async findStickers(keyword, limit = 5) {
    const ids = await this.api.getStickers(String(keyword));
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const slice = ids.slice(0, limit);
    const details = await this.api.getStickersDetail(slice);
    return details || [];
  }

  async getGroupInfo(groupId) {
    try {
      return await this._cachedInfo(`group:${groupId}`, () => this.api.getGroupInfo(String(groupId)));
    } catch {
      return null;
    }
  }

  /**
   * Friendly contact list for setup: every group (id + name) and every friend
   * (id + name). Used by the Hermes setup wizard so users can pick allowlist
   * entries by name instead of hunting for raw IDs.
   */
  async listContacts() {
    const groups = [];
    const friends = [];
    // Groups: getAllGroups returns only {gridVerMap:{id:ver}}; fetch names via
    // getGroupInfo. Chunk the ids (some accounts have stale/left groups in the
    // map that make a single huge call fail with "Tham số không hợp lệ"); a bad
    // chunk is skipped with a placeholder name rather than failing the whole list.
    try {
      const all = await this.getAllGroups();
      const ids = Object.keys((all && all.gridVerMap) || {});
      const CHUNK = 30;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        let map = {};
        try {
          const info = await this._cachedInfo(`group:batch:${slice.join(",")}`, () =>
            this.api.getGroupInfo(slice),
          );
          map = (info && info.gridInfoMap) || {};
        } catch (e) {
          console.warn(`[zalo] getGroupInfo chunk failed (${slice.length} ids): ${e.message}`);
        }
        for (const id of slice) {
          const g = map[id] || {};
          groups.push({ id: String(id), name: g.name || g.groupName || `(group ${id})` });
        }
      }
    } catch (e) {
      console.error("[zalo] listContacts groups failed:", e.message);
    }
    // Friends: getAllFriends already returns objects with userId + displayName.
    try {
      const fr = await this.getAllFriends();
      for (const f of Array.isArray(fr) ? fr : []) {
        friends.push({
          id: String(f.userId || f.uid || f.id || ""),
          name: f.displayName || f.zaloName || f.username || "(friend)",
        });
      }
    } catch (e) {
      console.error("[zalo] listContacts friends failed:", e.message);
    }
    return { groups, friends };
  }

  // ── Group image bulk-download ─────────────────────────────────────────────

  /**
   * Download all images from a group's chat history to a local directory.
   *
   * @param {string} groupId         Zalo group thread ID
   * @param {object} opts
   * @param {string} opts.savePath   Directory to save images (created if missing)
   * @param {number|null} opts.fromTs  Unix timestamp (ms) — only download images
   *                                   sent on or after this time. null = all.
   * @param {Function} opts.onProgress Called with (downloaded, skipped, total) after each image.
   * @param {Function} opts.onStatus   Called with a status string for logging.
   * @returns {{ downloaded, skipped, errors, savePath }}
   */
  async downloadGroupImages(groupId, { savePath, fromTs = null, onProgress, onStatus } = {}) {
    const fs = await import("node:fs/promises");
    // Use Node.js 18+ built-in fetch (no external dep needed).
    const fetchFn = globalThis.fetch;
    if (!fetchFn) throw new Error("Built-in fetch not available (requires Node.js >=18)");

    const log = (msg) => {
      console.log(`[zalo:download] ${msg}`);
      if (onStatus) onStatus(msg);
    };

    // Ensure output directory exists.
    await fs.mkdir(savePath, { recursive: true });

    // Get session cookies to authenticate Zalo CDN requests.
    let cookieHeader = "";
    try {
      const jar = this.api.getCookie?.();
      if (jar) {
        const cookies = jar.toJSON?.()?.cookies ?? jar.serializeSync?.()?.cookies ?? [];
        cookieHeader = cookies
          .map((c) => `${c.key}=${c.value}`)
          .join("; ");
      }
    } catch (e) {
      log(`Warning: could not extract session cookies: ${e.message}`);
    }

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
      Referer: "https://chat.zalo.me/",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };

    let downloaded = 0;
    let skipped = 0;
    let errors = 0;
    let pageCount = 0;
    let lastMsgId = undefined; // pagination cursor (undefined = first page)
    const BATCH = 50;          // messages per getGroupChatHistory call
    const DELAY_MS = 600;      // delay between image downloads (anti-rate-limit)
    const seenUrls = new Set();

    log(`Starting image scan for group ${groupId} → ${savePath}`);
    if (fromTs) {
      log(`Date filter: only images sent at/after ${new Date(fromTs).toISOString()}`);
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      pageCount++;
      let msgs;
      try {
        // Primary: zca-js getGroupChatHistory(groupId, count)
        msgs = await this.api.getGroupChatHistory(String(groupId), BATCH);
      } catch (e) {
        log(`api.getGroupChatHistory failed on page ${pageCount} (${e.message}), trying loadmsg fallback...`);
        try {
          // Fallback: Direct call to Zalo loadmsg API using zca-js authenticated session context
          const ctxHttp = this.api._ctx ? this.api._ctx.http : (this.api.ctx ? this.api.ctx.http : null);
          if (ctxHttp && typeof ctxHttp.post === "function") {
            const resp = await ctxHttp.post("https://wpa.chat.zalo.me/api/message/loadmsg", {
              zpw_ver: 636,
              zpw_type: 30,
              params: {
                threadId: String(groupId),
                lastId: String(lastMsgId || "0"),
                count: BATCH,
                timestamp: 0,
                type: 2, // 2 = group
              },
            });
            msgs = resp.data?.data?.msgs ?? resp.data?.msgs ?? resp.data;
          } else {
            throw e;
          }
        } catch (fallbackErr) {
          log(`Error fetching history page ${pageCount}: ${fallbackErr.message}`);
          break;
        }
      }

      const items = (msgs && (msgs.data || msgs)) || [];
      const arr = Array.isArray(items) ? items : [];
      log(`Page ${pageCount}: got ${arr.length} messages`);

      if (!arr.length) break;

      // Sort ascending by ts so we process oldest→newest within each batch.
      arr.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

      let hitDateFilter = false;
      // Collect candidate download items for this page.
      const downloadTasks = [];
      for (const msg of arr) {
        const msgTs = Number(msg.ts || msg.timestamp || 0);

        if (fromTs && msgTs < fromTs) {
          hitDateFilter = true;
          continue;
        }

        const msgType = msg.msgType || (msg.data && msg.data.msgType) || "";
        if (msgType !== "chat.photo" && msgType !== "chat.gif") continue;

        // Extract image URL (prefer HD).
        const content = msg.data?.content || msg.content || {};
        let params = {};
        try {
          params = typeof content.params === "string"
            ? JSON.parse(content.params)
            : content.params || {};
        } catch { params = {}; }

        const url = params.hd || params.original || content.href || content.thumb || "";
        if (!url || seenUrls.has(url)) { skipped++; continue; }
        seenUrls.add(url);

        const msgId = String(msg.msgId || msg.data?.msgId || Date.now());
        const ext = msgType === "chat.gif" ? "gif" : "jpg";
        const fname = `${msgTs}_${msgId}.${ext}`;
        const dest = `${savePath}/${fname}`;

        downloadTasks.push({ url, fname, dest });
      }

      // Download images in parallel batches (Concurrency = 5) for high speed & safe IO
      const CONCURRENCY = 5;
      for (let i = 0; i < downloadTasks.length; i += CONCURRENCY) {
        const batch = downloadTasks.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async ({ url, fname, dest }) => {
            // Skip if already downloaded.
            try {
              await fs.access(dest);
              skipped++;
              return;
            } catch { /* not exists, proceed */ }

            let ok = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const resp = await fetchFn(url, { headers, signal: AbortSignal.timeout(30000) });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buf = Buffer.from(await resp.arrayBuffer());
                const valid =
                  (buf[0] === 0xff && buf[1] === 0xd8) ||          // JPEG
                  (buf[0] === 0x89 && buf[1] === 0x50) ||          // PNG
                  buf.toString("ascii", 0, 3) === "GIF" ||         // GIF
                  (buf.toString("ascii", 0, 4) === "RIFF" &&       // WebP
                   buf.toString("ascii", 8, 12) === "WEBP");
                if (!valid) { log(`Skip ${fname}: not a recognised image`); skipped++; ok = true; break; }
                await fs.writeFile(dest, buf);
                downloaded++;
                ok = true;
                break;
              } catch (e) {
                if (attempt === 3) {
                  log(`Error downloading ${fname} (attempt ${attempt}): ${e.message}`);
                  errors++;
                } else {
                  await new Promise((r) => setTimeout(r, 1000 * attempt));
                }
              }
            }
            if (ok && onProgress) onProgress(downloaded, skipped, errors);
          })
        );
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }

      // Update cursor to the oldest msgId in this batch for next page.
      const oldest = arr[0];
      const oldestMsgId = oldest?.msgId || oldest?.data?.msgId;
      if (!oldestMsgId || String(oldestMsgId) === String(lastMsgId)) break;
      lastMsgId = oldestMsgId;

      // If we have a date filter and all messages in this batch are newer than
      // fromTs, keep paging backward (older). If all are older, we're done.
      if (fromTs && hitDateFilter && arr.every((m) => Number(m.ts || 0) < fromTs)) {
        log("All messages in batch predate the from-date filter; stopping.");
        break;
      }

      // Rate-limit between pages.
      await new Promise((r) => setTimeout(r, 1200));
    }

    log(`Done. downloaded=${downloaded} skipped=${skipped} errors=${errors}`);
    return { downloaded, skipped, errors, savePath };
  }

  // ── PR3: Catch-up & Replay Engine ────────────────────────────────────────
  async _catchupMissedMessages() {
    if (this._catchingUp || !this._store || !this._repository) return;
    this._catchingUp = true;
    this.setState("CATCHUP");
    console.log("[zalo] starting catchup scan on tracked threads...");
    
    this._stats.lastCatchupAt = Date.now();
    let recoveredCount = 0;
    
    // 1. Gather candidate threads from SQLite checkpoint, prioritized by most recently updated
    const threadRows = this._repository.getCheckpointsForCatchup(this.maxTrackedThreads);
    const threads = threadRows.map((row) => ({
      threadId: row.thread_id,
      threadType: row.thread_type,
      checkpoint: { messageId: row.last_message_id, timestamp: row.last_ts },
      updatedAt: row.updated_at,
    }));

    // 2. Scan each thread sequentially using a dedicated throttle queue
    for (const thread of threads) {
      if (this.state !== "CATCHUP") {
        console.log("[zalo] catchup aborted due to connection state change");
        break;
      }
      try {
        const lastSeen = thread.checkpoint;
        if (!lastSeen || !lastSeen.timestamp) continue;

        // Apply ZALO_CATCHUP_MAX_WINDOW_MS
        const windowStart = Date.now() - this.maxCatchupWindowMs;
        const fromTs = Math.max(Number(lastSeen.timestamp), windowStart);
        
        console.log(`[zalo] scanning thread ${thread.threadId} (${thread.threadType}) from timestamp ${fromTs} (lastSeen=${lastSeen.timestamp})`);
        
        // lastId=0: getGroupChatHistory/loadmsg dùng lastId nghĩa là "cũ hơn ID này",
        // không phải "mới hơn". Ta luôn lấy N tin gần nhất rồi filter bằng fromTs.
        const rawMsgs = await this._fetchThreadHistory(thread.threadId, thread.threadType, 0, fromTs);
        if (!rawMsgs || !rawMsgs.length) continue;

        // 3. Process, normalize, dedup, sort, and emit missed messages
        const normalized = [];
        const lastMsgId = lastSeen.messageId || "";
        const lastTs = Number(lastSeen.timestamp || 0);
        for (const rawMsg of rawMsgs) {
          const norm = this._normaliseHistoryMessage(rawMsg, thread.threadId, thread.threadType);
          if (!norm) continue;
          // Dedup: chỉ emit nếu message thực sự mới hơn checkpoint
          // (so sánh timestamp trước, messageId sau để tránh replay tin đã xử lý)
          const normTs = Number(norm.timestamp || 0);
          if (normTs < lastTs) continue;
          if (normTs === lastTs && norm.messageId === lastMsgId) continue;
          normalized.push(norm);
        }

        // Sort ascending oldest -> newest
        normalized.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

        // Emit sequential events
        for (const ev of normalized) {
          console.log(`[zalo] replay recovered message: ${ev.messageId} (thread=${ev.threadId})`);
          this.emit("message", ev);
          this._updateThreadLastSeen(ev.threadId, ev.messageId, ev.timestamp, ev.threadType);
          recoveredCount++;
          // Small delay to prevent ring buffer exhaustion at receiver
          await new Promise((r) => setTimeout(r, 50));
        }
      } catch (err) {
        this._stats.historyFetchErrors++;
        console.error(`[zalo] failed to catchup thread ${thread.threadId}:`, err.message);
      }
      // sequential throttle between threads
      await new Promise((r) => setTimeout(r, 1200));
    }

    this._stats.recoveredCount += recoveredCount;
    this._stats.lastRecoveredCount = recoveredCount;
    console.log(`[zalo] catchup complete. recovered ${recoveredCount} messages (cumulative: ${this._stats.recoveredCount}).`);
    this._catchingUp = false;
    this.setState("READY");
  }

  async _fetchThreadHistory(threadId, threadType, lastMsgId, fromTs) {
    const BATCH = this.maxMessagesPerThread || 50;
    let msgs = null;
    let attempts = 3;
    let delay = 1000;

    for (let i = 0; i < attempts; i++) {
      try {
        if (threadType === "group") {
          msgs = await this.api.getGroupChatHistory(String(threadId), BATCH);
        } else {
          // DM: use loadmsg API (verified working for DM in v8)
          msgs = await this.api.callRaw("loadmsg", [String(threadId), BATCH]);
        }
        break;
      } catch (err) {
        if (i === attempts - 1) throw err;
        const jitter = 0.8 + Math.random() * 0.4;
        await new Promise((r) => setTimeout(r, delay * jitter));
        delay *= 2;
      }
    }

    const arr = Array.isArray(msgs) ? msgs : (Array.isArray(msgs?.data) ? msgs.data : []);
    return arr.filter((m) => {
      const ts = Number(m.ts || m.timestamp || 0);
      return ts > fromTs;
    });
  }

  _normaliseHistoryMessage(rawMsg, threadId, threadType) {
    const isGroup = threadType === "group";
    // Critical self-loop protection filtering
    const senderId = String(rawMsg.uidFrom || rawMsg.senderId || "");
    if (senderId === String(this.ownId)) {
      return null;
    }

    // Map properties to standardized live message shape expected by _normaliseMessage
    const msgData = {
      msgId: String(rawMsg.msgId || rawMsg.globalMsgId || ""),
      cliMsgId: String(rawMsg.cliMsgId || ""),
      uidFrom: senderId,
      msgType: rawMsg.msgType || "",
      content: rawMsg.content,
      ts: Number(rawMsg.ts || rawMsg.timestamp || 0),
    };

    const dummyMessage = {
      type: isGroup ? ThreadType.Group : ThreadType.User,
      threadId: String(threadId),
      isSelf: false,
      data: msgData
    };

    return this._normaliseMessage(dummyMessage);
  }

  // ── Generic passthrough to any zca-js API method ──────────────────────────
  // Covers the long tail of zca-js APIs without a bespoke wrapper each. Args
  // are passed positionally; any arg equal to the string "user"/"group" is
  // converted to the ThreadType enum (many zca-js methods take a trailing
  // ThreadType). Method names are validated against the live API surface.
  async callRaw(method, args = []) {
    if (typeof method !== "string" || !/^[a-zA-Z]\w*$/.test(method)) {
      throw new Error("invalid method name");
    }
    const fn = this.api && this.api[method];
    if (typeof fn !== "function") {
      throw new Error(`unknown zca-js API method: ${method}`);
    }
    const mapped = (Array.isArray(args) ? args : [args]).map((a) => {
      if (a === "user") return ThreadType.User;
      if (a === "group") return ThreadType.Group;
      return a;
    });
    return await fn.apply(this.api, mapped);
  }

  // ── Lifecycle: relogin after session death, graceful shutdown ─────────────

  /**
   * Recover a dead session by re-running QR login. Stops the old listener,
   * clears state, and starts a fresh login (cookie first, QR fallback).
   * Forces QR when the saved cookie is the thing that died.
   */
  async relogin({ forceQR = true, cookieOnly = false } = {}) {
    this._stopReconnect();
    this._stopKeepAlive();
    try {
      if (this.api && this.api.listener) this.api.listener.stop();
    } catch {
      /* ignore */
    }
    this.api = null;
    this.loggedIn = false;
    // Timeout: if zca-js login hangs (e.g. stale credentials, dead server),
    // don't let the whole auto-relogin chain stall forever.
    const TIMEOUT_MS = 30_000;
    const result = await Promise.race([
      this.login({ forceQR, cookieOnly }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("login timed out")), TIMEOUT_MS),
      ),
    ]);
    return result;
  }

  /** Graceful shutdown: stop timers, listener, flush SQLite, close the persistence stream. */
  async shutdown() {
    this._stopReconnect();
    this._stopKeepAlive();
    try {
      if (this.api && this.api.listener) this.api.listener.stop();
    } catch {
      /* ignore */
    }
    try {
      if (this._cliMsgStream) {
        this._cliMsgStream.end();
        this._cliMsgStream = null;
      }
    } catch {
      /* ignore */
    }
    this._persistDb();
    if (this._store) {
      try {
        this._store.close();
      } catch {
        /* ignore */
      }
    }
    this.loggedIn = false;
    console.log("[zalo] client shut down");
  }
}

export { ThreadType };
