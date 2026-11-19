// lib/priority-rate-limiter.js
// Priority Token Bucket Rate Limiter for Zalo Bridge outbound messages.
// Enforces:
//   1. Burst capacity (default: 5 tokens) - allows instant responses to immediate bursts
//   2. Steady-state rate limit (default: 20 tokens/minute = 1 token per 3 seconds)
//   3. Strict Priority Queue: "high" priority (interactive user replies) ALWAYS dispatches
//      ahead of "low" priority (replayed catchup messages, background broadcasts)

export class PriorityRateLimiter {
  /**
   * @param {Object} [options]
   * @param {number} [options.burst] Max tokens stored (default: 5)
   * @param {number} [options.ratePerMinute] Token replenishment per minute (default: 20)
   * @param {() => number} [options.now] Custom timestamp provider for testing
   */
  constructor(options = {}) {
    const envBurst = parseInt(process.env.ZALO_RATE_BURST, 10);
    const envRate = parseInt(process.env.ZALO_RATE_PER_MINUTE, 10);

    this.burst = Number.isFinite(options.burst) ? options.burst : (Number.isFinite(envBurst) && envBurst > 0 ? envBurst : 5);
    this.ratePerMinute = Number.isFinite(options.ratePerMinute) ? options.ratePerMinute : (Number.isFinite(envRate) && envRate > 0 ? envRate : 20);
    
    // Interval in ms for 1 token: e.g. 60,000 / 20 = 3,000ms
    this.tokenIntervalMs = 60_000 / this.ratePerMinute;

    this.now = typeof options.now === "function" ? options.now : () => Date.now();

    this.tokens = this.burst;
    this.lastRefill = this.now();

    this.highQueue = []; // [{ fn, resolve, reject, priority: 'high', queuedAt }]
    this.lowQueue = [];  // [{ fn, resolve, reject, priority: 'low', queuedAt }]
    this._timer = null;
  }

  /**
   * Refill tokens based on elapsed wall-clock time.
   */
  _refill() {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefill);
    if (elapsed > 0) {
      const addedTokens = elapsed / this.tokenIntervalMs;
      this.tokens = Math.min(this.burst, this.tokens + addedTokens);
      this.lastRefill = current;
    }
  }

  /**
   * Current stats for health check / telemetry.
   */
  get stats() {
    this._refill();
    return {
      tokens: Math.round(this.tokens * 100) / 100,
      burst: this.burst,
      ratePerMinute: this.ratePerMinute,
      tokenIntervalMs: this.tokenIntervalMs,
      highQueueLength: this.highQueue.length,
      lowQueueLength: this.lowQueue.length,
      isDraining: this._timer !== null,
    };
  }

  /**
   * Enqueue a task to be executed once a token is available.
   * High priority tasks are always dequeued before Low priority tasks.
   *
   * @template T
   * @param {() => Promise<T> | T} taskFn
   * @param {{ priority?: "high" | "low" }} [options]
   * @returns {Promise<T>}
   */
  enqueue(taskFn, { priority = "high" } = {}) {
    const effPriority = priority === "low" ? "low" : "high";
    return new Promise((resolve, reject) => {
      const item = {
        fn: taskFn,
        resolve,
        reject,
        priority: effPriority,
        queuedAt: this.now(),
      };

      if (effPriority === "high") {
        this.highQueue.push(item);
      } else {
        this.lowQueue.push(item);
      }

      this._drain();
    });
  }

  /**
   * Acquire 1 token, resolving when available.
   *
   * @param {{ priority?: "high" | "low" }} [options]
   * @returns {Promise<void>}
   */
  acquire({ priority = "high" } = {}) {
    return this.enqueue(() => Promise.resolve(), { priority });
  }

  /**
   * Process items in the queues as tokens permit.
   */
  _drain() {
    this._refill();

    // While we have at least 1 whole token and work waiting
    while (this.tokens >= 1 && (this.highQueue.length > 0 || this.lowQueue.length > 0)) {
      // HIGH PRIORITY STRICTLY PREEMPTS LOW PRIORITY
      const item = this.highQueue.length > 0 ? this.highQueue.shift() : this.lowQueue.shift();
      this.tokens -= 1;
      this._dispatch(item);
    }

    // If items are still queued and no refill timer is active, schedule one
    if ((this.highQueue.length > 0 || this.lowQueue.length > 0) && !this._timer) {
      const tokensNeeded = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil(tokensNeeded * this.tokenIntervalMs));
      this._timer = setTimeout(() => {
        this._timer = null;
        this._drain();
      }, waitMs);

      if (this._timer && typeof this._timer.unref === "function") {
        this._timer.unref();
      }
    }
  }

  /**
   * Execute a single queued item safely without blocking the drain loop.
   */
  async _dispatch(item) {
    try {
      const res = await item.fn();
      item.resolve(res);
    } catch (err) {
      item.reject(err);
    }
  }

  /**
   * Clear all pending items and cancel timer (useful for testing or shutdown).
   */
  reset() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const err = new Error("RateLimiter reset");
    for (const item of this.highQueue) item.reject(err);
    for (const item of this.lowQueue) item.reject(err);
    this.highQueue = [];
    this.lowQueue = [];
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }
}
