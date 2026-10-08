import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findForbiddenPythonResources,
  pythonResourceViolation,
} from "./python-resource-guard.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "tauri-resource-guard-"));

try {
  const worker = path.join(root, "resources", "browser-worker");
  await mkdir(path.join(worker, "runtime"), { recursive: true });
  await writeFile(path.join(worker, "runtime", "node"), "native Node runtime fixture");
  await writeFile(path.join(worker, "LICENSE.python-2.0.txt"), "license metadata only");

  assert.equal(pythonResourceViolation("resources/browser-worker/runtime/node"), null);
  assert.equal(pythonResourceViolation("resources/browser-worker/LICENSE.python-2.0.txt"), null);
  assert.match(pythonResourceViolation("app/server.py"), /retired app\/crawler/);
  assert.match(pythonResourceViolation("lib/python3.12/site-packages/tool.py"), /Python runtime/);
  assert.match(pythonResourceViolation("bin/libpython3.12.dylib"), /interpreter or runtime library/);
  assert.match(pythonResourceViolation("runtime/pythonw.exe"), /interpreter or runtime library/);
  assert.match(pythonResourceViolation("runtime/python3.12-config"), /interpreter or runtime library/);

  const mappedResources = { "resources/browser-worker/": "browser-worker/" };
  assert.deepEqual(await findForbiddenPythonResources(mappedResources, root), []);

  if (process.platform !== "win32") {
    const internalLink = path.join(worker, "runtime-alias");
    await symlink(path.join(worker, "runtime"), internalLink, "dir");
    assert.deepEqual(await findForbiddenPythonResources(mappedResources, root), []);
    await rm(internalLink);
  }

  await mkdir(path.join(worker, "vendor", "helpers"), { recursive: true });
  await writeFile(path.join(worker, "vendor", "helpers", "extract.py"), "print('legacy')");
  await mkdir(path.join(worker, "runtime", "python3.12", "bin"), { recursive: true });
  await writeFile(path.join(worker, "runtime", "python3.12", "bin", "python3.12"), "interpreter");
  const violations = await findForbiddenPythonResources(mappedResources, root);
  assert.equal(violations.length, 2);
  assert.ok(violations.some((value) => value.includes("vendor/helpers/extract.py")));
  assert.ok(violations.some((value) => value.includes("runtime/python3.12")));

  await rm(path.join(worker, "vendor", "helpers", "extract.py"));
  await rm(path.join(worker, "runtime", "python3.12"), { recursive: true });
  if (process.platform !== "win32") {
    const externalRoot = path.join(root, "outside-resource-tree");
    await mkdir(externalRoot, { recursive: true });
    await writeFile(path.join(externalRoot, "helper.py"), "print('outside')");
    await symlink(externalRoot, path.join(worker, "external-runtime"), "dir");
    const externalLinkViolations = await findForbiddenPythonResources(mappedResources, root);
    assert.equal(externalLinkViolations.length, 1);
    assert.match(externalLinkViolations[0], /symlink escapes its packaged resource tree/);
  }

  const wildcard = await findForbiddenPythonResources(["resources/**/*.py"], root);
  assert.equal(wildcard.length, 1);
  assert.match(wildcard[0], /wildcard bundle resource cannot be audited safely/);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write("Tauri resource audit rejects Python resources and escaping symlinks; internal links pass.\n");
