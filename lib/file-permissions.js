// lib/file-permissions.js
// Platform-aware secure file permission utility.
// Enforces chmod 0600 on Unix, and icacls ACL restriction on Windows NTFS.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function secureFilePermissions(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;

  if (process.platform === "win32") {
    const username = process.env.USERNAME;
    if (!username) return false;
    try {
      execFileSync(
        "icacls",
        [filePath, "/inheritance:r", "/grant:r", `${username}:(F)`],
        { stdio: "ignore", windowsHide: true }
      );
      return true;
    } catch {
      // Non-fatal if filesystem doesn't support NTFS ACLs (e.g. FAT32, exFAT)
      return false;
    }
  } else {
    try {
      fs.chmodSync(filePath, 0o600);
      return true;
    } catch {
      return false;
    }
  }
}
