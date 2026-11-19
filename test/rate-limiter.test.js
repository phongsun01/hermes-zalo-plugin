// test/rate-limiter.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PriorityRateLimiter } from "../lib/priority-rate-limiter.js";

test("PriorityRateLimiter: burst capacity executes immediately", async () => {
  let simulatedTime = 100_000;
  const limiter = new PriorityRateLimiter({
    burst: 5,
    ratePerMinute: 20, // 3000ms per token
    now: () => simulatedTime,
  });

  const executed = [];
  const p1 = limiter.enqueue(() => executed.push(1), { priority: "high" });
  const p2 = limiter.enqueue(() => executed.push(2), { priority: "high" });
  const p3 = limiter.enqueue(() => executed.push(3), { priority: "high" });
  const p4 = limiter.enqueue(() => executed.push(4), { priority: "high" });
  const p5 = limiter.enqueue(() => executed.push(5), { priority: "high" });

  await Promise.all([p1, p2, p3, p4, p5]);

  assert.deepEqual(executed, [1, 2, 3, 4, 5]);
  assert.equal(limiter.stats.tokens, 0);
  assert.equal(limiter.stats.highQueueLength, 0);
  assert.equal(limiter.stats.lowQueueLength, 0);
});

test("PriorityRateLimiter: 6th message is throttled until token is refilled", async () => {
  // Test with fast real clock: ratePerMinute = 1200 (1 token per 50ms)
  const limiter = new PriorityRateLimiter({
    burst: 3,
    ratePerMinute: 1200, // 50ms per token
  });

  const times = [];
  const start = Date.now();

  const promises = [];
  for (let i = 0; i < 4; i++) {
    promises.push(
      limiter.enqueue(() => {
        times.push(Date.now() - start);
      }, { priority: "high" })
    );
  }

  await Promise.all(promises);

  // First 3 should execute immediately (< 25ms)
  assert.ok(times[0] < 25, `Expected immediate execution for item 0, got ${times[0]}ms`);
  assert.ok(times[1] < 25, `Expected immediate execution for item 1, got ${times[1]}ms`);
  assert.ok(times[2] < 25, `Expected immediate execution for item 2, got ${times[2]}ms`);

  // 4th item had to wait for at least ~40ms (50ms nominal)
  assert.ok(times[3] >= 35, `Expected throttling for item 3, got ${times[3]}ms`);
});

test("PriorityRateLimiter: HIGH priority preempts LOW priority in queue", async () => {
  // Use simulated time: 1 token every 1000ms
  let simulatedTime = 1000;
  const limiter = new PriorityRateLimiter({
    burst: 1,
    ratePerMinute: 60, // 1 token per 1000ms
    now: () => simulatedTime,
  });

  const executionOrder = [];

  // Consume the 1 burst token
  await limiter.enqueue(() => executionOrder.push("burst-0"), { priority: "high" });
  assert.equal(limiter.stats.tokens, 0);

  // Queue two LOW priority tasks
  const pLow1 = limiter.enqueue(() => executionOrder.push("low-1"), { priority: "low" });
  const pLow2 = limiter.enqueue(() => executionOrder.push("low-2"), { priority: "low" });

  // Now queue one HIGH priority task AFTER the low priority tasks
  const pHigh1 = limiter.enqueue(() => executionOrder.push("high-1"), { priority: "high" });

  assert.equal(limiter.highQueue.length, 1);
  assert.equal(limiter.lowQueue.length, 2);

  // Advance time by 1000ms -> 1 token available, trigger drain
  simulatedTime += 1000;
  limiter._drain();

  // HIGH-1 must have executed first, despite being queued after low-1 and low-2!
  assert.equal(executionOrder[executionOrder.length - 1], "high-1");

  // Advance time by another 1000ms -> low-1 executes
  simulatedTime += 1000;
  limiter._drain();
  assert.equal(executionOrder[executionOrder.length - 1], "low-1");

  // Advance time by another 1000ms -> low-2 executes
  simulatedTime += 1000;
  limiter._drain();
  assert.equal(executionOrder[executionOrder.length - 1], "low-2");

  await Promise.all([pLow1, pLow2, pHigh1]);

  assert.deepEqual(executionOrder, ["burst-0", "high-1", "low-1", "low-2"]);
});

test("PriorityRateLimiter: token replenishment caps at burst capacity", () => {
  let simulatedTime = 10_000;
  const limiter = new PriorityRateLimiter({
    burst: 5,
    ratePerMinute: 20,
    now: () => simulatedTime,
  });

  // Start with 5
  assert.equal(limiter.stats.tokens, 5);

  // Advance time by 1 hour (plenty of time to generate tokens)
  simulatedTime += 3_600_000;

  // Must not exceed burst capacity (5)
  assert.equal(limiter.stats.tokens, 5);
});

test("PriorityRateLimiter: handles task rejection without stalling queue", async () => {
  const limiter = new PriorityRateLimiter({
    burst: 2,
    ratePerMinute: 60,
  });

  const pError = limiter.enqueue(() => {
    throw new Error("Simulated failure");
  }, { priority: "high" });

  const pSuccess = limiter.enqueue(() => "ok", { priority: "high" });

  await assert.rejects(pError, { message: "Simulated failure" });
  const res = await pSuccess;
  assert.equal(res, "ok");
});
