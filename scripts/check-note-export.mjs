import { readFileSync } from "node:fs";

const helper = readFileSync("client/src/lib/noteMarkdown.ts", "utf8");
for (const marker of ["NoteMarkdownInput", "noteToMarkdown", "状态：", "创建："]) {
  if (!helper.includes(marker)) throw new Error(`本地 Markdown 导出缺少: ${marker}`);
}
const notes = readFileSync("client/src/pages/Notes.tsx", "utf8");
for (const marker of ["noteToMarkdown", "localMode", "复制 Markdown"]) {
  if (!notes.includes(marker)) throw new Error(`笔记导出接入缺少: ${marker}`);
}
console.log("local note export: legacy-compatible markdown markers checked");
