// lib/watchdog-core.js
// Core monitoring and decision engine for bridge watchdog.
// Separated from network/process I/O to enable 100% automated unit testing.

export const DEFAULTS = Object.freeze({
  maxReloginPerHour: 3,
  reloginWindowMs: 60 * 60 * 1000, // 1 hour sliding window
  backoffDelays: [10_000, 30_000, 90_000], // 10s, 30s, 90s backoff after 1st, 2nd, 3rd attempts
  degradedThresholdMs: 60_000, // 60s continuous degraded before soft relogin
});

export class WatchdogController {
  constructor(opts = {}) {
    this.maxReloginPerHour = opts.maxReloginPerHour ?? DEFAULTS.maxReloginPerHour;
    this.reloginWindowMs = opts.reloginWindowMs ?? DEFAULTS.reloginWindowMs;
    this.backoffDelays = opts.backoffDelays ?? DEFAULTS.backoffDelays;
    this.degradedThresholdMs = opts.degradedThresholdMs ?? DEFAULTS.degradedThresholdMs;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? console;

    // State
    this.reloginHistory = [];
    this.consecutiveReloginFailures = 0;
    this.lastReloginAttemptAt = 0;
    this.firstDegradedAt = 0;
    this.limitReachedLogged = false;
  }

  /**
   * Evaluates current health response from bridge and decides action.
   * @param {object|null} healthData - Parsed JSON from /health (or null if bridge unreachable)
   * @returns {{ action: 'none' | 'relogin', reason?: string, delay?: number }}
   */
  evaluate(healthData) {
    if (!healthData || typeof healthData !== "object") {
      // Bridge is down / unreachable: handled by process supervisor, not soft relogin
      return { action: "none", reason: "bridge_unreachable" };
    }

    const state = healthData.state;
    // Guard 1: Never intervene when reconnecting or catching up
    if (state === "CONNECTING" || state === "CATCHUP") {
      this.firstDegradedAt = 0;
      return { action: "none", reason: `busy_state_${state}` };
    }

    const isSessionDead = Boolean(healthData.sessionDead);
    const isDegraded =
      healthData.status === "degraded" ||
      healthData.listenerStatus === "degraded" ||
      healthData.listenerStatus === "disconnected" ||
      (healthData.loggedIn === false && state !== "CONNECTING" && state !== "CATCHUP");

    // Guard 2: Healthy state resets failure trackers
    if (!isSessionDead && !isDegraded && healthData.status === "healthy" && state === "READY") {
      this.consecutiveReloginFailures = 0;
      this.firstDegradedAt = 0;
      this.limitReachedLogged = false;
      return { action: "none", reason: "healthy" };
    }

    const currentEpoch = this.now();

    // Check degraded duration threshold (unless session is completely dead)
    if (!isSessionDead) {
      if (!this.firstDegradedAt) {
        this.firstDegradedAt = currentEpoch;
        return { action: "none", reason: "degraded_grace_period" };
      }
      if (currentEpoch - this.firstDegradedAt < this.degradedThresholdMs) {
        return { action: "none", reason: "degraded_below_threshold" };
      }
    }

    // Attempt relogin check
    return this._checkRateLimitAndBackoff(currentEpoch, isSessionDead ? "session_dead" : "degraded_timeout");
  }

  _checkRateLimitAndBackoff(currentEpoch, triggerReason) {
    // 1. Filter sliding window to past 1 hour
    this.reloginHistory = this.reloginHistory.filter(
      (ts) => currentEpoch - ts < this.reloginWindowMs
    );

    // 2. Ceiling check (max 3 per hour)
    if (this.reloginHistory.length >= this.maxReloginPerHour) {
      if (!this.limitReachedLogged) {
        this.log.error(
          `\n[watchdog ERROR] Đã chạm trần relogin (${this.maxReloginPerHour} lần/giờ)! Dừng tự động can thiệp để bảo vệ tài khoản Zalo.`
        );
        this.log.error(
          `[watchdog ERROR] Trạng thái vẫn là DEGRADED. Cần kiểm tra thủ công hoặc đợi hết cửa sổ 1 giờ.\n`
        );
        this.limitReachedLogged = true;
      }
      return { action: "none", reason: "rate_limit_exceeded" };
    }

    // 3. Exponential backoff check (if previous attempts failed)
    if (this.consecutiveReloginFailures > 0) {
      const attemptIdx = Math.min(this.consecutiveReloginFailures - 1, this.backoffDelays.length - 1);
      const requiredDelay = this.backoffDelays[attemptIdx];
      if (this.lastReloginAttemptAt > 0 && currentEpoch - this.lastReloginAttemptAt < requiredDelay) {
        return {
          action: "none",
          reason: "backing_off",
          delay: requiredDelay - (currentEpoch - this.lastReloginAttemptAt),
        };
      }
    }

    // Approved: record attempt
    this.reloginHistory.push(currentEpoch);
    this.lastReloginAttemptAt = currentEpoch;
    this.consecutiveReloginFailures += 1;

    return { action: "relogin", reason: triggerReason };
  }
}
