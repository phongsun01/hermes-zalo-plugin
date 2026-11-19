
// bridge-watchdog.js - Auto-restart bridge on crash, never give up
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WatchdogController } from "./lib/watchdog-core.js";
import { RotatingLogStream } from "./lib/rotating-logger.js";

const BRIDGE_DIR = import.meta.dirname;
const RETRY_DELAY_MS = 3000;
const PORT = parseInt(process.env.ZALO_PLUGIN_PORT || "8787", 10);
const TOKEN = process.env.ZALO_PLUGIN_TOKEN || "";

const controller = new WatchdogController();
const rotatingLog = new RotatingLogStream(path.join(BRIDGE_DIR, "bridge.log"), {
  maxSize: 5 * 1024 * 1024,
  maxBackups: 3,
});

let child = null;

function logWatchdog(...args) {
  const line = args.join(" ") + "\n";
  process.stdout.write(line);
  rotatingLog.write(line);
}

function startBridge() {
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    child = null;
  }

  logWatchdog("[watchdog] starting bridge");
  child = spawn("node", ["server.js"], {
    cwd: BRIDGE_DIR,
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      ZALO_PLUGIN_HOST: process.env.ZALO_PLUGIN_HOST || "0.0.0.0",
      ZALO_IMAGE_SAVE_PATH: process.env.ZALO_IMAGE_SAVE_PATH || "D:\\ZaloImages",
      ZALO_CATCHUP_ENGINE: process.env.ZALO_CATCHUP_ENGINE || "ws",
      ZALO_ENABLE_CATCHUP: process.env.ZALO_ENABLE_CATCHUP || "true",
      ZALO_LOG_MESSAGES: process.env.ZALO_LOG_MESSAGES || "1",
    },
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    rotatingLog.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    rotatingLog.write(chunk);
  });

  child.on("exit", (code) => {
    logWatchdog(`[watchdog] bridge exited with code ${code}`);
    logWatchdog(`[watchdog] restarting in ${RETRY_DELAY_MS / 1000}s...`);
    setTimeout(startBridge, RETRY_DELAY_MS);
  });
}

// Poll /health to detect session death, degraded socket or silent listener
async function healthCheck() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (!res.ok) return;
    const data = await res.json();

    const decision = controller.evaluate(data);
    if (decision.action === "relogin") {
      logWatchdog(
        `[watchdog] ${decision.reason} detected — triggering cookie relogin (attempt ${controller.consecutiveReloginFailures}/${controller.maxReloginPerHour})`
      );
      const headers = { "Content-Type": "application/json" };
      if (TOKEN) headers["x-bridge-token"] = TOKEN;
      try {
        await fetch(`http://127.0.0.1:${PORT}/relogin`, {
          method: "POST",
          headers,
          body: JSON.stringify({ forceQR: false }),
        });
      } catch (err) {
        logWatchdog("[watchdog] relogin request failed:", err?.message || err);
      }
    }
  } catch {
    // Bridge not ready yet
  }
}

startBridge();
setInterval(healthCheck, 10000);
logWatchdog("[watchdog] running — will restart bridge on crash indefinitely");
