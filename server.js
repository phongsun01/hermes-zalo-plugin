// server.js
// HTTP bridge: SSE inbound (Zalo -> Hermes) + REST outbound (Hermes -> Zalo).
//
// Env vars:
//   ZALO_PLUGIN_PORT      (default 8787)
//   ZALO_PLUGIN_TOKEN     (optional shared secret; required on all routes if set)
//   ZALO_PLUGIN_HOST      (default 127.0.0.1 — keep loopback unless you add TLS)
//   ZALO_CREDENTIALS_PATH (default ./data/credentials.json)
//   ZALO_QR_PATH          (default ./data/qr.png)
//   ZALO_SELF_LISTEN      (1/true to receive own messages; default off)
//   ZALO_FORCE_QR         (1/true to ignore saved credentials and re-QR)

import express from "express";
import compression from "compression";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZaloClient } from "./zaloClient.js";
import { ACTION_GROUPS, DEFAULT_GROUPS, ACTION_GROUP } from "./permissions.js";
import { credentialsPath, qrPath, cliMsgDir } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unique per-process id, regenerated every time the bridge (re)starts.
// Lets SSE consumers tell "bridge restarted" apart from a transient network
// drop, so they know whether it's safe to resume via Last-Event-ID or not.
const BOOT_ID = crypto.randomUUID();

const PORT = parseInt(process.env.ZALO_PLUGIN_PORT || "8787", 10);
const HOST = process.env.ZALO_PLUGIN_HOST || "127.0.0.1";
const TOKEN = process.env.ZALO_PLUGIN_TOKEN || "";
const CREDENTIALS_PATH = credentialsPath();
const QR_PATH = qrPath();
const SELF_LISTEN = /^(1|true|yes)$/i.test(process.env.ZALO_SELF_LISTEN || "");
const FORCE_QR = /^(1|true|yes)$/i.test(process.env.ZALO_FORCE_QR || "");
// Persisted undo-cache retention in days (0 = disable persistence, memory-only).
const CLIMSG_RETENTION_DAYS = (() => {
  const raw = process.env.ZALO_CLIMSG_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 30;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 30;
})();

const client = new ZaloClient({
  credentialsPath: CREDENTIALS_PATH,
  qrPath: QR_PATH,
  selfListen: SELF_LISTEN,
  cliMsgDir: cliMsgDir(),
  cliMsgRetentionDays: CLIMSG_RETENTION_DAYS,
  infoCacheTtlMs: (() => {
    const n = parseInt(process.env.ZALO_INFO_CACHE_TTL || "", 10);
    return Number.isFinite(n) ? n * 1000 : 600000; // env in seconds, default 600s
  })(),
  infoMinIntervalMs: (() => {
    const n = parseInt(process.env.ZALO_INFO_MIN_INTERVAL_MS || "", 10);
    return Number.isFinite(n) ? n : 1500;
  })(),
});

// Rate Limiter: Prevent AI loop / spam from locking Zalo account (max 60 requests / minute)
const apiSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.ZALO_RATE_LIMIT_MAX || "60", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Quá nhiều request gửi tin nhắn, tạm thời bị giới hạn để bảo vệ tài khoản Zalo." },
});

// ── Access control: which zca-js actions are allowed ──────────────────────
// Groups by danger level: read < send < interact < manage < destructive.
//   ZALO_ALLOWED_ACTION_GROUPS  csv of groups, or "all"  (default read,send,interact)
//   ZALO_ALLOW_DESTRUCTIVE      true to permit the destructive group (off even under "all")
//   ZALO_ALLOWED_ACTIONS        csv of explicit method names to ALWAYS allow (overrides groups)
//   ZALO_DENIED_ACTIONS         csv of explicit method names to ALWAYS deny  (overrides everything)
const _csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

const ALLOWED_GROUPS = (() => {
  const raw = (process.env.ZALO_ALLOWED_ACTION_GROUPS || "").trim().toLowerCase();
  if (!raw) return new Set(DEFAULT_GROUPS);
  if (raw === "all") return new Set(ACTION_GROUPS);
  return new Set(_csv(raw).filter((g) => ACTION_GROUPS.includes(g)));
})();
const ALLOW_DESTRUCTIVE = /^(1|true|yes)$/i.test(process.env.ZALO_ALLOW_DESTRUCTIVE || "");
const ALLOWED_ACTIONS = new Set(_csv(process.env.ZALO_ALLOWED_ACTIONS));
const DENIED_ACTIONS = new Set(_csv(process.env.ZALO_DENIED_ACTIONS));

