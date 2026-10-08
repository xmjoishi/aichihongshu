import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { BrowserWorkerService, MAX_RESPONSE_LINE_BYTES, PROTOCOL_VERSION, WorkerRequestError, errorResponse, responseFor, validateBrowserUrl } from "../service.mjs";
import { sanitizeProfileSnapshot, validateProfileUrl } from "../profile-capture.mjs";
import { readSearchPage, sanitizeSearchSnapshot, validateSearchUrl } from "../search-capture.mjs";

function fakePlaywright({ failLaunch = false, profileResult = null, searchResult = null } = {}) {
  const contexts = [];
  return {
    contexts,
    load: async () => ({
      chromium: {
        launchPersistentContext: async (userDataDir, options) => {
          if (failLaunch) throw new Error("Executable doesn't exist at fake/chromium");
          const pages = [];
          const listeners = new Map();
          const context = {
            userDataDir,
            options,
            createdPages: pages,
            pages: () => pages,
            newPage: async () => {
              const page = {
                url: null,
                goto: async (url) => { page.url = url; },
                evaluate: async () => searchResult ?? profileResult,
                waitForTimeout: async () => {},
                close: async () => { page.closed = true; },
              };
              pages.push(page);
              return page;
            },
            once: (event, callback) => listeners.set(event, callback),
            close: async () => {
              context.closed = true;
              listeners.get("close")?.();
            },
          };
          contexts.push(context);
          return context;
        },
      },
    }),
  };
}

async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aichihongshu-browser-worker-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const playwright = fakePlaywright(options);
  const service = new BrowserWorkerService({ dataRoot, loadPlaywright: playwright.load });
  return { dataRoot, service, contexts: playwright.contexts };
}

function request(action, accountId = 1, fields = {}) {
  return { protocolVersion: PROTOCOL_VERSION, requestId: "test-1", action, accountId, ...fields };
}

test("isolates persistent sessions by account and reuses an open session", async (t) => {
  const { dataRoot, service, contexts } = await fixture(t);
  const one = await service.handle(request("open-session", 1));
  const repeated = await service.handle(request("open-session", 1));
  const two = await service.handle(request("open-session", 2));
  assert.equal(one.status, "launched");
  assert.equal(repeated.status, "running");
  assert.equal(two.status, "launched");
  assert.notEqual(contexts[0].userDataDir, contexts[1].userDataDir);
  assert.equal(path.dirname(contexts[0].userDataDir), await realpath(dataRoot));
  assert.equal(contexts[0].options.headless, false);
  await service.closeAll();
  assert.equal((await service.handle(request("status", 1))).status, "stopped");
});

test("rejects untrusted URLs and does not launch", async (t) => {
  const { service, contexts } = await fixture(t);
  await assert.rejects(() => service.handle(request("open-session", 1, { url: "file:///etc/passwd" })),
    (error) => error.code === "INVALID_URL");
  await assert.rejects(() => service.handle(request("open-session", 1, { url: "https://example.com/" })),
    (error) => error.code === "URL_NOT_ALLOWED");
  assert.equal(contexts.length, 0);
  assert.equal(validateBrowserUrl("http://127.0.0.1:4321/fixture"), "http://127.0.0.1:4321/fixture");
});

test("validates profile targets and strips tracking parameters", () => {
  assert.deepEqual(validateProfileUrl("https://www.xiaohongshu.com/user/profile/profile_1?xsec_token=secret#top"), {
    url: "https://www.xiaohongshu.com/user/profile/profile_1",
    profileId: "profile_1",
  });
  assert.throws(() => validateProfileUrl("https://xiaohongshu.com/explore/note-1"), /主页链接/);
  assert.throws(() => validateProfileUrl("https://xiaohongshu.com.evil.example/user/profile/abc"), /HTTPS 主页/);
  assert.throws(() => validateProfileUrl("file:///user/profile/abc"), /HTTPS 主页/);
});

