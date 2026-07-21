// bridge-watchdog.js - Auto-restart bridge on crash, never give up
import { spawn } from "node:child_process";
import fs from "node:fs";

const BRIDGE_DIR = import.meta.dirname;
const RETRY_DELAY_MS = 3000;

let child = null;

function startBridge() {
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    child = null;
  }

  console.log("[watchdog] starting bridge");
  child = spawn("node", ["server.js"], {
    cwd: BRIDGE_DIR,
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      ZALO_PLUGIN_HOST: process.env.ZALO_PLUGIN_HOST || "0.0.0.0",
      ZALO_IMAGE_SAVE_PATH: process.env.ZALO_IMAGE_SAVE_PATH || "D:\\ZaloImages",
    },
  });

  child.on("exit", (code) => {
    console.log(`[watchdog] bridge exited with code ${code}`);
    console.log(`[watchdog] restarting in ${RETRY_DELAY_MS / 1000}s...`);
    setTimeout(startBridge, RETRY_DELAY_MS);
  });
}

// Poll /health to detect session death and trigger relogin
async function healthCheck() {
  try {
    const res = await fetch("http://127.0.0.1:8787/health");
    const data = await res.json();

    if (data.sessionDead) {
      console.log("[watchdog] session dead — triggering relogin");
      try {
        await fetch("http://127.0.0.1:8787/relogin", { method: "POST" });
      } catch {}
    }
  } catch {
    // Bridge not ready yet
  }
}

startBridge();
setInterval(healthCheck, 10000);
console.log("[watchdog] running — will restart bridge on crash indefinitely");
