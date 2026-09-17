import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["client/src/lib/browserCapture.ts", ["validateBrowserCapture", "ACCOUNT_MISMATCH", "MAX_MESSAGE_BYTES", "dedupeKey"]],
  ["client/src/pages/Inspire.tsx", ["validateBrowserCapture", "targetAccountId", "transport: \"manual\"", "dedupeKey", "AICHIHONGSHU_BROWSER_CAPTURE", "aichihongshu-browser-capture"]],
];
const failures = [];
for (const [file, markers] of checks) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file}: missing ${marker}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
console.log(JSON.stringify({ ok: true, scope: "browser-capture-host-validation", files: checks.length }));
