import { BrowserWorkerService, MAX_REQUEST_BYTES, MAX_RESPONSE_LINE_BYTES, PROTOCOL_VERSION, WorkerRequestError, errorResponse, responseFor } from "./service.mjs";

const dataRoot = process.env.AICHIHONGSHU_BROWSER_DATA_DIR;
if (!dataRoot) {
  console.error("AICHIHONGSHU_BROWSER_DATA_DIR is required");
  process.exit(78);
}

const service = new BrowserWorkerService({ dataRoot });
const inFlight = new Set();
let lineParts = [];
let lineLength = 0;
let droppingOversizedLine = false;

function send(payload) {
  const line = JSON.stringify(payload);
  if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_LINE_BYTES) {
    throw new WorkerRequestError("RESPONSE_TOO_LARGE", "浏览器 worker 响应超过 768KB 上限");
  }
  process.stdout.write(`${line}\n`);
}

send({
  protocolVersion: PROTOCOL_VERSION,
  type: "ready",
  worker: "aichihongshu-browser-worker",
  capabilities: ["status", "open-session", "open-url", "collect-profile", "search-notes", "close-session", "clear-session", "cancel", "shutdown"],
});

async function dispatch(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send(errorResponse(null, new WorkerRequestError("INVALID_JSON", "请求不是有效 JSON")));
    return;
  }
  try {
    const result = await service.handle(request);
    send(responseFor(request, result));
  } catch (error) {
    send(errorResponse(request, error));
  }
}

function finishLine() {
  if (droppingOversizedLine) {
    send(errorResponse(null, new WorkerRequestError("REQUEST_TOO_LARGE", "请求超过 64KB 上限")));
  } else {
    const line = Buffer.concat(lineParts, lineLength).toString("utf8");
    if (line.trim()) {
      const task = dispatch(line).catch((error) => {
        console.error(`worker dispatch failed: ${String(error)}`);
      });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
  }
  lineParts = [];
  lineLength = 0;
  droppingOversizedLine = false;
}

process.stdin.on("data", (chunk) => {
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(0x0a, start);
    const end = newline === -1 ? chunk.length : newline;
    const part = chunk.subarray(start, end);
    if (!droppingOversizedLine) {
      lineLength += part.length;
      if (lineLength > MAX_REQUEST_BYTES) {
        droppingOversizedLine = true;
        lineParts = [];
      } else if (part.length) {
        lineParts.push(part);
      }
    }
    if (newline === -1) break;
    finishLine();
    start = newline + 1;
  }
});

process.stdin.on("end", () => {
  if (lineLength || droppingOversizedLine) finishLine();
  void Promise.allSettled([...inFlight]).then(() => service.closeAll()).catch((error) => {
    console.error(`worker cleanup failed: ${String(error)}`);
    process.exitCode = 1;
  });
});

process.on("SIGTERM", () => {
  void service.closeAll().finally(() => process.exit(0));
});
