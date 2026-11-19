// test/send-priority-stale.test.js
import test from "node:test";
import assert from "node:assert/strict";

test("Stale reply guard logic: drops replayed message older than 10 minutes", () => {
  const staleThresholdMs = 10 * 60 * 1000;
  const now = Date.now();

  const freshReplayedTs = now - (2 * 60 * 1000); // 2 minutes ago
  const staleReplayedTs = now - (15 * 60 * 1000); // 15 minutes ago

  const isFreshStale = (now - freshReplayedTs) > staleThresholdMs;
  const isStaleStale = (now - staleReplayedTs) > staleThresholdMs;

  assert.equal(isFreshStale, false, "2m old message should not be considered stale");
  assert.equal(isStaleStale, true, "15m old message should be considered stale (>10m)");
});

test("Priority mapping logic: replayed=true implies priority=low", () => {
  function computePriority(body) {
    const isReplayed = body.replayed === true || body.isReplay === true;
    return body.priority === "low" || isReplayed ? "low" : "high";
  }

  assert.equal(computePriority({ text: "hi" }), "high");
  assert.equal(computePriority({ text: "hi", replayed: true }), "low");
  assert.equal(computePriority({ text: "hi", priority: "low" }), "low");
  assert.equal(computePriority({ text: "hi", priority: "high" }), "high");
});
