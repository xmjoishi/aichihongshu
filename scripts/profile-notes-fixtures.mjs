import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(process.cwd(), "browser-extension/profile-notes.js"), "utf8");

function runProfileNotes({ count = 3, scrollHeight = 900, bodyText = "", pathname = "/user/profile/creator-1" } = {}) {
  const links = Array.from({ length: count }, (_, index) => {
    const card = {
      querySelector(selector) {
        if (selector.includes("content")) return { innerText: `主页正文 #家居 #收纳 ${index}` };
        if (selector.includes("title") || selector.includes("desc")) return { innerText: `主页标题 ${index}` };
        if (selector.includes("like")) return { innerText: index === 0 ? "1.2万赞" : `${index * 10}赞` };
        if (selector.includes("comment")) return { innerText: `${index + 1}评论` };
        if (selector.includes("collect")) return { innerText: `${index + 2}收藏` };
        if (selector.startsWith("time[datetime]")) return { getAttribute: () => "2026-09-20T10:00:00Z", innerText: "" };
        return null;
      },
    };
    return {
      href: `https://www.xiaohongshu.com/explore/note-${index}${index === 0 ? "?xsec_token=private" : ""}`,
      getAttribute: (name) => name === "href" ? `/explore/note-${index}` : null,
      closest: () => card,
      querySelector: (...args) => card.querySelector(...args),
    };
  });
  const scope = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes("/explore/") ? links : [],
  };
  const scrollRoot = { scrollHeight };
  const win = {
    scrollX: 9,
    scrollY: 123,
    innerHeight: 600,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
  };
  const document = {
    scrollingElement: scrollRoot,
    documentElement: scrollRoot,
    body: { innerText: bodyText, textContent: bodyText, scrollHeight },
    querySelector: (selector) => selector === "main" ? scope : scope,
  };
  const context = {
    window: win,
    document,
    location: { hostname: "www.xiaohongshu.com", pathname, href: `https://www.xiaohongshu.com${pathname}` },
    URL,
    setTimeout(callback) { callback(); return 0; },
  };
  const result = vm.runInNewContext(source, context, { filename: "profile-notes.js" });
  return Promise.resolve(result).then((value) => ({ value, win }));
}

const { value: complete, win: completeWindow } = await runProfileNotes({ count: 3, scrollHeight: 900 });
assert.equal(complete.state, "complete");
assert.equal(complete.notes.length, 3);
assert.equal(complete.notes[0].noteUrl, "https://www.xiaohongshu.com/explore/note-0");
assert.equal(complete.notes[0].likes, 12_000);
assert.deepEqual(Array.from(complete.notes[0].tags), ["家居", "收纳"]);
assert.equal(completeWindow.scrollY, 123, "collector restores the page's original scroll position");

const { value: capped } = await runProfileNotes({ count: 35, scrollHeight: 900 });
assert.equal(capped.state, "partial", "reaching the 30-note safety cap does not claim full coverage");
assert.equal(capped.notes.length, 30);

const { value: partial } = await runProfileNotes({ count: 2, scrollHeight: 20_000 });
assert.equal(partial.state, "partial", "bounded scrolling reports incomplete profile lists honestly");
assert.equal(partial.notes.length, 2);

const { value: verification } = await runProfileNotes({ bodyText: "安全验证，请输入验证码" });
assert.equal(verification.state, "verification-required");
assert.deepEqual(Array.from(verification.notes), []);

const { value: login } = await runProfileNotes({ pathname: "/login", bodyText: "登录后查看" });
assert.equal(login.state, "login-required");

console.log(JSON.stringify({
  ok: true,
  scenarios: ["30-note cap", "interaction and tag parsing", "scroll restoration", "partial-load reporting", "verification gate", "login gate"],
}));
