import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";

const target = process.env.AICHIHONGSHU_PYTHON_AUDIT_TARGET;
assert.ok(target, "absolute Python target must be provided");

const child = spawnSync(
  process.execPath,
  ["-e", `require("node:child_process").spawnSync(${JSON.stringify(target)}, ["--version"])`],
  { encoding: "utf8" },
);
assert.notEqual(child.status, 0, "the Node audit must propagate to child Node processes");
assert.match(child.stderr, /Blocked Python runtime command/);
process.stdout.write("Node child-process audit propagated to a grandchild process.\n");
