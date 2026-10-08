import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "client/src-tauri/Cargo.toml");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, "client/src-tauri/target");
const binaryPath = path.join(targetDir, "debug/aichihongshu");
const build = spawnSync("cargo", ["build", "--manifest-path", manifestPath, "--bin", "aichihongshu"], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);
if (!fs.existsSync(binaryPath)) throw new Error(`Native host binary not found: ${binaryPath}`);

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

function readFrame(buffer) {
  if (buffer.length < 4) throw new Error("Native host did not return a frame header");
  const length = buffer.readUInt32LE();
  if (length > 160 * 1024 || buffer.length !== length + 4) throw new Error(`Invalid response frame length: ${length}`);
  return JSON.parse(buffer.subarray(4).toString("utf8"));
}

async function invokeManifestHost(manifest, socketPath, input, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.AICHIHONGSHU_CAPTURE_SOCKET;
  if (socketPath) env.AICHIHONGSHU_CAPTURE_SOCKET = socketPath;
  const child = spawn(manifest.path, manifest.allowed_origins, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Rust Native Messaging host timed out"));
    }, 8000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end(input);
  const code = await closed;
  const bytes = Buffer.concat(stdout);
  return { code, response: bytes.length ? readFrame(bytes) : null, stderr: Buffer.concat(stderr).toString("utf8") };
}

function generateManifest(channel, rootDir) {
  const output = spawnSync(binaryPath, ["--native-host-fixture", rootDir], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AICHIHONGSHU_CAPTURE_CHANNEL: channel },
  });
  if (output.status !== 0) throw new Error(`Could not generate ${channel} host manifest: ${output.stderr}`);
  const manifestPath = output.stdout.trim();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.args !== undefined) throw new Error(`${channel} host manifest must not contain args`);
  if (!fs.statSync(manifest.path).isFile() || (fs.statSync(manifest.path).mode & 0o111) === 0) {
    throw new Error(`${channel} host path is not an executable launcher`);
  }
  if (!fs.readFileSync(manifest.path, "utf8").includes(`AICHIHONGSHU_CAPTURE_CHANNEL=${channel}`)) {
    throw new Error(`${channel} launcher is not bound to its environment`);
  }
  if (manifest.name !== (channel === "dev" ? "com.aichihongshu.host.dev" : "com.aichihongshu.host")) {
    throw new Error(`${channel} host name did not match the channel`);
  }
  const productionKey = JSON.parse(fs.readFileSync(path.join(root, "browser-extension/manifest.json"), "utf8")).key;
  const devKey = fs.readFileSync(path.join(root, "browser-extension/dev-public-key.txt"), "utf8").trim();
  const productionId = extensionId(productionKey);
  const devId = extensionId(devKey);
  const expectedOrigins = channel === "dev"
    ? [`chrome-extension://${devId}/`, `chrome-extension://${productionId}/`]
    : [`chrome-extension://${productionId}/`];
  if (JSON.stringify(manifest.allowed_origins) !== JSON.stringify(expectedOrigins)) {
    throw new Error(`${channel} host must allow only the exact approved extension origins`);
  }
  return { manifest, manifestPath };
}

function extensionId(key) {
  return crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)
    .toString("hex").replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

async function withSocket(handler) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const socketPath = `/tmp/ahnh-${process.pid}-${suffix}.sock`;
  const server = net.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, close: () => new Promise((resolve) => server.close(() => { fs.rmSync(socketPath, { force: true }); resolve(); })) };
}

async function withSocketAt(socketPath, handler) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, close: () => new Promise((resolve) => server.close(() => { fs.rmSync(socketPath, { force: true }); resolve(); })) };
}

