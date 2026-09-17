import { readFileSync } from "node:fs";

const checks = [
  ["client/src-tauri/src/db.rs", ["LocalAccountCreate", "create_local_account", "update_local_account", "retire_local_account", "LocalProfileUpdate", "update_local_profile", "SELECT id FROM my_profile WHERE account_pool_id = ?1 ORDER BY id LIMIT 1"]],
  ["client/src-tauri/src/lib.rs", ["create_local_account", "update_local_account", "retire_local_account", "update_local_profile"]],
  ["client/src/lib/local.ts", ["createLocalAccount", "updateLocalAccount", "retireLocalAccount", "updateLocalProfile"]],
  ["client/src/pages/AccountPool.tsx", ["createLocalAccount", "updateLocalAccount", "retireLocalAccount", "本地账号池"]],
  ["client/src/pages/Profile.tsx", ["updateLocalProfile", "本地账号尚未接入平台资料抓取"]],
];

for (const [file, markers] of checks) {
  const source = readFileSync(file, "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${file} 缺少本地账号/人设门禁: ${marker}`);
  }
}
console.log(`local account/profile: ${checks.length} source boundaries checked`);