test("sanitizes profile data, caps notes, deduplicates and removes note tokens", () => {
  const notes = Array.from({ length: 35 }, (_, index) => ({
    noteUrl: "https://www.xiaohongshu.com/explore/note-" + index + "?xsec_token=secret",
    title: "Title " + index,
    body: "body",
    likes: index,
    comments: null,
    collects: 4,
    tags: ["tag", "tag"],
  }));
  notes.push({ ...notes[0], title: "duplicate" });
  const result = sanitizeProfileSnapshot({
    state: "partial",
    profile: {
      profileId: "creator-1",
      displayName: "Creator",
      avatarUrl: "javascript:alert(1)",
      followers: 12_300,
      tags: ["home", "home"],
    },
    notes,
  }, "creator-1");
  assert.equal(result.state, "partial");
  assert.equal(result.notes.length, 30);
  assert.equal(result.notes[0].noteUrl, "https://www.xiaohongshu.com/explore/note-0");
  assert.equal(result.profile.avatarUrl, null);
  assert.deepEqual(result.profile.tags, ["home"]);
  assert.throws(() => sanitizeProfileSnapshot({
    state: "complete",
    profile: { profileId: "different" },
    notes: [],
  }, "creator-1"), /不匹配/);
});

test("collects a bounded profile in the selected visible session and closes its task tab", async (t) => {
  const { service, contexts } = await fixture(t, {
    profileResult: {
      state: "complete",
      profile: {
        profileId: "creator-1",
        displayName: "Creator",
        followers: 100,
        follows: 20,
        totalNotes: 3,
      },
      notes: [{
        noteUrl: "https://www.xiaohongshu.com/explore/note-1",
        title: "Note one",
        body: "body",
        likes: 10,
        comments: 2,
        collects: 3,
        tags: [],
      }],
    },
  });
  await service.handle(request("open-session", 1));
  const result = await service.handle(request("collect-profile", 1, {
    requestId: "profile-capture-1",
    url: "https://www.xiaohongshu.com/user/profile/creator-1?token=opaque",
  }));
  assert.equal(result.state, "complete");
  assert.equal(result.profile.displayName, "Creator");
  assert.equal(result.notes.length, 1);
  assert.equal(contexts[0].createdPages.at(-1).closed, true);
  await service.closeAll();
});

test("profile capture reports login and verification states without saving notes", async (t) => {
  for (const state of ["login-required", "verification-required"]) {
    const { service } = await fixture(t, { profileResult: { state } });
    await service.handle(request("open-session", 1));
    const result = await service.handle(request("collect-profile", 1, {
      requestId: "profile-" + state,
      url: "https://www.xiaohongshu.com/user/profile/creator-1",
    }));
    assert.deepEqual(result, { state, profile: null, notes: [] });
    await service.closeAll();
  }
});

test("validates bounded search targets and strips untrusted query parameters", () => {
  assert.deepEqual(validateSearchUrl("https://www.xiaohongshu.com/search_result?keyword=%E5%AE%B6%E5%B1%85&max_count=20"), {
    url: "https://www.xiaohongshu.com/search_result?keyword=%E5%AE%B6%E5%B1%85",
    keyword: "家居",
    count: 20,
  });
  assert.throws(() => validateSearchUrl("https://example.com/search_result?keyword=x&max_count=1"), /HTTPS 页面/);
  assert.throws(() => validateSearchUrl("https://www.xiaohongshu.com/search_result?keyword=x&max_count=500"), /1 到 50/);
  assert.throws(() => validateSearchUrl("https://www.xiaohongshu.com/search_result?keyword=x&max_count=1&xsec_token=secret"), /参数无效/);
  const snapshot = sanitizeSearchSnapshot({ state: "complete", items: [
    { note_id: "note-1", note_url: "https://www.xiaohongshu.com/explore/note-1?xsec_token=secret", title: " note ", liked_count: "1.2万" },
    { note_id: "note-1", note_url: "https://www.xiaohongshu.com/explore/note-1", title: "duplicate" },
    { note_id: "x", note_url: "https://evil.example/explore/x", title: "unsafe" },
  ] }, 10);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].note_url, "https://www.xiaohongshu.com/explore/note-1");
  assert.equal(snapshot.items[0].liked_count, "1.2万");
});