// destructive must be opted into explicitly, even if listed/under "all".
if (!ALLOW_DESTRUCTIVE) ALLOWED_GROUPS.delete("destructive");

/** Decide whether a zca-js method is permitted by the configured policy. */
function isActionAllowed(method) {
  if (DENIED_ACTIONS.has(method)) return { ok: false, reason: "explicitly denied (ZALO_DENIED_ACTIONS)" };
  if (ALLOWED_ACTIONS.has(method)) return { ok: true };
  const group = ACTION_GROUP[method];
  if (!group) return { ok: false, reason: `unknown action '${method}'` };
  if (group === "destructive" && !ALLOW_DESTRUCTIVE) {
    return { ok: false, reason: "destructive actions disabled (set ZALO_ALLOW_DESTRUCTIVE=true to enable)" };
  }
  if (!ALLOWED_GROUPS.has(group)) {
    return { ok: false, reason: `action group '${group}' not in ZALO_ALLOWED_ACTION_GROUPS` };
  }
  return { ok: true };
}

/** Express guard: 403 if the method isn't allowed. Returns true if allowed. */
function guardAction(method, res) {
  const verdict = isActionAllowed(method);
  if (!verdict.ok) {
    res.status(403).json({ error: `action '${method}' blocked: ${verdict.reason}` });
    return false;
  }
  return true;
}

/** Utility wrapper for async routes (DRY error handling). */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((e) => {
    next(e);
  });
};

console.log(
  `[bridge] access policy: groups=[${[...ALLOWED_GROUPS].join(",")}]` +
    ` destructive=${ALLOW_DESTRUCTIVE}` +
    (ALLOWED_ACTIONS.size ? ` +allow[${[...ALLOWED_ACTIONS].join(",")}]` : "") +
    (DENIED_ACTIONS.size ? ` -deny[${[...DENIED_ACTIONS].join(",")}]` : ""),
);

// Map first-class routes → the underlying zca-js action so they're gated by
// the SAME policy as /api/<method>. (GET read routes map to a read method.)
const ROUTE_ACTION = {
  "POST /send": "sendMessage",
  "POST /send-attachment": "uploadAttachment",
  "POST /send-sticker": "sendSticker",
  "POST /send-voice": "sendVoice",
  "POST /send-card": "sendCard",
  "POST /react": "addReaction",
  "POST /undo": "undo",
  "POST /typing": "sendTypingEvent",
  "POST /friend/request": "sendFriendRequest",
  "POST /friend/accept": "acceptFriendRequest",
  "POST /friend/reject": "rejectFriendRequest",
  "GET /friends": "getAllFriends",
  "GET /find-user": "findUser",
  "GET /groups": "getAllGroups",
  "GET /chat-info": "getUserInfo",
  "GET /stickers": "getStickers",
  "POST /group/create": "createGroup",
  "POST /group/add": "addUserToGroup",
  "POST /group/remove": "removeUserFromGroup",
  "POST /group/rename": "changeGroupName",
  "POST /group/deputy": "addGroupDeputy",
  "POST /group/leave": "leaveGroup",
  "POST /poll/create": "createPoll",
};

// ── SSE fan-out ───────────────────────────────────────────────────────────
const sseClients = new Set();
// Small ring buffer so a reconnecting consumer can replay missed events
// via Last-Event-ID (SSE standard).
const RING_SIZE = 200;
const ring = [];
let nextEventId = Date.now() * 1000; // Monotonically increasing Event ID across restarts

// Deduplication ring: skip message events whose messageId was already pushed
// within the last ~200 messages (covers brief listener overlap during relogin).
const DEDUP_SIZE = 200;
const msgDedupSet = new Set();
const msgDedupRing = [];

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
    if (msgDedupRing.length > DEDUP_SIZE * 1.5) {
      const removed = msgDedupRing.splice(0, msgDedupRing.length - DEDUP_SIZE);
      for (const id of removed) msgDedupSet.delete(id);
    }
  }

  const id = nextEventId++;
  const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  ring.push({ id, frame });

  if (ring.length > RING_SIZE * 1.5) {
    ring.splice(0, ring.length - RING_SIZE);
  }

  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      /* dropped on next heartbeat */
    }
  }
}

client.on("message", (msg) => pushEvent("message", msg));
client.on("status", (s) => pushEvent("status", s));
client.on("session_dead", (d) => pushEvent("session_dead", d));
client.on("reaction", (r) => pushEvent("reaction", r));
client.on("undo", (u) => pushEvent("undo", u));
client.on("friend_event", (f) => pushEvent("friend_event", f));
client.on("group_event", (g) => pushEvent("group_event", g));

