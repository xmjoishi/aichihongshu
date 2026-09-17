import { readFileSync } from "node:fs";

const source = readFileSync("client/src/lib/inspirationCapture.ts", "utf8");
const page = readFileSync("client/src/pages/Inspire.tsx", "utf8");
const localAdapter = readFileSync("client/src/lib/local.ts", "utf8");
const rustDb = readFileSync("client/src-tauri/src/db.rs", "utf8");
const rustCommands = readFileSync("client/src-tauri/src/lib.rs", "utf8");
for (const marker of ["Inspiration", "listInspirations", "addInspiration", "markInspirationConverted", "https?", "status: \"converted\""]) {
  if (!source.includes(marker)) throw new Error(`灵感收集门禁缺少: ${marker}`);
}
for (const marker of ["保存灵感 / 书签", "转为草稿", "仅保存到当前账号"]) {
  if (!page.includes(marker)) throw new Error(`灵感页面门禁缺少: ${marker}`);
}
for (const marker of ["readLocalInspirations", "saveLocalInspiration", "convertLocalInspiration"]) {
  if (!localAdapter.includes(marker) || !page.includes(marker)) throw new Error(`本地灵感持久化门禁缺少: ${marker}`);
}
for (const marker of ["LocalInspirationCreate", "local_inspirations", "save_local_inspiration", "convert_local_inspiration", "CREATE TABLE IF NOT EXISTS inspirations"]) {
  if (!rustDb.includes(marker)) throw new Error(`Rust 灵感持久化门禁缺少: ${marker}`);
}
for (const marker of ["read_local_inspirations", "save_local_inspiration", "convert_local_inspiration"]) {
  if (!rustCommands.includes(marker)) throw new Error(`Tauri 灵感 command 门禁缺少: ${marker}`);
}
console.log("inspiration capture: scoped validation, SQLite persistence, and explicit conversion markers checked");