test("bounds the largest legal 50-note search response across Unicode and JSON escaping", () => {
  const variants = [
    { title: "家居软装".repeat(60), desc: "温馨客厅".repeat(150), user_nickname: "小红薯".repeat(40), tag_list: "空间设计".repeat(60) },
    { title: "😀".repeat(120), desc: "🪴".repeat(300), user_nickname: "🏠".repeat(60), tag_list: "✨".repeat(120) },
    { title: "\u0001".repeat(240), desc: "\u0001".repeat(600), user_nickname: "\u0001".repeat(120), tag_list: "\u0001".repeat(240) },
  ];
  for (const variant of variants) {
    const items = Array.from({ length: 50 }, (_, index) => ({
      // The accepted ID and canonical URL both allow a 128-character ID.
      note_id: `${String(index).padStart(3, "0")}${"A".repeat(125)}`,
      note_url: `https://www.xiaohongshu.com/explore/${String(index).padStart(3, "0")}${"A".repeat(125)}`,
      title: variant.title,
      desc: variant.desc,
      user_nickname: variant.user_nickname,
      liked_count: "\u0001".repeat(40),
      collected_count: "\u0001".repeat(40),
      comment_count: "\u0001".repeat(40),
      tag_list: variant.tag_list,
      image_url: `https://${"\u0001".repeat(992)}`,
    }));
    const snapshot = sanitizeSearchSnapshot({ state: "complete", items }, 50);
    const requestId = variant.title.startsWith("\u0001") ? "\u0001".repeat(128) : "r".repeat(128);
    const encoded = JSON.stringify(responseFor({ requestId }, snapshot));
    assert.equal(snapshot.items.length, 50);
    const responseBytes = Buffer.byteLength(encoded, "utf8") + 1; // worker appends one newline
    assert.ok(responseBytes < MAX_RESPONSE_LINE_BYTES);
    if (variant.title.startsWith("\u0001")) {
      // Exact largest legal wire response: every bounded field uses the
      // maximum JSON-escaped control-character length, including requestId.
      assert.equal(responseBytes, 717_223);
    }
  }
});

