import { readFileSync } from "node:fs";

const checks = [
  ["client/src/pages/Settings.tsx", [
    "LocalDataMigrationSection",
    "readLocalRuntimeStatus",
    "db:import-plan",
    "db:preflight",
    "db:backup",
    "db:restore-check",
    "replace、merge 或 cancel",
    "不会自动覆盖当前数据库",
  ]],
  ["scripts/desktop-db-safety.mjs", [
    "function migrationPlan",
    "decisionRequired",
    "defaultDecision: \"cancel\"",
    "writes: false",
    "function backup",
    "function restoreCheck",
    "function migrationExecute",
    "mode === \"cancel\"",
    "mode === \"replace\"",
    "mode === \"merge\"",
    "ACCOUNT_MAPPING_REQUIRED",
    "TARGET_NON_EMPTY",
    "MISSING_ASSETS",
    "backup(sourceReal",
    "copyReferencedAssets",
    "swapMigrationArtifacts",
  ]],
  ["package.json", ["db:import-plan", "db:import", "db:backup", "db:restore-check"]],
];

for (const [file, markers] of checks) {
  const source = readFileSync(file, "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${file} 缺少迁移安全边界: ${marker}`);
  }
}

console.log(`data migration: ${checks.length} source boundaries checked`);
