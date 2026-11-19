import test from "node:test";
import assert from "node:assert/strict";
import { WatchdogController } from "../lib/watchdog-core.js";

function mockClock(start = 1_000_000) {
  let curr = start;
  return {
    now: () => curr,
    advance: (ms) => {
      curr += ms;
      return curr;
    },
  };
}

function mockLogger() {
  const errors = [];
  const logs = [];
  return {
    error: (...args) => errors.push(args.join(" ")),
    log: (...args) => logs.push(args.join(" ")),
    errors,
    logs,
  };
}

test("Watchdog: State CONNECTING hoặc CATCHUP không bao giờ kích hoạt relogin", () => {
  const clock = mockClock();
  const logger = mockLogger();
  const controller = new WatchdogController({ now: clock.now, log: logger });

  for (const busyState of ["CONNECTING", "CATCHUP"]) {
    const res = controller.evaluate({
      status: "degraded",
      listenerStatus: "disconnected",
      sessionDead: true,
      state: busyState,
    });
    assert.equal(res.action, "none");
    assert.match(res.reason, /^busy_state_/);
  }
});

test("Watchdog: Trạng thái healthy & READY reset các bộ đếm lỗi", () => {
  const clock = mockClock();
  const controller = new WatchdogController({ now: clock.now });
  controller.consecutiveReloginFailures = 2;
  controller.firstDegradedAt = 500_000;

  const res = controller.evaluate({
    status: "healthy",
    listenerStatus: "connected",
    loggedIn: true,
    sessionDead: false,
    state: "READY",
  });

  assert.equal(res.action, "none");
  assert.equal(res.reason, "healthy");
  assert.equal(controller.consecutiveReloginFailures, 0);
  assert.equal(controller.firstDegradedAt, 0);
});

test("Watchdog: Listener mất kết nối < 60s không relogin (grace period)", () => {
  const clock = mockClock();
  const controller = new WatchdogController({ now: clock.now });

  const health = {
    status: "degraded",
    listenerStatus: "disconnected",
    sessionDead: false,
    state: "DISCONNECTED",
  };

  // Lần đầu phát hiện: ghi nhận firstDegradedAt
  const r1 = controller.evaluate(health);
  assert.equal(r1.action, "none");
  assert.equal(r1.reason, "degraded_grace_period");

  // Sau 45s (chưa đủ 60s): bỏ qua
  clock.advance(45_000);
  const r2 = controller.evaluate(health);
  assert.equal(r2.action, "none");
  assert.equal(r2.reason, "degraded_below_threshold");
});

test("Watchdog (Acceptance Criteria): Listener mất kết nối 70s gọi relogin đúng 1 lần", () => {
  const clock = mockClock();
  const controller = new WatchdogController({ now: clock.now });

  const health = {
    status: "degraded",
    listenerStatus: "disconnected",
    sessionDead: false,
    state: "DISCONNECTED",
  };

  controller.evaluate(health); // 0s
  clock.advance(70_000); // 70s

  const r = controller.evaluate(health);
  assert.equal(r.action, "relogin");
  assert.equal(r.reason, "degraded_timeout");
  assert.equal(controller.consecutiveReloginFailures, 1);
  assert.equal(controller.reloginHistory.length, 1);

  // Thử lại ngay (chưa hết 10s backoff): bị chặn bởi backoff
  clock.advance(2_000);
  const rBlocked = controller.evaluate(health);
  assert.equal(rBlocked.action, "none");
  assert.equal(rBlocked.reason, "backing_off");
});

test("Watchdog (Acceptance Criteria): Lần thứ 4 trong cùng 1 giờ bị chặn và ghi log ERROR", () => {
  const clock = mockClock();
  const logger = mockLogger();
  const controller = new WatchdogController({ now: clock.now, log: logger });

  const health = {
    status: "degraded",
    listenerStatus: "disconnected",
    sessionDead: true, // sessionDead không cần đợi 60s grace period
    state: "DISCONNECTED",
  };

  // Lần 1: Cho phép (chờ 0s)
  const r1 = controller.evaluate(health);
  assert.equal(r1.action, "relogin");

  // Lần 2: Sau 10s backoff
  clock.advance(10_001);
  const r2 = controller.evaluate(health);
  assert.equal(r2.action, "relogin");

  // Lần 3: Sau 30s backoff
  clock.advance(30_001);
  const r3 = controller.evaluate(health);
  assert.equal(r3.action, "relogin");
  assert.equal(controller.reloginHistory.length, 3);

  // Lần 4: Sau 90s backoff nhưng đã chạm trần 3 lần / giờ -> BỊ CHẶN!
  clock.advance(90_001);
  const r4 = controller.evaluate(health);
  assert.equal(r4.action, "none");
  assert.equal(r4.reason, "rate_limit_exceeded");
  assert.equal(logger.errors.length >= 1, true, "Phải ghi log ERROR");
  assert.match(logger.errors[0], /chạm trần relogin/i);

  // Sau 1 giờ (3600s), cửa sổ trượt hết hạn, relogin được mở khóa lại
  clock.advance(3600_000);
  const r5 = controller.evaluate(health);
  assert.equal(r5.action, "relogin", "Sau 1 giờ phải cho phép relogin lại");
});