test("reads note cards from the rendered search DOM without retaining access tokens", () => {
  const metrics = [
    { className: "like-count", innerText: "1.2万" },
    { className: "collect-count", innerText: "350" },
    { className: "comment-count", innerText: "42" },
  ];
  const tags = [{ innerText: "家居" }, { innerText: "软装" }];
  const card = {
    innerText: "A note about a warm living room",
    querySelector: (selector) => {
      if (selector.includes("title")) return { innerText: "温暖客厅改造" };
      if (selector.includes("desc") || selector.includes("content")) return { innerText: "分享一个客厅方案" };
      if (selector.includes("author") || selector.includes("nickname")) return { innerText: "小红薯" };
      return null;
    },
    querySelectorAll: (selector) => selector.includes("count") || selector.includes("span") ? metrics : tags,
  };
  const anchor = {
    innerText: "温暖客厅改造",
    getAttribute: (name) => name === "href" ? "/explore/note-1?xsec_token=secret" : null,
    closest: () => card,
    parentElement: card,
  };
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  globalThis.document = {
    body: { innerText: "搜索结果" },
    querySelector: () => null,
    querySelectorAll: () => [anchor],
  };
  globalThis.location = {
    href: "https://www.xiaohongshu.com/search_result?keyword=%E5%AE%B6%E5%B1%85",
    origin: "https://www.xiaohongshu.com",
  };
  try {
    const result = readSearchPage({ maxNotes: 10 });
    assert.equal(result.state, "complete");
    assert.deepEqual(result.items[0], {
      note_id: "note-1",
      note_url: "https://www.xiaohongshu.com/explore/note-1",
      title: "温暖客厅改造",
      desc: "分享一个客厅方案",
      user_nickname: "小红薯",
      liked_count: "1.2万",
      collected_count: "350",
      comment_count: "42",
      tag_list: "家居 软装",
      image_url: "",
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test("collects a bounded search in the visible session and closes its task tab", async (t) => {
  const { service, contexts } = await fixture(t, {
    searchResult: { state: "complete", items: [
      { note_id: "note-1", note_url: "https://www.xiaohongshu.com/explore/note-1?token=opaque", title: "A useful note", liked_count: "1.2万" },
      { note_id: "note-2", note_url: "https://www.xiaohongshu.com/explore/note-2", title: "Another note" },
    ] },
  });
  await service.handle(request("open-session", 1));
  const result = await service.handle(request("search-notes", 1, {
    requestId: "search-capture-1",
    url: "https://www.xiaohongshu.com/search_result?keyword=家居&max_count=2",
  }));
  assert.equal(result.state, "complete");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].liked_count, "1.2万");
  assert.equal(contexts[0].createdPages.at(-1).closed, true);
  await service.closeAll();
});

test("search capture reports login and verification states", async (t) => {
  for (const state of ["login-required", "verification-required"]) {
    const { service } = await fixture(t, { searchResult: { state, items: [] } });
    await service.handle(request("open-session", 1));
    const result = await service.handle(request("search-notes", 1, {
      requestId: "search-" + state,
      url: "https://www.xiaohongshu.com/search_result?keyword=home&max_count=3",
    }));
    assert.deepEqual(result, { state, items: [] });
    await service.closeAll();
  }
});

test("clears only the selected account session and refuses to clear while open", async (t) => {
  const { dataRoot, service } = await fixture(t);
  await service.handle(request("open-session", 3));
  await assert.rejects(() => service.handle(request("clear-session", 3)),
    (error) => error.code === "SESSION_OPEN");
  await service.handle(request("close-session", 3));
  const dir = path.join(dataRoot, "account-3");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(dir, "Cookies"), "isolated"));
  await service.handle(request("open-session", 4));
  assert.deepEqual(await service.handle(request("clear-session", 3)), { status: "cleared", accountId: 3 });
  await assert.rejects(() => stat(path.join(dir, "Cookies")), (error) => error.code === "ENOENT");
  assert.equal((await service.handle(request("status", 4))).status, "running");
});

test("distinguishes a missing browser runtime from an installed runtime with a missing browser", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aichihongshu-browser-worker-missing-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const runtimeMissing = new BrowserWorkerService({ dataRoot, loadPlaywright: async () => { throw new WorkerRequestError("RUNTIME_MISSING", "missing"); } });
  await assert.rejects(() => runtimeMissing.handle(request("open-session")), (error) => error.code === "RUNTIME_MISSING");
  const browserMissing = new BrowserWorkerService({ dataRoot, loadPlaywright: async () => ({
    chromium: { launchPersistentContext: async () => { throw new Error("Executable doesn't exist"); } },
  }) });
  await assert.rejects(() => browserMissing.handle(request("open-session")), (error) => error.code === "BROWSER_MISSING");
  const lockPath = path.join(dataRoot, "account-1", ".browser-worker.lock");
  await assert.rejects(() => readFile(lockPath), (error) => error.code === "ENOENT");
});

test("reports process-level session locks and removes stale locks on restart", async (t) => {
  const { dataRoot, service } = await fixture(t);
  await service.handle(request("open-session", 7));
  const secondWorker = new BrowserWorkerService({ dataRoot, loadPlaywright: async () => fakePlaywright().load() });
  await assert.rejects(() => secondWorker.handle(request("open-session", 7)),
    (error) => error.code === "SESSION_LOCKED");
  await service.closeAll();
  await secondWorker.handle(request("open-session", 7));
  await secondWorker.closeAll();

  const staleRoot = await mkdtemp(path.join(os.tmpdir(), "aichihongshu-browser-worker-restart-"));
  t.after(() => rm(staleRoot, { recursive: true, force: true }));
  const staleDirectory = path.join(staleRoot, "account-9");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(staleDirectory));
  await writeFile(path.join(staleDirectory, ".browser-worker.lock"), JSON.stringify({ pid: -1, token: "stale" }));
  const restartedWorker = new BrowserWorkerService({ dataRoot: staleRoot, loadPlaywright: async () => fakePlaywright().load() });
  assert.equal((await restartedWorker.handle(request("open-session", 9))).status, "launched");
  await restartedWorker.closeAll();
});

