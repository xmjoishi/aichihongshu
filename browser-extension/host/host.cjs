#!/usr/bin/env node
// 爱吃红薯原生宿主（N12 最小原型）。
// 链路：Chrome 扩展 →（Native Messaging stdio 长度前缀帧）→ 本脚本
//      →（本机 owner-only Unix socket，单行 JSON）→ Tauri Rust 回传模块。
// 本脚本只做封帧与转发，不做业务判断；校验、账号盖章、入库在 Tauri 侧完成。
"use strict";

const net = require("node:net");
const path = require("node:path");

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SOCKET_TIMEOUT_MS = 3000;

function socketPath() {
  const override = process.env.AICHIHONGSHU_CAPTURE_SOCKET;
  if (typeof override === "string" && override.trim()) return override.trim();
  const home = process.env.HOME || ".";
  return path.join(home, ".aichihongshu", "browser-capture.sock");
}

// 读取 Chrome Native Messaging 一帧：4 字节小端长度 + JSON 字节。
function readNativeMessage(stream) {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerFilled = 0;
    let body = null;
    let bodyFilled = 0;
    const onData = (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (headerFilled < 4) {
          const take = Math.min(4 - headerFilled, chunk.length - offset);
          chunk.copy(header, headerFilled, offset, offset + take);
          headerFilled += take;
          offset += take;
          if (headerFilled === 4) {
            const length = header.readUInt32LE(0);
            if (length === 0 || length > MAX_MESSAGE_BYTES) {
              stream.removeListener("data", onData);
              reject(new Error(`剪藏消息长度无效: ${length}`));
              return;
            }
            body = Buffer.alloc(length);
          }
        } else {
          const take = Math.min(body.length - bodyFilled, chunk.length - offset);
          chunk.copy(body, bodyFilled, offset, offset + take);
          bodyFilled += take;
          offset += take;
          if (bodyFilled === body.length) {
            stream.removeListener("data", onData);
            resolve(body);
            return;
          }
        }
      }
    };
    stream.on("data", onData);
    stream.on("error", (error) => {
      stream.removeListener("data", onData);
      reject(error);
    });
  });
}

function writeNativeMessage(stream, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  stream.write(Buffer.concat([header, payload]));
}

// 半关闭投递：写入一行 JSON 后 FIN，仍可接收单行响应。
function deliver(target, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target);
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.on("connect", () => {
      socket.end(`${JSON.stringify(message)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES) {
        fail(new Error("回传响应过大"));
        return;
      }
      const text = buffer.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        try {
          const response = JSON.parse(text.slice(0, newline));
          socket.end();
          resolve(response);
        } catch (error) {
          fail(new Error("回传响应不是有效 JSON"));
        }
      }
    });
    socket.on("timeout", () => fail(new Error("连接爱吃红薯超时")));
    socket.on("error", (error) => fail(error));
  });
}

async function main() {
  // 排障日志：Chrome 启动宿主时会带上 chrome-extension:// 协议参数。
  try {
    const fs = require("node:fs");
    const os = require("node:os");
    const logPath = path.join(os.homedir(), ".aichihongshu", "host-debug.log");
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] start argv=${JSON.stringify(process.argv)} pid=${process.pid}\n`,
    );
  } catch {}
  const raw = await readNativeMessage(process.stdin);
  try {
    const fs = require("node:fs");
    const os = require("node:os");
    const logPath = path.join(os.homedir(), ".aichihongshu", "host-debug.log");
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] got ${raw.length} bytes: ${raw.toString("utf8").slice(0, 200)}\n`,
    );
  } catch {}
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    writeNativeMessage(process.stdout, { ok: false, error: "剪藏消息不是有效 JSON" });
    return;
  }
  try {
    const response = await deliver(socketPath(), message);
    writeNativeMessage(
      process.stdout,
      response && typeof response === "object" ? response : { ok: false, error: "回传响应无效" },
    );
  } catch (error) {
    writeNativeMessage(process.stdout, {
      ok: false,
      error: `无法投递到爱吃红薯（应用未运行或链路未就绪）：${error && error.message ? error.message : error}`,
    });
  }
}

main().catch(() => {
  process.exit(1);
});
