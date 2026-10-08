import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["client/src/lib/publishPreparation.ts", ["preparePublish", "snapshotKey", "canSubmitPublishAttempt", "MEDIA_REQUIRED", "videoPath", "本地视频文件"]],
  ["client/src/lib/localTypes.ts", ["LocalPublishOutboxStatus"]],
  ["client/src/lib/local/workspace.ts", ["prepareLocalPublish", "updateLocalPublish", "readLocalPublishOutbox"]],
  ["client/src-tauri/src/db/notes.rs", ["publish_outbox", "submitted", "unknown", "禁止重复提交"]],
  ["client/src-tauri/src/lib.rs", ["prepare_local_publish", "update_local_publish", "read_local_publish_outbox"]],
  ["client/src/pages/Notes.tsx", ["preparePublish", "发布检查", "publishPreparation"]],
  ["client/src/pages/Publish.tsx", ["LocalPublishWorkflow", "不会自动提交平台", "updateLocalNoteStatus", "preparePublish", "我已完成平台提交", "结果不明", "publishOutboxStatusLabel", "视频素材", "页面未接受时可手动选择"]],
  ["client/src/App.tsx", ["<Route path=\"/publish\" element={<Navigate to=\"/notes?view=publish\" replace />} />"]],
];
const failures = [];
for (const [file, markers] of checks) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file}: missing ${marker}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
console.log(JSON.stringify({ ok: true, scope: "publish-preparation-and-idempotency", files: checks.length }));