// ── Express ─────────────────────────────────────────────────────────────
const app = express();
app.use(morgan("dev"));
app.use(compression());
app.use(express.json({ limit: "2mb" }));

// Apply Rate Limiters on outbound sending routes
app.use("/send", apiSendLimiter);
app.use("/send-attachment", apiSendLimiter);
app.use("/send-voice", apiSendLimiter);
app.use("/api/", apiSendLimiter);

// Action-policy middleware for the first-class routes (ROUTE_ACTION map above).
// /api/<method> is gated inside its own handler; lifecycle routes
// (/health, /qr, /events, /relogin, /shutdown) are never action-gated.
app.use((req, res, next) => {
  const method = ROUTE_ACTION[`${req.method} ${req.path}`];
  if (method) {
    const v = isActionAllowed(method);
    if (!v.ok) return res.status(403).json({ error: `action '${method}' blocked: ${v.reason}` });
  }
  next();
});

function checkAuth(req, res) {
  if (!TOKEN) return true;
  const provided =
    req.get("x-bridge-token") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.query.token;

  const providedBuffer = Buffer.from(provided || "");
  const tokenBuffer = Buffer.from(TOKEN);
  if (
    providedBuffer.length === tokenBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, tokenBuffer)
  ) {
    return true;
  }
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// Expose the active access policy so the adapter/agent can surface what's
// permitted (and avoid attempting blocked actions blindly).
app.get("/policy", (req, res) => {
  if (!checkAuth(req, res)) return;
  const allowedActions = Object.keys(ACTION_GROUP).filter((m) => isActionAllowed(m).ok);
  res.json({
    groups: [...ALLOWED_GROUPS],
    allowDestructive: ALLOW_DESTRUCTIVE,
    customAllow: [...ALLOWED_ACTIONS],
    customDeny: [...DENIED_ACTIONS],
    allowedActionCount: allowedActions.length,
    totalActions: Object.keys(ACTION_GROUP).length,
    allowedActions,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    bootId: BOOT_ID,
    loggedIn: client.loggedIn,
    sessionDead: !!client.sessionDead,
    sessionDeadReason: client.sessionDeadReason || null,
    ownId: client.ownId,
    qr: client.qrState ? client.qrState.status : null,
    sseClients: sseClients.size,
  });
});

// QR status + base64 image (for login UX). Returns current QR state.
app.get("/qr", (req, res) => {
  if (!checkAuth(req, res)) return;
  const state = client.qrState || { status: client.loggedIn ? "logged_in" : "none", image: null };
  res.json(state);
});

// Raw QR PNG (convenient to open in a browser/Preview).
app.get("/qr.png", (req, res) => {
  if (!checkAuth(req, res)) return;
  if (fs.existsSync(QR_PATH)) {
    res.sendFile(path.resolve(QR_PATH));
  } else {
    res.status(404).json({ error: "no qr available" });
  }
});

// Recover a dead/expired session: re-run login (QR by default). Returns once
// a new QR is generated; poll /qr or /qr.png to scan it, then /health.
app.post("/relogin", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  const forceQR = req.body && req.body.forceQR === false ? false : true;
  // Kick off relogin in the background; respond immediately so the caller
  // can start polling /qr.
  client
    .relogin({ forceQR })
    .then((r) => console.log("[bridge] relogin complete via", r.method))
    .catch((e) => console.error("[bridge] relogin failed:", e && e.message ? e.message : e));
  res.json({ success: true, message: "relogin started; poll /qr then /qr.png to scan" });
}));

// Graceful shutdown of the bridge. Stops the listener, closes SSE + file
// streams, then exits. Use to cleanly stop the Hermes Zalo agent.
app.post("/shutdown", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  res.json({ success: true, message: "shutting down" });
  await gracefulShutdown("http /shutdown");
}));

