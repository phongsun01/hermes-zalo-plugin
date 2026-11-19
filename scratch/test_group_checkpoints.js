// scratch/test_group_checkpoints.js
// Step 3 verification for Group real checkpoint and old checkpoint.

import { ZaloClient } from "../zaloClient.js";
import { credentialsPath, qrPath, cliMsgDir } from "../paths.js";
import { createStore } from "../lib/sqlite-store.js";
import path from "node:path";
import os from "node:os";

async function main() {
  const dbPath = path.join(os.homedir(), ".hermes-zalo", "zalo.sqlite");
  const store = await createStore(dbPath);

  const topGroup = store.select(
    `SELECT thread_id, thread_type, last_message_id, last_ts, updated_at
     FROM threads
     WHERE thread_type = 'group' AND is_hidden = 0 AND last_message_id <> '' AND last_ts > 0
     ORDER BY last_ts DESC LIMIT 1`
  )[0];

  const threeDaysAgo = Date.now() - 3 * 86400 * 1000;
  const oldGroup = store.select(
    `SELECT thread_id, thread_type, last_message_id, last_ts, updated_at
     FROM threads
     WHERE thread_type = 'group' AND is_hidden = 0 AND last_message_id <> '' AND last_ts > 0
       AND last_ts < $cutoff
     ORDER BY last_ts DESC LIMIT 1`,
    { $cutoff: threeDaysAgo }
  )[0];

  console.log("Top Group Checkpoint:", topGroup);
  console.log("Old (3d+) Group Checkpoint:", oldGroup);

  const client = new ZaloClient({
    credentialsPath: credentialsPath(),
    qrPath: qrPath(),
    selfListen: false,
    cliMsgDir: cliMsgDir(),
  });

  await client.login({ forceQR: false });
  const api = client.api;
  while (!(api.listener?.ws?.readyState === 1)) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const ask = (type, lastId) =>
    new Promise((res) => {
      const t = setTimeout(() => res(null), 8000);
      api.listener.once("old_messages", (msgs, tType) => {
        if (tType === type) {
          clearTimeout(t);
          res(msgs);
        }
      });
      api.listener.requestOldMessages(type, lastId);
    });

  if (topGroup) {
    console.log("\n--- 1. Testing Top Group with msgId:", topGroup.last_message_id, "---");
    const resTop = await ask(1, String(topGroup.last_message_id));
    console.log("Top Group count:", resTop?.length ?? "null");
    if (resTop && resTop.length) {
      const first = resTop[0];
      const last = resTop[resTop.length - 1];
      console.log("First msg after checkpoint:", first.data.msgId, first.data.ts, new Date(Number(first.data.ts)).toISOString(), "thread:", first.threadId);
      console.log("Last msg:", last.data.msgId, last.data.ts, new Date(Number(last.data.ts)).toISOString(), "thread:", last.threadId);
      const allNewer = resTop.every((m) => Number(m.data.ts) >= topGroup.last_ts);
      console.log("All returned messages are >= checkpoint last_ts?", allNewer);
    }
  }

  if (oldGroup) {
    await new Promise((r) => setTimeout(r, 1500));
    console.log("\n--- 2. Testing Old (3d+) Group with msgId:", oldGroup.last_message_id, "---");
    const resOld = await ask(1, String(oldGroup.last_message_id));
    console.log("Old Group count:", resOld?.length ?? "null");
    if (resOld && resOld.length) {
      const first = resOld[0];
      const last = resOld[resOld.length - 1];
      console.log("First msg after old checkpoint:", first.data.msgId, first.data.ts, new Date(Number(first.data.ts)).toISOString(), "thread:", first.threadId);
      console.log("Last msg:", last.data.msgId, last.data.ts, new Date(Number(last.data.ts)).toISOString(), "thread:", last.threadId);
      const allNewer = resOld.every((m) => Number(m.data.ts) >= oldGroup.last_ts);
      console.log("All returned messages are >= old checkpoint last_ts?", allNewer);
    }
  } else {
    console.log("\nNo group checkpoint older than 3 days found in DB.");
  }

  await client.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
