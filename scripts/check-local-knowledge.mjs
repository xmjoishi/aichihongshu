import fs from "node:fs";

const knowledge = fs.readFileSync("client/src/pages/KnowledgeTab.tsx", "utf8");
const data = fs.readFileSync("client/src/pages/Data.tsx", "utf8");
const local = fs.readFileSync("client/src/lib/local.ts", "utf8");
const aiPanel = fs.readFileSync("client/src/components/AIPanel.tsx", "utf8");
const context = fs.readFileSync("client/src/lib/localKnowledge.ts", "utf8");

const requiredKnowledgeMarkers = [
  "if (IS_TAURI_RUNTIME)",
  "readLocalInspirations",
  "不会回退请求旧服务",
  "开关保存到本地账号偏好",
  "saveLocalKnowledgePreferences",
];

for (const marker of requiredKnowledgeMarkers) {
  if (!knowledge.includes(marker)) {
    throw new Error(`KnowledgeTab 缺少本地经验库边界: ${marker}`);
  }
}

if (!data.includes("notes={allNotes}") || !data.includes("referenceAccounts={allAccounts.map")) {
  throw new Error("Data 页面没有把当前账号笔记与榜样样本传给本地经验库");
}

for (const marker of ["readLocalKnowledgePreferences", "LocalKnowledgePreferences"]) {
  if (!local.includes(marker)) throw new Error(`local.ts 缺少经验库持久化入口: ${marker}`);
}
for (const marker of ["buildLocalKnowledgeContext", "effectiveSystemExtra", "local-ai-knowledge"]) {
  if (!aiPanel.includes(marker)) throw new Error(`AIPanel 缺少本地经验注入边界: ${marker}`);
}
for (const marker of ["computeRulesFromNotes", "persona_tone", "useMySamples", "useReferenceSamples", "useInspirations", "泄露来源链接"]) {
  if (!context.includes(marker)) throw new Error(`localKnowledge.ts 缺少摘要边界: ${marker}`);
}

console.log("local knowledge boundary check passed");
