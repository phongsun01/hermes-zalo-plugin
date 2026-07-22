// Resumable HistorySync — only knows Repository, not API or Store.
// Reads sync_state to continue from where it left off.

export class HistorySync {
  constructor(repository, opts = {}) {
    this._repository = repository;
    this._running = false;
    this._stopped = false;
    this._concurrency = opts.concurrency || 3;
    this._startedAt = 0;
    this._lastError = null;
  }

  get isRunning() {
    return this._running;
  }

  get startedAt() {
    return this._startedAt;
  }

  get lastError() {
    return this._lastError;
  }

  async start() {
    if (this._running) throw new Error("HistorySync already running");
    this._running = true;
    this._stopped = false;
    this._startedAt = Date.now();
    this._lastError = null;
    const result = { groups: 0, friends: 0, resumed: 0 };

    try {
      // 1. Resume any pending/error entities first
      const resumed = await this._repository.syncResume();
      result.resumed = resumed.resumed || 0;
      if (this._stopped) return this._finish(result);

      // 2. Sync friends directory
      const friends = await this._repository.syncFriends();
      result.friends = friends.synced || 0;
      if (this._stopped) return this._finish(result);

      // 3. Groups are synced on-demand via catchup; HistorySync start()
      //    only syncs friends + resumes pendings. Full group backfill
      //    belongs to a separate backfill job.
    } catch (err) {
      this._lastError = err.message;
      throw err;
    } finally {
      this._finish(result);
    }

    return result;
  }

  async resume() {
    if (this._running) throw new Error("HistorySync already running");
    this._running = true;
    this._stopped = false;
    this._startedAt = Date.now();
    this._lastError = null;
    const result = { resumed: 0 };

    try {
      const r = await this._repository.syncResume();
      result.resumed = r.resumed || 0;
    } catch (err) {
      this._lastError = err.message;
      throw err;
    } finally {
      this._finish(result);
    }

    return result;
  }

  stop() {
    this._stopped = true;
  }

  _finish(result) {
    this._running = false;
    return result;
  }
}
