import fs from "fs";

const MAX_CONTEXT_MESSAGES = 100;

export function createRepository(store, opts = {}) {
  function makeMsgUid(threadId, messageId, cliMsgId) {
    const uid = String(messageId || cliMsgId || Date.now());
    return String(threadId || "") + ":" + uid;
  }

  function dirty() {
    if (typeof opts.onDirty === "function") opts.onDirty();
  }

  function saveIncoming(ev) {
    const direction = ev.isSelf ? "outgoing" : "incoming";
    const {
      messageId, cliMsgId, threadId, threadType, senderId, senderName,
      text, attachment, media, msgType, ts, isSelf, contentJson,
    } = ev;
    const tsNum = Number(ts || Date.now());
    const textStr = typeof text === "string" ? text : JSON.stringify(text || "");
    const msgUid = makeMsgUid(threadId, messageId, cliMsgId);

    store.transaction(() => {
      store.run(
        `INSERT OR IGNORE INTO messages
         (message_uid, message_id, thread_id, thread_type, sender_id, sender_name,
          direction, text, msg_type, ts, content_json)
         VALUES ($msgUid, $messageId, $threadId, $threadType, $senderId, $senderName,
          $direction, $text, $msgType, $ts, $contentJson)`,
        {
          $msgUid: msgUid,
          $messageId: String(messageId || ""),
          $threadId: String(threadId || ""),
          $threadType: String(threadType || "user"),
          $senderId: String(senderId || ""),
          $senderName: String(senderName || ""),
          $direction: direction,
          $text: textStr,
          $msgType: String(msgType || ""),
          $ts: tsNum,
          $contentJson: contentJson ? JSON.stringify(contentJson) : "",
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
            duration, file_size, file_name)
           VALUES ($msgUid, $type, $url, $thumbnail, $width, $height,
            $duration, $fileSize, $fileName)`,
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
          }
        );
      }
    });
    dirty();
  }

  function saveHistory(messages) {
    if (!messages || !messages.length) return;
    store.transaction(() => {
      for (const msg of messages) {
        const direction = msg.isSelf ? "outgoing" : "incoming";
        const msgId = String(msg.messageId || msg.msgId || "");
        const threadId = String(msg.threadId || "");
        const msgUid = makeMsgUid(threadId, msgId, msg.cliMsgId);
        store.run(
          `INSERT OR IGNORE INTO messages
           (message_uid, message_id, thread_id, thread_type, sender_id, sender_name,
            direction, text, msg_type, ts, content_json)
           VALUES ($msgUid, $messageId, $threadId, $threadType, $senderId, $senderName,
            $direction, $text, $msgType, $ts, $contentJson)`,
          {
            $msgUid: msgUid,
            $messageId: msgId,
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

  function search(query, limit = 50) {
    const like = `%${query}%`;
    return store.select(
      `SELECT * FROM messages
       WHERE text LIKE $query OR sender_name LIKE $query
       ORDER BY ts DESC
       LIMIT $limit`,
      { $query: like, $limit: limit }
    );
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

  function upsertSyncState(entityType, entityId, status, errorMsg = "") {
    store.run(
      `INSERT INTO sync_state (entity_type, entity_id, status, error_msg, started_at, completed_at)
       VALUES ($entityType, $entityId, $status, $errorMsg,
        CASE WHEN $status IN ('in_progress','pending') THEN $now ELSE 0 END,
        CASE WHEN $status IN ('done','error') THEN $now ELSE 0 END)
       `,
      {
        $entityType: String(entityType),
        $entityId: String(entityId),
        $status: String(status),
        $errorMsg: String(errorMsg),
        $now: Date.now(),
      }
    );
  }

  function getPendingSyncs() {
    return store.select(
      `SELECT * FROM sync_state WHERE status IN ('pending','in_progress','error')
       ORDER BY id ASC`
    );
  }

  function getSyncStats() {
    const total = store.selectOne(`SELECT COUNT(*) as total FROM sync_state`);
    const pending = store.selectOne(
      `SELECT COUNT(*) as pending FROM sync_state WHERE status IN ('pending','in_progress','error')`
    );
    return { total: total?.total || 0, pending: pending?.pending || 0 };
  }

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
    saveHistory,
    getContext,
    search,
    getCheckpoint,
    getCheckpoints,
    getCheckpointsForCatchup,
    upsertCheckpoint,
    migrateFromJson,
    upsertSyncState,
    getPendingSyncs,
    getSyncStats,
    getStats,
  };
}
