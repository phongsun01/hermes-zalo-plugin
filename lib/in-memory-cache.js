// In-memory caches to avoid SQLite queries on hot paths.
// Persistence lives in SQLite only — caches are best-effort.

const LRU_MAX = 500;
const FRIEND_CACHE_MAX = 2000;

export function createCache() {
  // msgId → { cliMsgId, ts }  (for undo, limited to LRU_MAX)
  const _msgIdCache = new Map();

  // Set of known group IDs (avoid repeated DB/API queries)
  const _knownGroupIds = new Set();

  // userId → displayName
  const _friendMap = new Map();

  function recordCliMsgId(msgId, cliMsgId, ts) {
    if (!msgId || !cliMsgId) return;
    if (_msgIdCache.size >= LRU_MAX) {
      const firstKey = _msgIdCache.keys().next().value;
      _msgIdCache.delete(firstKey);
    }
    _msgIdCache.set(String(msgId), { cliMsgId: String(cliMsgId), ts: Number(ts || Date.now()) });
  }

  function getCliMsgId(msgId) {
    return _msgIdCache.get(String(msgId || ""));
  }

  function hasCliMsgId(msgId) {
    return _msgIdCache.has(String(msgId || ""));
  }

  function addGroupId(groupId) {
    _knownGroupIds.add(String(groupId));
  }

  function hasGroupId(groupId) {
    return _knownGroupIds.has(String(groupId));
  }

  function getGroupIds() {
    return new Set(_knownGroupIds);
  }

  function seedGroupIds(ids) {
    _knownGroupIds.clear();
    for (const id of ids) _knownGroupIds.add(String(id));
  }

  function setFriend(userId, displayName) {
    if (_friendMap.size >= FRIEND_CACHE_MAX) {
      const firstKey = _friendMap.keys().next().value;
      _friendMap.delete(firstKey);
    }
    _friendMap.set(String(userId), String(displayName || ""));
  }

  function getFriend(userId) {
    return _friendMap.get(String(userId || ""));
  }

  function seedFriends(friends) {
    _friendMap.clear();
    for (const [uid, name] of Object.entries(friends)) {
      _friendMap.set(String(uid), String(name || ""));
    }
  }

  function getStats() {
    return {
      msgIdCacheSize: _msgIdCache.size,
      groupIdsSize: _knownGroupIds.size,
      friendMapSize: _friendMap.size,
    };
  }

  return {
    recordCliMsgId,
    getCliMsgId,
    hasCliMsgId,
    addGroupId,
    hasGroupId,
    getGroupIds,
    seedGroupIds,
    setFriend,
    getFriend,
    seedFriends,
    getStats,
  };
}
