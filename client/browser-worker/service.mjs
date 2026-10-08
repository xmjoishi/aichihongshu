import { randomUUID } from "node:crypto";
import { open, lstat, mkdir, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import {
  MAX_PROFILE_NOTES,
  readProfilePage,
  sanitizeProfileSnapshot,
  validateProfileUrl,
} from "./profile-capture.mjs";
import {
  MAX_SEARCH_NOTES,
  readSearchPage,
  sanitizeSearchSnapshot,
  validateSearchUrl,
} from "./search-capture.mjs";

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 64 * 1024;
// Largest current legal search envelope is 717,223 UTF-8 bytes including LF;
// profile payloads are capped at 60 KiB and all other response variants are smaller.
export const MAX_RESPONSE_LINE_BYTES = 768 * 1024;
export const MAX_ACCOUNT_ID = Number.MAX_SAFE_INTEGER;
export const DEFAULT_LOGIN_URL = "https://creator.xiaohongshu.com/new/home";

const MAX_URL_LENGTH = 2_000;
const XHS_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com", "creator.xiaohongshu.com"]);

export class WorkerRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkerRequestError";
    this.code = code;
  }
}

function accountDirectoryId(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACCOUNT_ID) {
    throw new WorkerRequestError("INVALID_ACCOUNT_ID", "accountId 必须是正整数");
  }
  return `account-${value}`;
}

