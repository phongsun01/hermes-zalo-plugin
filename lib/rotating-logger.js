// lib/rotating-logger.js
// Rotating log file stream: rotates when file reaches maxSize (default 5MB),
// keeping up to maxBackups (default 3) backup files.

import fs from "node:fs";
import path from "node:path";
import { secureFilePermissions } from "./file-permissions.js";

export const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_MAX_BACKUPS = 3;

export class RotatingLogStream {
  constructor(filePath, opts = {}) {
    this.filePath = path.resolve(filePath);
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxBackups = opts.maxBackups ?? DEFAULT_MAX_BACKUPS;

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._currentSize = 0;
    this._init();
  }

  _init() {
    if (fs.existsSync(this.filePath)) {
      try {
        this._currentSize = fs.statSync(this.filePath).size;
      } catch {
        this._currentSize = 0;
      }
    } else {
      fs.writeFileSync(this.filePath, "");
      this._currentSize = 0;
    }
    secureFilePermissions(this.filePath);
  }

  rotate() {
    try {
      // 1. Remove oldest backup if it exists
      const oldestBackup = `${this.filePath}.${this.maxBackups}`;
      if (fs.existsSync(oldestBackup)) {
        fs.unlinkSync(oldestBackup);
      }

      // 2. Shift existing backups: .2 -> .3, .1 -> .2
      for (let i = this.maxBackups - 1; i >= 1; i -= 1) {
        const src = `${this.filePath}.${i}`;
        const dst = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, dst);
        }
      }

      // 3. Move main file to .1
      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }

      // 4. Create new empty main file
      fs.writeFileSync(this.filePath, "");
      this._currentSize = 0;
      secureFilePermissions(this.filePath);
    } catch (err) {
      // Non-fatal error during rotation
      console.error(`[RotatingLogStream] rotation error for ${this.filePath}:`, err.message);
    }
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (this._currentSize + buf.length >= this.maxSize) {
      this.rotate();
    }
    fs.appendFileSync(this.filePath, buf);
    this._currentSize += buf.length;
  }
}
