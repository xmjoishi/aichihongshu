import { readFileSync } from "node:fs";

const source = readFileSync("client/src/lib/aiProposal.ts", "utf8");
for (const marker of ["AIProposal", "createProposal", "isProposalCurrent", "listProposals", "saveProposal", 'status: "pending"', "baseVersion", "previousValue"]) {
  if (!source.includes(marker)) throw new Error(`AI 提案门禁缺少: ${marker}`);
}
const notes = readFileSync("client/src/pages/Notes.tsx", "utf8");
for (const marker of ["adoptAIProposal", "listProposals", "saveProposal", "查看差异", "creator-note-ai-diff"]) {
  if (!notes.includes(marker)) throw new Error(`笔记页缺少 AI 差异视图: ${marker}`);
}
console.log("AI proposal: version and account conflict markers checked");