// SSE inbound stream. Sends a heartbeat every 15s to defeat idle timeouts.
//
// SINGLE-CLIENT ENFORCEMENT & EVICTION:
// Docker Desktop proxy on Windows or reconnecting clients might leave TCP connections open.
// Instead of rejecting (409), kick old connection(s) to allow new reconnection immediately.
app.get("/events", (req, res) => {
  if (!checkAuth(req, res)) return;

  if (sseClients.size >= 1) {
    console.log("[bridge] Kicking old SSE client(s) to accept new connection.");
    for (const oldRes of sseClients) {
      try {
        oldRes.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Bridge-Boot-Id": BOOT_ID,
  });
  res.write(`retry: 3000\n\n`);

  // Replay missed events if the client reconnected with Last-Event-ID.
  const lastId = parseInt(req.get("last-event-id") || req.query.lastEventId || "0", 10);
  if (lastId > 0) {
    for (const rec of ring) {
      if (rec.id > lastId) {
        res.write(rec.frame);
      }
    }
  }

  sseClients.add(res);
  console.log("[bridge] SSE client connected, total:", sseClients.size);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log("[bridge] SSE client disconnected, total:", sseClients.size);
  });
});

function requireLogin(res) {
  if (!client.loggedIn) {
    res.status(503).json({ error: "not logged in" });
    return false;
  }
  return true;
}

// Send text. Body: { threadId, threadType, text, mentions?, quote? }
//   mentions: [{ pos, uid, len }]  — group @mention
//   quote:    SendMessageQuote captured from an inbound message (reply)
app.post("/send", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", text, mentions, quote } = req.body || {};
  if (!threadId || text == null) {
    return res.status(400).json({ error: "threadId and text required" });
  }
  const r = await client.sendText(threadId, threadType, text, mentions, quote);
  res.json({ success: true, result: r });
}));

// Send attachment(s) by local file path(s). Body: { threadId, threadType, paths|path, caption? }
app.post("/send-attachment", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", caption } = req.body || {};
  const paths = req.body.paths || (req.body.path ? [req.body.path] : null);
  if (!threadId || !paths || !paths.length) {
    return res.status(400).json({ error: "threadId and paths required" });
  }
  for (const p of paths) {
    if (!fs.existsSync(p)) return res.status(400).json({ error: `file not found: ${p}` });
  }
  const r = await client.sendAttachment(threadId, threadType, paths, caption);
  res.json({ success: true, result: r });
}));

// Send sticker. Body: { threadId, threadType, sticker: { id, cateId, type } }
app.post("/send-sticker", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", sticker } = req.body || {};
  if (!threadId || !sticker) return res.status(400).json({ error: "threadId and sticker required" });
  const r = await client.sendSticker(threadId, threadType, sticker);
  res.json({ success: true, result: r });
}));

// Send voice. Body: { threadId, threadType, voiceUrl } OR { ..., path } (local file → real voice bubble)
app.post("/send-voice", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", voiceUrl, path: filePath } = req.body || {};
  if (!threadId || (!voiceUrl && !filePath)) {
    return res.status(400).json({ error: "threadId and (voiceUrl or path) required" });
  }
  let r;
  if (filePath) {
    if (!fs.existsSync(filePath)) return res.status(400).json({ error: `file not found: ${filePath}` });
    r = await client.sendVoiceLocal(threadId, threadType, filePath);
  } else {
    r = await client.sendVoice(threadId, threadType, voiceUrl);
  }
  res.json({ success: true, result: r });
}));

// Typing indicator. Body: { threadId, threadType }
app.post("/typing", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user" } = req.body || {};
  if (!threadId) return res.status(400).json({ error: "threadId required" });
  await client.sendTyping(threadId, threadType);
  res.json({ success: true });
}));

// Chat info. GET /chat-info?threadId=..&threadType=user|group
app.get("/chat-info", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const threadId = req.query.threadId;
  const threadType = req.query.threadType || "user";
  if (!threadId) return res.status(400).json({ error: "threadId required" });
  if (threadType === "group") {
    const info = await client.getGroupInfo(threadId);
    res.json({ threadId, type: "group", info });
  } else {
    const info = await client.getUserInfo(threadId);
    res.json({ threadId, type: "user", info });
  }
}));

// Search stickers by keyword. GET /stickers?keyword=hi&limit=5
app.get("/stickers", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const keyword = req.query.keyword;
  const limit = parseInt(req.query.limit || "5", 10);
  if (!keyword) return res.status(400).json({ error: "keyword required" });
  const stickers = await client.findStickers(keyword, limit);
  res.json({ success: true, stickers });
}));

// ── Reactions / undo / reply / mention ───────────────────────────────────

// React to a message. Body: { threadId, threadType, msgId, cliMsgId?, icon }
// icon = a Reactions key (HEART, LIKE, HAHA, WOW, CRY, ANGRY, …) or raw icon string.
app.post("/react", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", msgId, cliMsgId, icon = "HEART" } = req.body || {};
  if (!threadId || !msgId) return res.status(400).json({ error: "threadId and msgId required" });
  const r = await client.react(threadId, threadType, msgId, cliMsgId, icon);
  res.json({ success: true, result: r });
}));

