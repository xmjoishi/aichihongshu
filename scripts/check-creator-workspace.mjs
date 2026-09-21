import { readFileSync } from "node:fs";

const source = readFileSync("client/src/pages/Notes.tsx", "utf8");
const aiPanel = readFileSync("client/src/components/AIPanel.tsx", "utf8");
for (const marker of ["当前账号：", "creator-note-save-status", "creator-note-aux-collapse", "window.innerWidth >= 900", "type=\"button\"", "aria-disabled={!aiGenerate.available}", "available={aiGenerate.available}"]) {
  if (!source.includes(marker)) throw new Error(`创作台门禁缺少: ${marker}`);
}
for (const marker of ["重新检测", "setLocalProbeVersion", "桌面进程无法完成本地 CLI 检测"]) {
  if (!aiPanel.includes(marker)) throw new Error(`AI 助手门禁缺少: ${marker}`);
}
console.log("creator workspace: account, save state, and auxiliary panel markers checked");