test("cancels a pending page navigation by closing its page and reports cancellation", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aichihongshu-browser-worker-cancel-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let navigations = 0;
  const contexts = [];
  const service = new BrowserWorkerService({
    dataRoot,
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => {
      const pages = [];
      const listeners = new Map();
      const context = {
        pages: () => pages,
        newPage: async () => {
          let rejectPending;
          const page = {
            goto: async () => {
              navigations += 1;
              if (navigations === 1) return;
              await new Promise((_, reject) => { rejectPending = reject; });
            },
            close: async () => { rejectPending?.(new Error("Target closed")); },
          };
          pages.push(page);
          return page;
        },
        once: (event, callback) => listeners.set(event, callback),
        close: async () => listeners.get("close")?.(),
      };
      contexts.push(context);
      return context;
    } } }),
  });
  await service.handle(request("open-session", 11));
  const opening = service.handle(request("open-url", 11, { requestId: "navigation-1", url: "https://www.xiaohongshu.com/explore/abc" }));
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await service.handle(request("cancel", 11, { targetRequestId: "navigation-1" }));
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(opening, (error) => error.code === "CANCELLED");
  await service.closeAll();
  assert.equal(contexts.length, 1);
});

test("shutdown closes all open accounts and error responses keep versioned JSON shape", async (t) => {
  const { service, contexts } = await fixture(t);
  await service.handle(request("open-session", 1));
  await service.handle(request("open-session", 2));
  assert.deepEqual(await service.handle(request("shutdown")), { status: "closed" });
  assert.ok(contexts.every((context) => context.closed));
  const response = errorResponse({ requestId: "bad" }, new WorkerRequestError("CANCELLED", "cancelled"));
  assert.deepEqual(response, {
    protocolVersion: PROTOCOL_VERSION,
    type: "response",
    requestId: "bad",
    ok: false,
    error: { code: "CANCELLED", message: "cancelled" },
  });
});

test("starts as a versioned JSON-lines child process and cleans up on EOF", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aichihongshu-browser-worker-wire-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const workerPath = new URL("../worker.mjs", import.meta.url);
  const child = spawn(process.execPath, [workerPath.pathname], {
    env: { ...process.env, AICHIHONGSHU_BROWSER_DATA_DIR: dataRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let buffered = "";
  const messages = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      messages.push(JSON.parse(line));
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const nextMessage = async (predicate) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker message timed out")), Math.max(1, deadline - Date.now()));
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    throw new Error("worker message timed out");
  };
  const ready = await nextMessage((message) => message.type === "ready");
  assert.equal(ready.protocolVersion, PROTOCOL_VERSION);
  child.stdin.write(`${JSON.stringify(request("status"))}\n`);
  const status = await nextMessage((message) => message.requestId === "test-1");
  assert.equal(status.ok, true);
  assert.equal(status.result.status, "stopped");
  child.stdin.end();
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
});

test("bounds input lines and stays synchronized after an oversized request", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "aichihongshu-browser-worker-limit-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const workerPath = new URL("../worker.mjs", import.meta.url);
  const child = spawn(process.execPath, [workerPath.pathname], {
    env: { ...process.env, AICHIHONGSHU_BROWSER_DATA_DIR: dataRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let buffered = "";
  const messages = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      messages.push(JSON.parse(line));
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const nextMessage = async (predicate) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker message timed out")), Math.max(1, deadline - Date.now()));
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    throw new Error("worker message timed out");
  };
  await nextMessage((message) => message.type === "ready");
  child.stdin.write(`${"x".repeat(65 * 1024)}\n${JSON.stringify(request("status"))}\n`);
  const oversized = await nextMessage((message) => message.error?.code === "REQUEST_TOO_LARGE");
  assert.equal(oversized.ok, false);
  const status = await nextMessage((message) => message.requestId === "test-1");
  assert.equal(status.result.status, "stopped");
  child.stdin.end();
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
});
