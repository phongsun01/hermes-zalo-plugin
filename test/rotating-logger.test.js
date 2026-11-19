import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RotatingLogStream } from "../lib/rotating-logger.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rot-test-"));
}

test("RotatingLogStream: Tự xoay vòng khi đạt maxSize và lưu tối đa 3 file backup", () => {
  const tmpDir = makeTmpDir();
  const logFile = path.join(tmpDir, "test.log");

  try {
    // maxSize = 50 bytes, maxBackups = 3
    const logger = new RotatingLogStream(logFile, { maxSize: 50, maxBackups: 3 });

    // Ghi 40 bytes (chưa chạm 50)
    logger.write("A".repeat(40));
    assert.equal(fs.existsSync(logFile), true);
    assert.equal(fs.existsSync(`${logFile}.1`), false);

    // Ghi tiếp 20 bytes -> vượt 50 -> rotate lần 1 (.1 được tạo)
    logger.write("B".repeat(20));
    assert.equal(fs.existsSync(`${logFile}.1`), true);
    assert.equal(fs.readFileSync(`${logFile}.1`, "utf8"), "A".repeat(40));
    assert.equal(fs.readFileSync(logFile, "utf8"), "B".repeat(20));

    // Rotate lần 2
    logger.write("C".repeat(40)); // Vượt 50 -> .1 thành .2, main thành .1
    assert.equal(fs.existsSync(`${logFile}.2`), true);
    assert.equal(fs.readFileSync(`${logFile}.2`, "utf8"), "A".repeat(40));

    // Rotate lần 3
    logger.write("D".repeat(40)); // .2 thành .3
    assert.equal(fs.existsSync(`${logFile}.3`), true);
    assert.equal(fs.readFileSync(`${logFile}.3`, "utf8"), "A".repeat(40));

    // Rotate lần 4: Vượt maxBackups (3) -> .3 cũ nhất ("A"x40) bị xóa
    logger.write("E".repeat(40));
    assert.equal(fs.existsSync(`${logFile}.3`), true);
    assert.equal(fs.existsSync(`${logFile}.4`), false);
    assert.equal(fs.readFileSync(`${logFile}.3`, "utf8"), "B".repeat(20));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
