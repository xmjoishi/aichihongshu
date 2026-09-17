import fs from "node:fs";

const knowledge = fs.readFileSync("client/src/pages/KnowledgeTab.tsx", "utf8");
const data = fs.readFileSync("client/src/pages/Data.tsx", "utf8");

const requiredKnowledgeMarkers = [
  "if (IS_TAURI_RUNTIME)",
  "readLocalInspirations",
  "不会回退请求旧服务",
  "启停偏好尚未迁移",
];

for (const marker of requiredKnowledgeMarkers) {
  if (!knowledge.includes(marker)) {
    throw new Error(`KnowledgeTab 缺少本地经验库边界: ${marker}`);
  }
}

if (!data.includes("notes={allNotes}") || !data.includes("referenceAccounts={allAccounts.map")) {
  throw new Error("Data 页面没有把当前账号笔记与榜样样本传给本地经验库");
}

console.log("local knowledge boundary check passed");