function registerInstance(home, channel, workspaceId) {
  const dir = path.join(home, ".aichihongshu", "instances", channel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${workspaceId}.json`), JSON.stringify({
    workspaceId,
    channel,
    executablePath: binaryPath,
    launchTarget: binaryPath,
    appVersion: "fixture",
    protocolVersion: 12,
  }));
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `aichihongshu-native-host-${process.pid}-`));
const prodFixture = generateManifest("prod", path.join(tempRoot, "prod"));
const devFixture = generateManifest("dev", path.join(tempRoot, "dev"));
if (prodFixture.manifest.name === devFixture.manifest.name
  || prodFixture.manifest.allowed_origins[0] === devFixture.manifest.allowed_origins[0]) {
  throw new Error("Production and development Native Messaging identities must be isolated");
}

const outcomes = ["manifest path invoked with browser argv only", "production/dev host and exact extension origins isolated"];
{
  let received;
  const server = await withSocket((socket) => socket.on("data", (chunk) => {
    received = JSON.parse(chunk.toString("utf8").trim());
    socket.end('{"ok":true,"status":"ready"}\n');
  }));
  const result = await invokeManifestHost(prodFixture.manifest, server.socketPath, frame({ action: "ping", protocolVersion: 12 }));
  await server.close();
  if (result.code !== 0 || result.response?.ok !== true || result.response?.channel !== "prod" || received?.action !== "ping") throw new Error("production manifest host launch/ack fixture failed");
  outcomes.push("production manifest host valid socket response");
}
{
  const server = await withSocket((socket) => socket.on("data", () => socket.end('{"ok":false,"error":"business rejection"}\n')));
  const result = await invokeManifestHost(devFixture.manifest, server.socketPath, frame({ action: "capture" }));
  await server.close();
  if (result.code !== 0 || result.response?.ok !== false || result.response?.error !== "business rejection" || result.response?.channel !== "dev") throw new Error("development manifest host rejection fixture failed");
  outcomes.push("development manifest host business rejection");
}
{
  const result = await invokeManifestHost(prodFixture.manifest, `/tmp/ahnh-missing-${process.pid}-${crypto.randomBytes(3).toString("hex")}.sock`, frame({ action: "ping" }));
  if (result.code !== 0 || result.response?.ok !== false || result.response?.errorCode !== "INSTANCE_OFFLINE") throw new Error("Rust host missing socket fixture failed");
  outcomes.push("offline socket classified");
}
{
  const home = `/tmp/ahnr-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  fs.rmSync(home, { recursive: true, force: true });
  registerInstance(home, "prod", "workspace-selected-offline");
  registerInstance(home, "prod", "workspace-online-a");
  registerInstance(home, "prod", "workspace-online-b");
  let onlineARequests = 0;
  let onlineBRequests = 0;
  const socketA = await withSocketAt(path.join(home, ".aichihongshu", "instances", "prod", "workspace-online-a.sock"), (socket) => {
    socket.on("data", () => {
      onlineARequests += 1;
      socket.end(JSON.stringify({ ok: true, status: "ready", channel: "prod", workspaceId: "workspace-online-a", protocolVersion: 12 }) + "\n");
    });
  });
  const socketB = await withSocketAt(path.join(home, ".aichihongshu", "instances", "prod", "workspace-online-b.sock"), (socket) => {
    socket.on("data", () => {
      onlineBRequests += 1;
      socket.end(JSON.stringify({ ok: true, status: "ready", channel: "prod", workspaceId: "workspace-online-b", protocolVersion: 12 }) + "\n");
    });
  });
  const env = { HOME: home };
  try {
    const noSelection = await invokeManifestHost(prodFixture.manifest, null, frame({
      action: "ping", protocolVersion: 12, expectedChannel: "prod",
    }), env);
    if (noSelection.response?.errorCode !== "INSTANCE_SELECTION_REQUIRED" || onlineARequests || onlineBRequests) {
      throw new Error("multiple online workspaces must require an explicit selection");
    }
    for (const instance of noSelection.response.instances ?? []) {
      if ("executablePath" in instance || "launchTarget" in instance) {
        throw new Error("instance discovery must not disclose executable or installation paths");
      }
    }
    const selectedOffline = await invokeManifestHost(prodFixture.manifest, null, frame({
      action: "ping", protocolVersion: 12, expectedChannel: "prod", expectedWorkspaceId: "workspace-selected-offline",
    }), env);
    if (selectedOffline.response?.errorCode !== "INSTANCE_OFFLINE" || onlineARequests || onlineBRequests) {
      throw new Error("an offline selected workspace must never fail over to another database");
    }
    const selectedOnline = await invokeManifestHost(prodFixture.manifest, null, frame({
      action: "ping", protocolVersion: 12, expectedChannel: "prod", expectedWorkspaceId: "workspace-online-b",
    }), env);
    if (selectedOnline.response?.workspaceId !== "workspace-online-b" || onlineARequests || onlineBRequests !== 1) {
      throw new Error("explicit workspace selection must route only to its own socket");
    }
  } finally {
    await socketA.close();
    await socketB.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  outcomes.push("multi-instance selection and no-failover routing");
}
{
  const result = await invokeManifestHost(devFixture.manifest, "/tmp/ahnh-unused.sock", frame({ body: "x".repeat(300 * 1024) }));
  if (result.code === 0 || result.response !== null) throw new Error("Rust host oversized frame fixture failed");
  outcomes.push("oversized frame rejected");
}

console.log(JSON.stringify({ ok: true, binaryPath, manifests: [prodFixture.manifestPath, devFixture.manifestPath], runtimeDependency: "none (Rust app executable behind fixed shell launcher)", scenarios: outcomes }));
fs.rmSync(tempRoot, { recursive: true, force: true });
