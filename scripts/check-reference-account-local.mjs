import { readFileSync } from "node:fs";

const checks = [
  ["client/src-tauri/src/db.rs", ["LocalReferenceAccountCreate", "create_local_reference_account", "update_local_reference_account", "delete_local_reference_account"]],
  ["client/src-tauri/src/lib.rs", ["create_local_reference_account", "update_local_reference_account", "delete_local_reference_account"]],
  ["client/src/lib/local.ts", ["createLocalReferenceAccount", "updateLocalReferenceAccount", "deleteLocalReferenceAccount"]],
  ["client/src/pages/Accounts.tsx", ["账号 ID 或主页标识", "本地榜样账号暂未接入平台资料分析", "deleteLocalReferenceAccount", "updateLocalReferenceAccount"]],
];

for (const [file, markers] of checks) {
  const source = readFileSync(file, "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${file} 缺少本地榜样账号门禁: ${marker}`);
  }
}
console.log(`local reference account: ${checks.length} source boundaries checked`);
