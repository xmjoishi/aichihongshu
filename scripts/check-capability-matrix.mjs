import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("client/src/lib/capabilities.ts"), "utf8");
const required = [
  "note.read",
  "note.write",
  "note.items.write",
  "library.read",
  "library.import",
  "library.repair",
  "library.delete",
  "ai.generate",
  "collect",
  "publish",
  "note.export",
];
for (const id of required) {
  if (!source.includes(`"${id}"`)) throw new Error(`能力矩阵缺少 ${id}`);
}
if (!source.includes("validateCapabilityMatrix(LOCAL_CAPABILITIES)") || !source.includes("validateCapabilityMatrix(LEGACY_CAPABILITIES)")) {
  throw new Error("能力矩阵纯函数自检未执行");
}
console.log(`capability matrix: ${required.length} required operations checked`);