// Recall/undo own message. Body: { threadId, threadType, msgId, cliMsgId? }
app.post("/undo", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", msgId, cliMsgId } = req.body || {};
  if (!threadId || !msgId) return res.status(400).json({ error: "threadId and msgId required" });
  const r = await client.undo(threadId, threadType, msgId, cliMsgId);
  res.json({ success: true, result: r });
}));

// Send a contact card (danh thiếp). Body: { threadId, threadType, userId, phoneNumber? }
app.post("/send-card", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", userId, phoneNumber } = req.body || {};
  if (!threadId || !userId) return res.status(400).json({ error: "threadId and userId required" });
  const r = await client.sendCard(threadId, threadType, userId, phoneNumber);
  res.json({ success: true, result: r });
}));

// ── Friends ───────────────────────────────────────────────────────────────
app.post("/friend/request", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { userId, msg } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  res.json({ success: true, result: await client.sendFriendRequest(userId, msg) });
}));
app.post("/friend/accept", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  res.json({ success: true, result: await client.acceptFriendRequest(userId) });
}));
app.post("/friend/reject", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  res.json({ success: true, result: await client.rejectFriendRequest(userId) });
}));
app.get("/friends", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  res.json({ success: true, friends: await client.getAllFriends() });
}));
app.get("/find-user", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "phone required" });
  res.json({ success: true, user: await client.findUser(phone) });
}));

// ── Groups ────────────────────────────────────────────────────────────────
app.get("/groups", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  res.json({ success: true, groups: await client.getAllGroups() });
}));
app.get("/contacts", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  res.json({ success: true, ...(await client.listContacts()) });
}));
app.post("/group/create", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { name, members } = req.body || {};
  if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: "members[] required" });
  res.json({ success: true, result: await client.createGroup(name, members) });
}));
app.post("/group/add", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, members } = req.body || {};
  if (!groupId || !Array.isArray(members) || !members.length) return res.status(400).json({ error: "groupId and members[] required" });
  res.json({ success: true, result: await client.addUserToGroup(groupId, members) });
}));
app.post("/group/remove", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, members } = req.body || {};
  if (!groupId || !Array.isArray(members) || !members.length) return res.status(400).json({ error: "groupId and members[] required" });
  res.json({ success: true, result: await client.removeUserFromGroup(groupId, members) });
}));
app.post("/group/rename", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, name } = req.body || {};
  if (!groupId || !name) return res.status(400).json({ error: "groupId and name required" });
  res.json({ success: true, result: await client.changeGroupName(groupId, name) });
}));
app.post("/group/deputy", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, members } = req.body || {};
  if (!groupId || !Array.isArray(members) || !members.length) return res.status(400).json({ error: "groupId and members[] required" });
  res.json({ success: true, result: await client.addGroupDeputy(groupId, members) });
}));
app.post("/group/leave", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, silent } = req.body || {};
  if (!groupId) return res.status(400).json({ error: "groupId required" });
  res.json({ success: true, result: await client.leaveGroup(groupId, silent) });
}));

// ── Group image bulk-download ─────────────────────────────────────────────
// POST /group/download-images
// Body: { groupId, fromDate? }   fromDate = "DD/MM/YYYY" or omit for all images
// Returns immediately { ok: true, jobId } and sends SSE events:
//   download_progress  { jobId, downloaded, skipped, errors, done, savePath, message }
const DEFAULT_IMAGE_SAVE_PATH =
  process.env.ZALO_IMAGE_SAVE_PATH || path.join(process.cwd(), "data", "group_images");

// Active download jobs (jobId → { groupId, cancel: false })
const _downloadJobs = new Map();

