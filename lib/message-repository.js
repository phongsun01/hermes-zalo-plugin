import fs from "fs";

const MAX_CONTEXT_MESSAGES = 100;

export function createRepository(store, opts = {}) {
  const api = opts.api || null;

  function makeMsgUid(threadId, messageId, cliMsgId) {
    const uid = String(messageId || cliMsgId || Date.now());
    return String(threadId || "") + ":" + uid;
  }

  function dirty() {
    if (typeof opts.onDirty === "function") opts.onDirty();
  }

  // ── Write ──────────────────────────────────────────────────────────

  async function saveIncoming(ev) {
    const direction = ev.isSelf ? "outgoing" : "incoming";
    const {
      messageId, cliMsgId, threadId, threadType, senderId, senderName,
      text, attachment, media, msgType, ts, isSelf, contentJson,
      quotedOwnerId, quote,
    } = ev;
    const tsNum = Number(ts || Date.now());
    const textStr = typeof text === "string" ? text : JSON.stringify(text || "");
    const msgUid = makeMsgUid(threadId, messageId, cliMsgId);
    const qMsgId = quote?.msgId || "";
    const qCliMsgId = quote?.cliMsgId || "";

    store.transaction(() => {
      store.run(
        `INSERT OR IGNORE INTO messages
         (message_uid, message_id, cli_msg_id, thread_id, thread_type, sender_id, sender_name,
          direction, text, msg_type, ts, content_json,
          quote_msg_id, quote_cli_msg_id, quote_owner_id, source)
         VALUES ($msgUid, $messageId, $cliMsgId, $threadId, $threadType, $senderId, $senderName,
          $direction, $text, $msgType, $ts, $contentJson,
          $qMsgId, $qCliMsgId, $qOwner, 'live')`,
        {
          $msgUid: msgUid,
          $messageId: String(messageId || ""),
          $cliMsgId: String(cliMsgId || ""),
          $threadId: String(threadId || ""),
          $threadType: String(threadType || "user"),
          $senderId: String(senderId || ""),
          $senderName: String(senderName || ""),
          $direction: direction,
          $text: textStr,
          $msgType: String(msgType || ""),
          $ts: tsNum,
          $contentJson: contentJson ? JSON.stringify(contentJson) : "",
          $qMsgId: qMsgId,
          $qCliMsgId: qCliMsgId,
          $qOwner: String(quotedOwnerId || quote?.ownerId || ""),
        }
      );

      // Upsert thread checkpoint (same transaction)
      store.run(
        `INSERT INTO threads (thread_id, thread_type, last_message_id, last_ts, updated_at)
         VALUES ($threadId, $threadType, $messageId, $ts, $updatedAt)
         ON CONFLICT(thread_id) DO UPDATE SET
          last_message_id = CASE WHEN $ts >= last_ts THEN $messageId ELSE last_message_id END,
          last_ts = CASE WHEN $ts >= last_ts THEN $ts ELSE last_ts END,
          thread_type = $threadType,
          updated_at = $updatedAt`,
        {
          $threadId: String(threadId || ""),
          $threadType: String(threadType || "user"),
          $messageId: String(messageId || ""),
          $ts: tsNum,
          $updatedAt: Date.now(),
        }
      );

      // Attachments
      const att = attachment || media || null;
      if (att && att.type) {
        store.run(
          `INSERT INTO attachments (message_uid, type, url, thumbnail, width, height,
            duration, file_size, file_name, mime_type)
           VALUES ($msgUid, $type, $url, $thumbnail, $width, $height,
            $duration, $fileSize, $fileName, $mimeType)`,
          {
            $msgUid: msgUid,
            $type: String(att.type || ""),
            $url: String(att.url || ""),
            $thumbnail: String(att.thumbnail || ""),
            $width: Number(att.width || 0),
            $height: Number(att.height || 0),
            $duration: Number(att.duration || 0),
            $fileSize: Number(att.fileSize || att.file_size || 0),
            $fileName: String(att.fileName || att.file_name || ""),
            $mimeType: String(att.mimeType || att.mime_type || ""),
          }
        );
      }
    });
    dirty();
  }

  async function saveCatchup(messages, ownId) {
    if (!messages || !messages.length) return;
    store.transaction(() => {
      for (const msg of messages) {
        const direction = String(msg.senderId || msg.uidFrom || "") === String(ownId) ? "outgoing" : "incoming";
        const msgId = String(msg.messageId || msg.msgId || "");
        const threadId = String(msg.threadId || "");
        const msgUid = makeMsgUid(threadId, msgId, msg.cliMsgId);
        store.run(
          `INSERT OR IGNORE INTO messages
           (message_uid, message_id, cli_msg_id, thread_id, thread_type, sender_id, sender_name,
            direction, text, msg_type, ts, content_json, source)
           VALUES ($msgUid, $messageId, $cliMsgId, $threadId, $threadType, $senderId, $senderName,
            $direction, $text, $msgType, $ts, $contentJson, 'catchup')`,
          {
            $msgUid: msgUid,
            $messageId: msgId,
            $cliMsgId: String(msg.cliMsgId || ""),
            $threadId: threadId,
            $threadType: String(msg.threadType || "user"),
            $senderId: String(msg.senderId || msg.uidFrom || ""),
            $senderName: String(msg.senderName || msg.dName || ""),
            $direction: direction,
            $text: String(msg.text || msg.content || ""),
            $msgType: String(msg.msgType || ""),
            $ts: Number(msg.ts || msg.timestamp || 0),
            $contentJson: typeof msg.contentJson === "string" ? msg.contentJson : JSON.stringify(msg),
          }
        );
      }
    });
    dirty();
  }

  async function saveHistory(messages, source = "sync") {
    if (!messages || !messages.length) return;
    store.transaction(() => {
      for (const msg of messages) {
        const direction = msg.isSelf ? "outgoing" : "incoming";
        const msgId = String(msg.messageId || msg.msgId || "");
        const threadId = String(msg.threadId || "");
        const msgUid = makeMsgUid(threadId, msgId, msg.cliMsgId);
        store.run(
          `INSERT OR IGNORE INTO messages
           (message_uid, message_id, cli_msg_id, thread_id, thread_type, sender_id, sender_name,
            direction, text, msg_type, ts, content_json, source)
           VALUES ($msgUid, $messageId, $cliMsgId, $threadId, $threadType, $senderId, $senderName,
            $direction, $text, $msgType, $ts, $contentJson, $source)`,
          {
            $msgUid: msgUid,
            $messageId: msgId,
            $cliMsgId: String(msg.cliMsgId || ""),
            $threadId: threadId,
            $threadType: String(msg.threadType || "user"),
            $senderId: String(msg.senderId || msg.uidFrom || ""),
            $senderName: String(msg.senderName || msg.dName || ""),
            $direction: direction,
            $text: String(msg.text || msg.content || ""),
            $msgType: String(msg.msgType || ""),
            $ts: Number(msg.ts || msg.timestamp || 0),
            $contentJson: typeof msg.contentJson === "string" ? msg.contentJson : JSON.stringify(msg),
            $source: String(source),
          }
        );
      }
    });
    dirty();
  }

  // ── Read ───────────────────────────────────────────────────────────

  function getContext(threadId, limit = MAX_CONTEXT_MESSAGES) {
    return store.select(
      `SELECT * FROM (
        SELECT * FROM messages WHERE thread_id = $threadId
        ORDER BY ts DESC, id DESC
        LIMIT $limit
      ) ORDER BY ts ASC, id ASC`,
      { $threadId: String(threadId || ""), $limit: limit }
    );
  }

  function search(filter, limit) {
    // backward compat: search(query, limit) with string
    if (typeof filter === "string") {
      const like = `%${filter}%`;
      return store.select(
        `SELECT * FROM messages
         WHERE text LIKE $query OR sender_name LIKE $query
         ORDER BY ts DESC
         LIMIT $limit`,
        { $query: like, $limit: limit ?? 50 }
      );
    }
    // filter object: { threadId, senderId, text, since, until, msgType, direction, limit, offset }
    const { threadId, senderId, text, since, until, msgType, direction } = filter;
    const fLimit = filter.limit ?? 50;
    const fOffset = filter.offset ?? 0;
    const conditions = ["1=1"];
    const params = { $limit: fLimit, $offset: fOffset };
    if (threadId) { conditions.push("thread_id = $threadId"); params.$threadId = String(threadId); }
    if (senderId) { conditions.push("sender_id = $senderId"); params.$senderId = String(senderId); }
    if (text) { conditions.push("text LIKE $text"); params.$text = `%${text}%`; }
    if (since) { conditions.push("ts >= $since"); params.$since = Number(since); }
    if (until) { conditions.push("ts <= $until"); params.$until = Number(until); }
    if (msgType) { conditions.push("msg_type = $msgType"); params.$msgType = String(msgType); }
    if (direction) { conditions.push("direction = $direction"); params.$direction = String(direction); }
    return store.select(
      `SELECT * FROM messages WHERE ${conditions.join(" AND ")}
       ORDER BY ts DESC, id DESC
       LIMIT $limit OFFSET $offset`,
      params
    );
  }

  async function getRecentMessages(threadId, fetchLimit = 50, fallbackToApi = true) {
    const rows = getContext(threadId, fetchLimit);
    if (rows.length >= fetchLimit || !fallbackToApi || !api) return rows;
    const thread = getCheckpoint(threadId);
    const threadType = thread?.thread_type || "user";
    let fresh;
    try {
      if (threadType === "group" || threadType === "Group") {
        fresh = await api.getGroupChatHistory(threadId, String(fetchLimit));
      } else {
        fresh = await api.callRaw("loadmsg", [threadId, String(fetchLimit)]);
      }
    } catch (err) {
      console.error(`[repo] getRecentMessages API fallback failed for ${threadId}:`, err.message);
      return rows;
    }
    if (!fresh || !fresh.length) return rows;
    const mapped = fresh.map(m => normalizeHistoryMsg(m, threadId, threadType));
    saveHistory(mapped, "catchup");
    return getContext(threadId, fetchLimit);
  }

  // ── Checkpoint ────────────────────────────────────────────────────

  function getCheckpoint(threadId) {
    return store.selectOne(
      `SELECT * FROM threads WHERE thread_id = $threadId`,
      { $threadId: String(threadId || "") }
    );
  }

  function getCheckpoints() {
    return store.select(`SELECT * FROM threads ORDER BY updated_at DESC`);
  }

  function getCheckpointsForCatchup(maxTrackedThreads = 200) {
    return store.select(
      `SELECT * FROM threads
       ORDER BY updated_at DESC
       LIMIT $limit`,
      { $limit: maxTrackedThreads }
    );
  }

  function upsertCheckpoint(threadId, threadType, messageId, ts) {
    const tsNum = Number(ts || Date.now());
    store.run(
      `INSERT INTO threads (thread_id, thread_type, last_message_id, last_ts, updated_at)
       VALUES ($threadId, $threadType, $messageId, $ts, $updatedAt)
       ON CONFLICT(thread_id) DO UPDATE SET
        last_message_id = CASE WHEN $ts >= last_ts THEN $messageId ELSE last_message_id END,
        last_ts = CASE WHEN $ts >= last_ts THEN $ts ELSE last_ts END,
        thread_type = $threadType,
        updated_at = $updatedAt`,
      {
        $threadId: String(threadId || ""),
        $threadType: String(threadType || "user"),
        $messageId: String(messageId || ""),
        $ts: tsNum,
        $updatedAt: Date.now(),
      }
    );
    dirty();
  }

  // ── Migration ─────────────────────────────────────────────────────

  function migrateFromJson(jsonPath) {
    if (!fs.existsSync(jsonPath)) return;
    let raw;
    try {
      raw = fs.readFileSync(jsonPath, "utf-8");
    } catch {
      return;
    }
    let cp;
    try {
      cp = JSON.parse(raw);
    } catch {
      return;
    }
    if (!cp || !cp.threads) return;
    store.transaction(() => {
      for (const [threadId, info] of Object.entries(cp.threads)) {
        const ts = Number(info.checkpoint?.timestamp || info.last_ts || 0);
        store.run(
          `INSERT OR REPLACE INTO threads
           (thread_id, thread_type, last_message_id, last_ts, updated_at)
           VALUES ($threadId, $threadType, $messageId, $ts, $updatedAt)`,
          {
            $threadId: String(threadId),
            $threadType: String(info.threadType || "user"),
            $messageId: String(info.checkpoint?.messageId || info.last_message_id || ""),
            $ts: ts,
            $updatedAt: Number(info.updatedAt || Date.now()),
          }
        );
      }
    });
  }

  // ── Sync state ────────────────────────────────────────────────────

  function upsertSyncState(entityType, entityId, status, opts2 = {}) {
    const { cursor = "", errorMsg = "", syncedCount } = opts2;
    store.run(
      `INSERT INTO sync_state (entity_type, entity_id, cursor, status, synced_count, error_msg, updated_at)
       VALUES ($entityType, $entityId, $cursor, $status, $syncedCount, $errorMsg, datetime('now'))
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        cursor = CASE WHEN $cursor != '' THEN $cursor ELSE cursor END,
        status = $status,
        synced_count = $syncedCount,
        error_msg = $errorMsg,
        updated_at = datetime('now')`,
      {
        $entityType: String(entityType),
        $entityId: String(entityId),
        $cursor: String(cursor),
        $status: String(status),
        $syncedCount: Number.isFinite(syncedCount) ? syncedCount : 0,
        $errorMsg: String(errorMsg),
      }
    );
  }

  function getSyncState(entityType, entityId) {
    return store.selectOne(
      `SELECT * FROM sync_state WHERE entity_type = $entityType AND entity_id = $entityId`,
      { $entityType: String(entityType), $entityId: String(entityId) }
    );
  }

  function getPendingSyncs() {
    return store.select(
      `SELECT * FROM sync_state WHERE status IN ('pending','in_progress','error')
       ORDER BY entity_type ASC, entity_id ASC`
    );
  }

  function getSyncStats() {
    const total = store.selectOne(`SELECT COUNT(*) as total FROM sync_state`);
    const pending = store.selectOne(
      `SELECT COUNT(*) as pending FROM sync_state WHERE status IN ('pending','in_progress','error')`
    );
    const done = store.selectOne(
      `SELECT COUNT(*) as done FROM sync_state WHERE status = 'done'`
    );
    return {
      total: total?.total || 0,
      pending: pending?.pending || 0,
      done: done?.done || 0,
    };
  }

  // ── Sync operations (require api) ─────────────────────────────────

  async function syncGroupHistory(groupId, count = 50) {
    if (!api) throw new Error("Repository has no API reference");

    const state = getSyncState("group", groupId);
    if (state && state.status === "done") return { groupId, status: "done", synced: 0 };

    upsertSyncState("group", groupId, "in_progress", { cursor: state?.cursor || "" });
    const cursor = state?.cursor || "";
    const fetched = [];

    // If we have a cursor (timestamp from last sync), use it as filter
    try {
      const rawMsgs = await api.getGroupChatHistory(String(groupId), count);
      const arr = Array.isArray(rawMsgs) ? rawMsgs : (Array.isArray(rawMsgs?.data) ? rawMsgs.data : []);
      for (const m of arr) {
        const ts = Number(m.ts || m.timestamp || 0);
        if (cursor && ts <= Number(cursor)) break;
        fetched.push(m);
      }
    } catch (err) {
      upsertSyncState("group", groupId, "error", {
        errorMsg: err.message,
        cursor,
        syncedCount: state?.synced_count || 0,
      });
      throw err;
    }

    if (fetched.length > 0) {
      const normalized = fetched
        .map((m) => normalizeHistoryMsg(m, groupId, "group"))
        .filter(Boolean);
      if (normalized.length > 0) {
        saveHistory(normalized, "sync");
      }
    }

    const newCursor = fetched.length > 0
      ? String(Number(fetched[fetched.length - 1].ts || fetched[fetched.length - 1].timestamp || 0))
      : cursor;
    const syncedCount = (state?.synced_count || 0) + fetched.length;

    upsertSyncState("group", groupId, "done", {
      cursor: newCursor,
      syncedCount,
    });

    return { groupId, status: "done", synced: fetched.length };
  }

  async function syncDMHistory(userId, count = 50) {
    if (!api) throw new Error("Repository has no API reference");

    const state = getSyncState("user", userId);
    if (state && state.status === "done") return { userId, status: "done", synced: 0 };

    upsertSyncState("user", userId, "in_progress");

    let rawMsgs;
    try {
      // loadmsg API via callRaw (generic passthrough)
      rawMsgs = await api.callRaw("loadmsg", [String(userId), count]);
    } catch (err) {
      upsertSyncState("user", userId, "error", { errorMsg: err.message });
      throw err;
    }

    const arr = Array.isArray(rawMsgs) ? rawMsgs : (Array.isArray(rawMsgs?.data) ? rawMsgs.data : []);
    if (arr.length === 0) {
      upsertSyncState("user", userId, "done", { syncedCount: 0 });
      return { userId, status: "done", synced: 0 };
    }

    const normalized = arr
      .map((m) => normalizeHistoryMsg(m, userId, "user"))
      .filter(Boolean);

    if (normalized.length > 0) {
      saveHistory(normalized, "sync");
    }

    upsertSyncState("user", userId, "done", {
      syncedCount: normalized.length,
    });

    return { userId, status: "done", synced: normalized.length };
  }

  async function syncFriends() {
    if (!api) throw new Error("Repository has no API reference");

    let friends;
    try {
      friends = await api.getAllFriends();
    } catch (err) {
      throw err;
    }

    const list = Array.isArray(friends) ? friends : [];
    let count = 0;
    store.transaction(() => {
      for (const f of list) {
        const uid = String(f.userId || f.id || "");
        if (!uid) continue;
        store.run(
          `INSERT OR REPLACE INTO friends
           (user_id, display_name, zalo_name, avatar, updated_at)
           VALUES ($userId, $displayName, $zaloName, $avatar, $updatedAt)`,
          {
            $userId: uid,
            $displayName: String(f.displayName || f.name || ""),
            $zaloName: String(f.zaloName || ""),
            $avatar: String(f.avatar || ""),
            $updatedAt: Date.now(),
          }
        );
        count++;
      }
    });
    dirty();
    return { synced: count };
  }

  async function syncResume() {
    if (!api) return { resumed: 0 };
    const pendings = getPendingSyncs();
    let resumed = 0;
    for (const s of pendings) {
      try {
        if (s.entity_type === "group") {
          await syncGroupHistory(s.entity_id);
        } else if (s.entity_type === "user") {
          await syncDMHistory(s.entity_id);
        }
        resumed++;
      } catch (err) {
        console.error(`[repo] resume sync failed for ${s.entity_type}:${s.entity_id}:`, err.message);
      }
    }
    return { resumed };
  }

  // ── Stats ─────────────────────────────────────────────────────────

  function getStats() {
    const msgCount = store.selectOne(`SELECT COUNT(*) as count FROM messages`);
    const threadCount = store.selectOne(`SELECT COUNT(*) as count FROM threads`);
    const attachCount = store.selectOne(`SELECT COUNT(*) as count FROM attachments`);
    return {
      messages: msgCount?.count || 0,
      threads: threadCount?.count || 0,
      attachments: attachCount?.count || 0,
    };
  }

  return {
    saveIncoming,
    saveCatchup,
    saveHistory,
    getContext,
    search,
    getRecentMessages,
    getCheckpoint,
    getCheckpoints,
    getCheckpointsForCatchup,
    upsertCheckpoint,
    migrateFromJson,
    upsertSyncState,
    getSyncState,
    getPendingSyncs,
    getSyncStats,
    syncGroupHistory,
    syncDMHistory,
    syncFriends,
    syncResume,
    getStats,
  };
}

// ── History message normalizer (shared) ──────────────────────────────

function normalizeHistoryMsg(rawMsg, threadId, threadType) {
  const senderId = String(rawMsg.uidFrom || rawMsg.senderId || "");
  return {
    messageId: String(rawMsg.msgId || rawMsg.globalMsgId || ""),
    cliMsgId: String(rawMsg.cliMsgId || ""),
    threadId: String(threadId),
    threadType: String(threadType),
    senderId,
    senderName: String(rawMsg.dName || ""),
    text: String(rawMsg.content || rawMsg.text || ""),
    msgType: String(rawMsg.msgType || ""),
    ts: Number(rawMsg.ts || rawMsg.timestamp || 0),
    isSelf: false,
    contentJson: JSON.stringify(rawMsg),
  };
}
