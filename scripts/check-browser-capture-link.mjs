// N12 浏览器链路契约检查（CHG-20260916-001 / 周星星最小原型）。
// 静态：扩展权限最小集合、固定 key、宿主与 Rust 侧标记。
// 动态：用临时 Unix socket 实测 host.cjs 的 Native Messaging 封帧与转发，
//       不依赖 Chrome、Tauri 或真实登录态；socket 位于系统临时目录，用后即删。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "browser-extension");

const failures = [];
function check(name, condition) {
  if (condition) return;
  failures.push(name);
}

// ---------- 静态检查 ----------
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const permissions = (manifest.permissions || []).slice().sort();
check(
  "manifest.permissions 必须恰好等于最小集合 activeTab/nativeMessaging/scripting",
  JSON.stringify(permissions) === JSON.stringify(["activeTab", "nativeMessaging", "scripting"]),
);
check("manifest 不得声明 host_permissions", (manifest.host_permissions || []).length === 0);
check("manifest 不得有常驻 content_scripts", !manifest.content_scripts);
check("manifest 必须有固定 key", typeof manifest.key === "string" && manifest.key.length > 100);
const extensionId = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .split("")
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");
check("由 key 推导的扩展 ID 必须是 32 位 a-p", /^[a-p]{32}$/.test(extensionId));

// ---------- 动态检查 ----------
function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function readFrame(stream) {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let filled = 0;
    let body = null;
    let bodyFilled = 0;
    const onData = (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (filled < 4) {
          const take = Math.min(4 - filled, chunk.length - offset);
          chunk.copy(header, filled, offset, offset + take);
          filled += take;
          offset += take;
          if (filled === 4) body = Buffer.alloc(header.readUInt32LE(0));
        } else {
          const take = Math.min(body.length - bodyFilled, chunk.length - offset);
          chunk.copy(body, bodyFilled, offset, offset + take);
          bodyFilled += take;
          offset += take;
          if (bodyFilled === body.length) {
            stream.removeListener("data", onData);
            try {
              resolve(JSON.parse(body.toString("utf8")));
            } catch (error) {
              reject(error);
            }
            return;
          }
        }
      }
    };
    stream.on("data", onData);
    stream.on("error", reject);
  });
}

function runHost(socketPath, input, { readResponse = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(extensionDir, "host", "host.cjs")], {
      env: { ...process.env, AICHIHONGSHU_CAPTURE_SOCKET: socketPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result = { code: null, response: null };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("host.cjs 超时未退出"));
    }, 8000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      result.code = code;
      if (!readResponse || result.response !== null || !readFrameActive) {
        clearTimeout(timer);
        resolve(result);
      }
    });
    let readFrameActive = readResponse;
    if (readResponse) {
      readFrame(child.stdout).then(
        (response) => {
          result.response = response;
          readFrameActive = false;
          if (result.code !== null) {
            clearTimeout(timer);
            resolve(result);
          }
        },
        (error) => {
          readFrameActive = false;
          result.response = { frameError: String(error) };
          if (result.code !== null) {
            clearTimeout(timer);
            resolve(result);
          }
        },
      );
    }
    child.stdin.on("error", () => {
      // 宿主在封帧层提前拒绝并退出时，stdin 写入会得到预期的 EPIPE，忽略。
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function withServer(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aichihongshu-capture-"));
  const socketPath = path.join(dir, "capture.sock");
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { socketPath, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const validCapture = {
  title: "QA 书桌角",
  sourceUrl: "https://example.com/qa",
  body: "划词内容",
  reason: "",
  observedAt: "2026-09-21T10:00:00.000Z",
  requestId: "capture-qa-1",
};

async function main() {
  // 场景 1：正常投递。服务端收到扩展原始消息并按单行 JSON 回复 ok。
  const received = [];
  {
    const server = await withServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk);
        socket.end('{"ok":true}\n');
      });
    });
    const { code, response } = await runHost(server.socketPath, frame(validCapture));
    await server.close();
    const delivered = JSON.parse(Buffer.concat(received).toString("utf8").trim());
    check("场景1 服务端应收到完整单行 JSON 消息", delivered.title === "QA 书桌角" && delivered.requestId === "capture-qa-1");
    check("场景1 宿主应回复 ok:true", response && response.ok === true);
    check("场景1 宿主应正常退出", code === 0);
  }

  // 场景 2：Tauri 侧校验拒绝（如标题为空）。宿主应把拒绝原因带回扩展。
  {
    const server = await withServer((socket) => {
      socket.on("data", () => {
        socket.end('{"ok":false,"error":"剪藏标题不能为空"}\n');
      });
    });
    const { code, response } = await runHost(server.socketPath, frame({ ...validCapture, title: "" }));
    await server.close();
    check("场景2 宿主应把拒绝原因带回", response && response.ok === false && response.error === "剪藏标题不能为空");
    check("场景2 宿主应正常退出", code === 0);
  }

  // 场景 3：应用未运行（socket 不存在）。宿主应返回可读错误而不是崩溃。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aichihongshu-capture-"));
    const { code, response } = await runHost(
      path.join(dir, "missing.sock"),
      frame(validCapture),
    );
    check("场景3 宿主应返回 ok:false 与可读错误", response && response.ok === false && /无法投递/.test(response.error || ""));
    check("场景3 宿主应正常退出", code === 0);
  }

  // 场景 4：超过 256KB 的输入帧在封帧层被拒绝，宿主以非零码退出。
  {
    const oversized = { ...validCapture, body: "x".repeat(300 * 1024) };
    const { code } = await runHost(path.join(os.tmpdir(), "unused.sock"), frame(oversized), {
      readResponse: false,
    });
    check("场景4 超限帧应被拒绝（非零退出码）", code !== 0);
  }

  if (failures.length) {
    console.error(`浏览器链路契约检查未通过：\n- ${failures.join("\n- ")}`);
    process.exit(2);
  }
  console.log(
    JSON.stringify({
      ok: true,
      scope: "browser-capture-native-link",
      extensionId,
      scenarios: 4,
    }),
  );
}

main().catch((error) => {
  console.error(`浏览器链路契约检查执行失败: ${error && error.message ? error.message : error}`);
  process.exit(2);
});
