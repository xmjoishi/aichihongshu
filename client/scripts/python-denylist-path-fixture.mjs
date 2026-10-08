import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const [binDirectory, logPath] = process.argv.slice(2);
assert.ok(binDirectory, "denylist directory is required");
assert.ok(logPath, "denial log path is required");

const expectedCommands = ["python3", "python3.12", "pypy3.12", "pypy2.7", "pip3.12", "uvx"];
for (const command of expectedCommands) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      AICHIHONGSHU_PYTHON_DENY_LOG: logPath,
    },
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 97, `PATH denylist must stop ${command}`);
}
assert.deepEqual((await readFile(logPath, "utf8")).trim().split(/\r?\n/), expectedCommands);