export function validateBrowserUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new WorkerRequestError("INVALID_URL", "浏览器 URL 无效或超过长度限制");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WorkerRequestError("INVALID_URL", "浏览器 URL 格式无效");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WorkerRequestError("INVALID_URL", "只支持 HTTP 或 HTTPS 页面");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const localFixture = url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
  if (!XHS_HOSTS.has(host) && !localFixture) {
    throw new WorkerRequestError("URL_NOT_ALLOWED", "浏览器 worker 仅打开小红书页面或本机 QA fixture");
  }
  if (url.username || url.password) {
    throw new WorkerRequestError("INVALID_URL", "URL 不得包含账号凭据");
  }
  return url.toString();
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
      throw new WorkerRequestError("RUNTIME_MISSING", "缺少随应用交付的 Playwright 浏览器 runtime");
    }
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class BrowserWorkerService {
  #dataRoot;
  #loadPlaywright;
  #sessions = new Map();
  #tasks = new Map();

  constructor({ dataRoot, loadPlaywright: load = loadPlaywright }) {
    if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) {
      throw new TypeError("dataRoot 必须是绝对路径");
    }
    this.#dataRoot = path.resolve(dataRoot);
    this.#loadPlaywright = load;
  }

  async handle(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new WorkerRequestError("INVALID_REQUEST", "请求必须是 JSON 对象");
    }
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      throw new WorkerRequestError("PROTOCOL_MISMATCH", `只支持协议版本 ${PROTOCOL_VERSION}`);
    }
    if (typeof request.requestId !== "string" || !request.requestId.trim() || request.requestId.length > 128) {
      throw new WorkerRequestError("INVALID_REQUEST_ID", "requestId 必须是 1–128 字符的字符串");
    }

    switch (request.action) {
      case "status":
        return this.#status(request.accountId);
      case "open-session":
        return this.#openSession(request.accountId, request.url ?? DEFAULT_LOGIN_URL);
      case "open-url":
        return this.#openUrl(request.accountId, request.url, request.requestId);
      case "collect-profile":
        return this.#collectProfile(request.accountId, request.url, request.requestId);
      case "search-notes":
        return this.#searchNotes(request.accountId, request.url, request.requestId);
      case "cancel":
        return this.#cancel(request.targetRequestId);
      case "close-session":
        return this.#closeSession(request.accountId);
      case "clear-session":
        return this.#clearSession(request.accountId);
      case "shutdown":
        await this.closeAll();
        return { status: "closed" };
      default:
        throw new WorkerRequestError("UNKNOWN_ACTION", "未知的浏览器 worker 操作");
    }
  }

  async #accountDirectory(accountId) {
    const directory = path.join(this.#dataRoot, accountDirectoryId(accountId));
    await mkdir(this.#dataRoot, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const rootReal = await realpath(this.#dataRoot);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new WorkerRequestError("UNSAFE_SESSION_PATH", "账号会话目录必须是本地受管目录");
    }
    const directoryReal = await realpath(directory);
    if (path.dirname(directoryReal) !== rootReal) {
      throw new WorkerRequestError("UNSAFE_SESSION_PATH", "账号会话目录超出应用数据目录");
    }
    return directoryReal;
  }

  async #acquireLock(accountId) {
    const directory = await this.#accountDirectory(accountId);
    const lockPath = path.join(directory, ".browser-worker.lock");
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
        await handle.close();
        return { directory, lockPath, token };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let owner;
        try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { owner = null; }
        if (owner && isProcessAlive(owner.pid)) {
          throw new WorkerRequestError("SESSION_LOCKED", "此账号的独立浏览器会话已由另一个 worker 使用");
        }
        try { await unlink(lockPath); } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
      }
    }
    throw new WorkerRequestError("SESSION_LOCKED", "无法取得账号浏览器会话锁");
  }

  async #releaseLock(lock) {
    try {
      const owner = JSON.parse(await readFile(lock.lockPath, "utf8"));
      if (owner.token === lock.token) await unlink(lock.lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async #status(accountId) {
    accountDirectoryId(accountId);
    const session = this.#sessions.get(accountId);
    return { status: session ? "running" : "stopped", accountId };
  }

  async #openSession(accountId, inputUrl) {
    accountDirectoryId(accountId);
    const url = validateBrowserUrl(inputUrl);
    const existing = this.#sessions.get(accountId);
    if (existing) return { status: "running", accountId, url };

    const lock = await this.#acquireLock(accountId);
    let context;
    try {
      const { chromium } = await this.#loadPlaywright();
      context = await chromium.launchPersistentContext(lock.directory, {
        headless: false,
        locale: "zh-CN",
        viewport: { width: 1280, height: 900 },
      });
      const session = { accountId, context, lock };
      this.#sessions.set(accountId, session);
      context.once?.("close", () => { void this.#forgetSession(accountId, session); });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { status: "launched", accountId, url };
    } catch (error) {
      if (context) {
        try { await context.close(); } catch { /* preserve launch error */ }
      }
      await this.#forgetSession(accountId, { context, lock });
      if (error instanceof WorkerRequestError) throw error;
      if (/executable.*(?:does not|doesn't) exist|browser.*not found|please run.*install/i.test(String(error?.message))) {
        throw new WorkerRequestError("BROWSER_MISSING", "找不到随应用交付的 Playwright 浏览器");
      }
      throw new WorkerRequestError("BROWSER_LAUNCH_FAILED", String(error?.message || "浏览器启动失败").slice(0, 1_000));
    }
  }

  async #openUrl(accountId, inputUrl, requestId) {
    accountDirectoryId(accountId);
    const url = validateBrowserUrl(inputUrl);
    const session = this.#sessions.get(accountId);
    if (!session) throw new WorkerRequestError("SESSION_NOT_RUNNING", "此账号的浏览器会话尚未启动");
    if (this.#tasks.has(requestId)) {
      throw new WorkerRequestError("DUPLICATE_REQUEST_ID", "正在运行的浏览器任务已使用此 requestId");
    }
    const page = await session.context.newPage();
    const task = { accountId, page, cancelled: false };
    this.#tasks.set(requestId, task);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (task.cancelled) throw new WorkerRequestError("CANCELLED", "浏览器任务已取消");
    } catch (error) {
      try { await page.close(); } catch { /* ignore cleanup failure */ }
      if (task.cancelled) throw new WorkerRequestError("CANCELLED", "浏览器任务已取消");
      throw new WorkerRequestError("PAGE_NAVIGATION_FAILED", String(error?.message || "页面打开失败").slice(0, 1_000));
    } finally {
      if (this.#tasks.get(requestId) === task) this.#tasks.delete(requestId);
    }
    return { status: "opened", accountId, url };
  }

  async #collectProfile(accountId, inputUrl, requestId) {
    accountDirectoryId(accountId);
    let target;
    try {
      target = validateProfileUrl(inputUrl);
    } catch (error) {
      throw new WorkerRequestError("INVALID_PROFILE_URL", String(error?.message || "主页 URL 无效"));
    }
    const session = this.#sessions.get(accountId);
    if (!session) throw new WorkerRequestError("SESSION_NOT_RUNNING", "请先打开此账号的独立浏览器并完成登录");
    if (this.#tasks.has(requestId)) {
      throw new WorkerRequestError("DUPLICATE_REQUEST_ID", "正在运行的浏览器任务已使用此 requestId");
    }
    const page = await session.context.newPage();
    const task = { accountId, page, cancelled: false };
    this.#tasks.set(requestId, task);
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (task.cancelled) throw new WorkerRequestError("CANCELLED", "主页采集已取消");
      const result = await page.evaluate(readProfilePage, { maxNotes: MAX_PROFILE_NOTES });
      if (task.cancelled) throw new WorkerRequestError("CANCELLED", "主页采集已取消");
      return sanitizeProfileSnapshot(result, target.profileId);
    } catch (error) {
      if (task.cancelled || error instanceof WorkerRequestError) {
        if (error instanceof WorkerRequestError) throw error;
        throw new WorkerRequestError("CANCELLED", "主页采集已取消");
      }
      throw new WorkerRequestError("PROFILE_CAPTURE_FAILED", String(error?.message || "主页采集失败").slice(0, 1_000));
    } finally {
      if (this.#tasks.get(requestId) === task) this.#tasks.delete(requestId);
      try { await page.close(); } catch { /* profile task pages never outlive their request */ }
    }
  }

  async #searchNotes(accountId, inputUrl, requestId) {
    accountDirectoryId(accountId);
    let target;
    try {
      target = validateSearchUrl(inputUrl);
    } catch (error) {
      throw new WorkerRequestError("INVALID_SEARCH_URL", String(error?.message || "搜索 URL 无效"));
    }
    const session = this.#sessions.get(accountId);
    if (!session) throw new WorkerRequestError("SESSION_NOT_RUNNING", "请先打开此账号的独立浏览器并完成登录");
    if (this.#tasks.has(requestId)) {
      throw new WorkerRequestError("DUPLICATE_REQUEST_ID", "正在运行的浏览器任务已使用此 requestId");
    }
    const page = await session.context.newPage();
    const task = { accountId, page, cancelled: false };
    this.#tasks.set(requestId, task);
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout?.(1_000);
      if (task.cancelled) throw new WorkerRequestError("CANCELLED", "搜索采集已取消");
      let result = { state: "empty", items: [] };
      const collected = new Map();
      for (let scroll = 0; scroll <= 4; scroll += 1) {
        if (task.cancelled) throw new WorkerRequestError("CANCELLED", "搜索采集已取消");
        result = await page.evaluate(readSearchPage, { maxNotes: target.count });
        if (result?.state === "login-required" || result?.state === "verification-required") break;
        for (const item of Array.isArray(result?.items) ? result.items : []) {
          if (typeof item?.note_url === "string" && !collected.has(item.note_url)) collected.set(item.note_url, item);
          if (collected.size >= target.count) break;
        }
        if (collected.size >= target.count || scroll === 4) break;
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout?.(650);
      }
      if (result?.state === "login-required" || result?.state === "verification-required") {
        return sanitizeSearchSnapshot(result, target.count);
      }
      return sanitizeSearchSnapshot({ state: "complete", items: [...collected.values()] }, Math.min(target.count, MAX_SEARCH_NOTES));
    } catch (error) {
      if (task.cancelled || error instanceof WorkerRequestError) {
        if (error instanceof WorkerRequestError) throw error;
        throw new WorkerRequestError("CANCELLED", "搜索采集已取消");
      }
      throw new WorkerRequestError("SEARCH_CAPTURE_FAILED", String(error?.message || "搜索采集失败").slice(0, 1_000));
    } finally {
      if (this.#tasks.get(requestId) === task) this.#tasks.delete(requestId);
      try { await page.close(); } catch { /* search task pages never outlive their request */ }
    }
  }

  async #cancel(targetRequestId) {
    if (typeof targetRequestId !== "string" || !targetRequestId.trim() || targetRequestId.length > 128) {
      throw new WorkerRequestError("INVALID_REQUEST_ID", "targetRequestId 必须是 1–128 字符的字符串");
    }
    const task = this.#tasks.get(targetRequestId);
    if (!task) return { status: "not_found", targetRequestId };
    task.cancelled = true;
    try { await task.page.close(); } catch { /* closing the page is the cancellation signal */ }
    return { status: "cancelled", targetRequestId, accountId: task.accountId };
  }

  async #closeSession(accountId) {
    accountDirectoryId(accountId);
    const session = this.#sessions.get(accountId);
    if (!session) return { status: "stopped", accountId };
    for (const task of this.#tasks.values()) {
      if (task.accountId === accountId) {
        task.cancelled = true;
        try { await task.page.close(); } catch { /* context close will finish cleanup */ }
      }
    }
    try {
      await session.context.close();
    } finally {
      await this.#forgetSession(accountId, session);
    }
    return { status: "closed", accountId };
  }

  async #clearSession(accountId) {
    accountDirectoryId(accountId);
    if (this.#sessions.has(accountId)) {
      throw new WorkerRequestError("SESSION_OPEN", "请先关闭此账号的浏览器，再清除其独立登录态");
    }
    const lock = await this.#acquireLock(accountId);
    try {
      const entries = await readdir(lock.directory);
      await Promise.all(entries
        .filter((entry) => entry !== path.basename(lock.lockPath))
        .map((entry) => rm(path.join(lock.directory, entry), { recursive: true, force: true })));
    } finally {
      await this.#releaseLock(lock);
    }
    return { status: "cleared", accountId };
  }

  async #forgetSession(accountId, session) {
    if (this.#sessions.get(accountId) === session) this.#sessions.delete(accountId);
    await this.#releaseLock(session.lock);
  }

  async closeAll() {
    const sessions = [...this.#sessions.values()];
    for (const task of this.#tasks.values()) {
      task.cancelled = true;
      try { await task.page.close(); } catch { /* context close will finish cleanup */ }
    }
    const results = await Promise.allSettled(sessions.map(async (session) => {
      try { await session.context.close(); } finally {
        await this.#forgetSession(session.accountId, session);
      }
    }));
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
  }
}

export function responseFor(request, result) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "response",
    requestId: request.requestId,
    ok: true,
    result,
  };
}

export function errorResponse(request, error) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "response",
    requestId: typeof request?.requestId === "string" ? request.requestId : null,
    ok: false,
    error: {
      code: error instanceof WorkerRequestError ? error.code : "WORKER_ERROR",
      message: String(error?.message || "浏览器 worker 发生未知错误").slice(0, 1_000),
    },
  };
}