app.post("/group/download-images", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;

  const { groupId, fromDate } = req.body || {};
  if (!groupId) return res.status(400).json({ error: "groupId required" });

  // Parse optional date filter "DD/MM/YYYY".
  let fromTs = null;
  if (fromDate) {
    const m = String(fromDate).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) return res.status(400).json({ error: "fromDate must be DD/MM/YYYY" });
    const [, dd, mm, yyyy] = m;
    const d = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T00:00:00+07:00`);
    if (isNaN(d.getTime())) return res.status(400).json({ error: "invalid fromDate" });
    fromTs = d.getTime();
  }

  const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const savePath = path.join(DEFAULT_IMAGE_SAVE_PATH, String(groupId));
  const job = { groupId, cancel: false };
  _downloadJobs.set(jobId, job);

  const emit = (payload) =>
    pushEvent("download_progress", { jobId, groupId, savePath, ...payload });

  // Kick off in background (no await).
  (async () => {
    try {
      emit({ done: false, message: fromTs
        ? `Bắt đầu tải ảnh từ ${fromDate}...`
        : "Bắt đầu quét toàn bộ lịch sử group..."
      });

      const result = await client.downloadGroupImages(String(groupId), {
        savePath,
        fromTs,
        onProgress: (downloaded, skipped, errors) => {
          emit({ done: false, downloaded, skipped, errors,
            message: `Đã tải ${downloaded} ảnh...` });
        },
        onStatus: (msg) => {
          console.log(`[job:${jobId}] ${msg}`);
        },
      });

      emit({
        done: true,
        downloaded: result.downloaded,
        skipped: result.skipped,
        errors: result.errors,
        message: `✅ Xong! Đã tải ${result.downloaded} ảnh về ${savePath}` +
          (result.errors ? ` (${result.errors} lỗi)` : ""),
      });
    } catch (e) {
      console.error(`[job:${jobId}] error:`, e && e.message ? e.message : e);
      emit({ done: true, downloaded: 0, skipped: 0, errors: 1,
        message: `❌ Lỗi tải ảnh: ${e && e.message ? e.message : e}` });
    } finally {
      _downloadJobs.delete(jobId);
    }
  })();

  res.json({ ok: true, jobId, savePath, message: "Download job started" });
}));

// ── Generic passthrough: call ANY zca-js API method ───────────────────────

// POST /api/<method>  body { args: [...] }
// Covers the full zca-js surface (forwardMessage, deleteMessage, sendVideo,
// getGroupMembersInfo, reminders, mute/pin, profile, business, etc.).
// Pass args positionally exactly as zca-js expects; use "user"/"group" where
// a ThreadType is needed (auto-converted). Returns { success, result }.
app.post("/api/:method", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const method = req.params.method;
  if (!guardAction(method, res)) return;
  const args = req.body && Array.isArray(req.body.args) ? req.body.args : [];

  // Timeout guard (30s): Prevent malformed/hanging zca-js calls from keeping HTTP sockets open.
  const CALL_TIMEOUT_MS = 30000;
  const result = await Promise.race([
    client.callRaw(method, args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`zca-js call '${method}' timed out after 30s`)), CALL_TIMEOUT_MS)
    ),
  ]);

  res.json({ success: true, result: result ?? null });
}));

// ── Poll ──────────────────────────────────────────────────────────────────
// Body: { groupId, question, options[], expiredTime?, allowMultiChoices?, ... }
app.post("/poll/create", asyncHandler(async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, question, options, ...extra } = req.body || {};
  if (!groupId || !question || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "groupId, question and options[>=2] required" });
  }
  res.json({ success: true, result: await client.createPoll(groupId, question, options, extra) });
}));

// Global Error Handler Middleware (Chốt chặn xử lý lỗi cuối cùng)
app.use((err, req, res, next) => {
  console.error(`[bridge] Express Error:`, err);
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  res.status(status).json({ success: false, error: message });
});

async function main() {
  _httpServer = app.listen(PORT, HOST, () => {
    console.log(`[bridge] listening on http://${HOST}:${PORT}`);
    if (!TOKEN) console.log("[bridge] WARNING: no ZALO_PLUGIN_TOKEN set (loopback only recommended)");
  });

  try {
    const result = await client.login({ forceQR: FORCE_QR });
    console.log(`[bridge] login complete via ${result.method}`);
  } catch (e) {
    console.error("[bridge] login failed:", e && e.message ? e.message : e);
    console.error("[bridge] server stays up; call /qr to retry login state.");
  }
}

let _httpServer = null;
let _shuttingDown = false;

async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[bridge] graceful shutdown (${reason})…`);
  // Close SSE clients so consumers see the stream end.
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  try {
    await client.shutdown();
  } catch {
    /* ignore */
  }
  if (_httpServer) {
    _httpServer.close(() => process.exit(0));
    // Hard exit if close hangs.
    setTimeout(() => process.exit(0), 3000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Prevent the bridge process from crashing on unhandled errors.
// The watchdog will restart it if needed, but we want to stay up for transient errors.
process.on("uncaughtException", (err) => {
  console.error("[bridge] uncaughtException (staying up):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandledRejection (staying up):", reason);
});

main();
