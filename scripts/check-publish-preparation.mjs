import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["client/src/lib/publishPreparation.ts", ["preparePublish", "snapshotKey", "canSubmitPublishAttempt", "MEDIA_REQUIRED"]],
  ["client/src/lib/local.ts", ["LocalPublishOutboxStatus", "prepareLocalPublish", "updateLocalPublish", "readLocalPublishOutbox"]],
  ["client/src-tauri/src/db.rs", ["publish_outbox", "submitted", "unknown", "禁止重复提交"]],
  ["client/src-tauri/src/lib.rs", ["prepare_local_publish", "update_local_publish", "read_local_publish_outbox"]],
  ["client/src/pages/Notes.tsx", ["preparePublish", "发布检查", "publishPreparation"]],
  ["client/src/pages/Publish.tsx", ["LocalPublishWorkflow", "不会自动提交平台", "updateLocalNoteStatus", "preparePublish", "我已完成平台提交", "结果不明", "publishOutboxStatusLabel"]],
  ["client/src/App.tsx", ["<Route path=\"/publish\" element={<Publish />} />"]],
];
const failures = [];
for (const [file, markers] of checks) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file}: missing ${marker}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
console.log(JSON.stringify({ ok: true, scope: "publish-preparation-and-idempotency", files: checks.length }));
