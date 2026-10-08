import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(process.cwd(), "browser-extension/connection-diagnostics.js"), "utf8");
const context = { globalThis: {}, Boolean, Number, Object, String, Math };
vm.runInNewContext(source, context, { filename: "connection-diagnostics.js" });
const diagnostics = context.globalThis.AichiConnectionDiagnostics;

const cases = [
  [{ runtimeError: "Specified native messaging host not found.", step: "host" }, "HOST_MISSING"],
  [{ runtimeError: "Access to the specified native messaging host is forbidden.", step: "host" }, "HOST_REGISTRATION_OLD"],
  [{ runtimeError: "Native host has exited.", step: "host" }, "HOST_START_FAILED"],
  [{ response: { ok: false, errorCode: "INSTANCE_OFFLINE" }, step: "desktop_instance" }, "INSTANCE_OFFLINE"],
  [{ response: { ok: false, errorCode: "PROTOCOL_INCOMPATIBLE" }, step: "version_handshake" }, "PROTOCOL_INCOMPATIBLE"],
  [{ response: { ok: false, errorCode: "ACCOUNT_READ_FAILED" }, step: "account_read" }, "ACCOUNT_READ_FAILED"],
  [{ timedOut: true, step: "host" }, "UNKNOWN_TIMEOUT"],
  [{ response: { ok: false, errorCode: "REQUEST_REJECTED" }, step: "host", action: "list_capture_instances" }, "HOST_REGISTRATION_OLD"],
];
for (const [input, expected] of cases) assert.equal(diagnostics.classify(input).code, expected);

const redacted = diagnostics.redactedRecord({
  extensionVersion: "0.8.2",
  appVersion: "1.2.3",
  channel: "dev",
  step: "account_read",
  errorCode: "ACCOUNT_READ_FAILED",
  durationMs: 43,
  accountName: "must-not-escape",
  accountId: 42,
  pageBody: "private page text",
  executablePath: "/Users/private/app",
});
assert.deepEqual(JSON.parse(JSON.stringify(redacted)), {
  extensionVersion: "0.8.2",
  appVersion: "1.2.3",
  channel: "dev",
  step: "account_read",
  errorCode: "ACCOUNT_READ_FAILED",
  durationMs: 43,
});
assert.equal(JSON.stringify(redacted).includes("must-not-escape"), false);
assert.equal(JSON.stringify(redacted).includes("private page text"), false);
assert.equal(JSON.stringify(redacted).includes("/Users/private/app"), false);
assert.equal(diagnostics.redactedRecord({ durationMs: 999_999 }).durationMs, 120_000);

console.log(JSON.stringify({
  ok: true,
  scenarios: ["missing host", "stale registration", "host startup failure", "offline instance", "protocol mismatch", "account read failure", "unknown timeout", "legacy host response", "redacted diagnostics whitelist"],
}));
