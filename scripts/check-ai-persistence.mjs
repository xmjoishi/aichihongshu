import { readFileSync } from "node:fs";

const source = readFileSync("client/src/hooks/useAIStream.ts", "utf8");
const rustSource = readFileSync("client/src-tauri/src/db.rs", "utf8");
const required = [
  "localStorage",
  "AIRunMetadata",
  'status: "interrupted"',
  'finishRun("completed")',
  'finishRun("failed"',
  'finishRun("cancelled"',
  "MAX_HISTORY_MESSAGES",
  "saveLocalAIRun",
  "readLocalAIRun",
  "updateLocalAIRun",
  "saveLocalAIRunArtifact",
  "readLocalAIRunArtifacts",
];
for (const marker of required) {
  if (!source.includes(marker)) throw new Error(`AI 持久化门禁缺少: ${marker}`);
}
if (source.includes("sessionStorage.setItem")) throw new Error("AI 历史不能继续直接写入 sessionStorage");
for (const marker of ["ai_run_artifacts", "save_local_ai_artifact", "local_ai_artifacts"]) {
  if (!rustSource.includes(marker)) throw new Error(`AI 产物持久化门禁缺少: ${marker}`);
}
console.log(`AI persistence: ${required.length} durability markers checked`);
