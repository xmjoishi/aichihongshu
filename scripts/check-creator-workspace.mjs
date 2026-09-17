import { readFileSync } from "node:fs";

const source = readFileSync("client/src/pages/Notes.tsx", "utf8");
for (const marker of ["当前账号：", "creator-note-save-status", "creator-note-aux-collapse", "window.innerWidth >= 900", "aria-disabled={!aiGenerate.available}", "available={aiGenerate.available}"]) {
  if (!source.includes(marker)) throw new Error(`创作台门禁缺少: ${marker}`);
}
console.log("creator workspace: account, save state, and auxiliary panel markers checked");
