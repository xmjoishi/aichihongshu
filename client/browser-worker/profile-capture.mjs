export const MAX_PROFILE_NOTES = 30;

export function validateProfileUrl(value) {
  if (typeof value !== "string" || value.length > 2_000) {
    throw new TypeError("主页 URL 无效或超过长度限制");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("主页 URL 格式无效");
  }
  if (url.protocol !== "https:" || !["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname.toLowerCase())) {
    throw new TypeError("主页采集只支持小红书 HTTPS 主页");
  }
  if (url.username || url.password) throw new TypeError("主页 URL 不得包含账号凭据");
  const match = url.pathname.match(/^\/user\/profile\/([A-Za-z0-9_-]{1,128})\/?$/);
  if (!match) throw new TypeError("请提供 /user/profile/{账号ID} 主页链接");
  url.pathname = "/user/profile/" + match[1];
  url.search = "";
  url.hash = "";
  return { url: url.toString(), profileId: match[1] };
}

function sanitizeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) return null;
  return value;
}

function boundedText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function sanitizeProfileSnapshot(value, expectedProfileId) {
  const state = ["complete", "partial", "login-required", "verification-required", "not-profile"].includes(value?.state)
    ? value.state : "partial";
  if (state === "login-required" || state === "verification-required" || state === "not-profile") {
    return { state, profile: null, notes: [] };
  }
  const profile = value?.profile && typeof value.profile === "object" ? value.profile : {};
  if (profile.profileId !== expectedProfileId) throw new TypeError("主页 ID 与请求目标不匹配");
  const notes = [];
  const noteIds = new Set();
  for (const item of Array.isArray(value.notes) ? value.notes.slice(0, MAX_PROFILE_NOTES) : []) {
    if (!item || typeof item !== "object") continue;
    let noteUrl;
    try {
      const url = new URL(item.noteUrl);
      if (url.protocol !== "https:" || !["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname.toLowerCase())) continue;
      const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]{1,128})\/?$/);
      if (!match || noteIds.has(match[1])) continue;
      noteIds.add(match[1]);
      const kind = url.pathname.includes("/discovery/item/") ? "discovery/item" : "explore";
      url.pathname = "/" + kind + "/" + match[1];
      url.search = "";
      url.hash = "";
      noteUrl = url.toString();
    } catch {
      continue;
    }
    const title = boundedText(item.title, 200);
    if (!title) continue;
    notes.push({
      noteUrl,
      title,
      body: boundedText(item.body, 1_200),
      likes: sanitizeCount(item.likes),
      comments: sanitizeCount(item.comments),
      collects: sanitizeCount(item.collects),
      tags: [...new Set((Array.isArray(item.tags) ? item.tags : [])
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim().slice(0, 80))
        .filter(Boolean))].slice(0, 20),
      publishedAt: boundedText(item.publishedAt, 80) || null,
    });
  }
  const result = {
    state,
    profile: {
      profileId: expectedProfileId,
      displayName: boundedText(profile.displayName, 200) || null,
      avatarUrl: safeHttpsUrl(profile.avatarUrl),
      bio: boundedText(profile.bio, 2_000) || null,
      followers: sanitizeCount(profile.followers),
      follows: sanitizeCount(profile.follows),
      totalNotes: sanitizeCount(profile.totalNotes),
      ipLocation: boundedText(profile.ipLocation, 100) || null,
      tags: [...new Set((Array.isArray(profile.tags) ? profile.tags : [])
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim().slice(0, 80))
        .filter(Boolean))].slice(0, 30),
    },
    notes,
  };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 60 * 1024 && result.notes.length) {
    result.notes.pop();
    result.state = "partial";
  }
  return result;
}

// Playwright serializes this function into the visible page. It reads rendered
// content only; it never calls private APIs or clicks through login/challenges.
export async function readProfilePage({ maxNotes = 30 } = {}) {
  const MAX_NOTES = Math.max(1, Math.min(30, Number.isSafeInteger(maxNotes) ? maxNotes : 30));
  const MAX_SCROLLS = 16;
  const WAIT_MS = 350;
  const textOf = (node) => String(node?.innerText || node?.textContent || "")
    .replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const parseCount = (raw) => {
    const match = String(raw || "").replace(/,/g, "")
      .match(/(?<![\d.])(\d+(?:\.\d+)?)\s*(万|億|亿|w|W|k|K)?/u);
    if (!match) return null;
    const unit = (match[2] || "").toLowerCase();
    const multiplier = unit === "万" || unit === "w" ? 10_000
      : unit === "亿" || unit === "億" ? 100_000_000
        : unit === "k" ? 1_000 : 1;
    const count = Math.floor(Number(match[1]) * multiplier);
    return Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000_000 ? count : null;
  };
  const pageUrl = new URL(location.href);
  const host = pageUrl.hostname.toLowerCase();
  const profileMatch = pageUrl.pathname.match(/^\/user\/profile\/([A-Za-z0-9_-]{1,128})\/?$/);
  const bodyText = textOf(document.body);
  if (/验证码|安全验证|访问异常|操作频繁|请求过于频繁/.test(bodyText)) {
    return { state: "verification-required" };
  }
  if (/passport\/login|\/login(?:\/|$)/i.test(pageUrl.pathname) || /登录后查看|登录后获取|请先登录/.test(bodyText)) {
    return { state: "login-required" };
  }
  if (host !== "xiaohongshu.com" && host !== "www.xiaohongshu.com") return { state: "not-profile" };
  if (!profileMatch) return { state: "not-profile" };

  const root = document.querySelector('[class*="user-info"],[class*="userInfo"],[class*="profile-info"],main') || document.body;
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = textOf(node);
      if (value) return value;
    }
    return "";
  };
  const labeled = (label) => {
    const match = bodyText.match(new RegExp(label + "\\s*[:：]?\\s*([\\d,.]+\\s*(?:万|亿|w|k)?)", "i"));
    return match ? parseCount(match[1]) : null;
  };
  const avatar = root.querySelector('img[class*="avatar"],[class*="avatar"] img');
  const name = firstText(['[class*="nickname"]','[class*="user-name"]','[class*="userName"]','h1']);
  const bio = firstText(['[class*="desc"]','[class*="bio"]','[class*="description"]']);
  const ipLocation = firstText(['[class*="ip-location"]','[class*="ipLocation"]','[class*="location"]']);
  const tags = Array.from(root.querySelectorAll('[class*="tag"],[class*="label"]'))
    .map(textOf).filter((item) => item && item.length <= 80).slice(0, 30);
  const profile = {
    profileId: profileMatch[1],
    displayName: name || null,
    avatarUrl: avatar?.currentSrc || avatar?.src || null,
    bio: bio || null,
    followers: labeled("粉丝"),
    follows: labeled("关注"),
    totalNotes: labeled("笔记"),
    ipLocation: ipLocation.replace(/^IP属地[:：]?\s*/, "") || null,
    tags,
  };

  const originalX = window.scrollX || 0;
  const originalY = window.scrollY || 0;
  const scrollRoot = document.scrollingElement || document.documentElement;
  const notes = new Map();
  let stableBottomRounds = 0;
  let lastHeight = -1;
  let state = "partial";
  function readCards() {
    const scope = document.querySelector(
      '[class*="feeds-container"],[class*="note-list"],[class*="noteList"],[class*="user-note"],[class*="userNotes"]',
    ) || document.querySelector("main") || document;
    const anchors = Array.from(scope.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"]'));
    for (const anchor of anchors) {
      if (notes.size >= MAX_NOTES) break;
      let url;
      try { url = new URL(anchor.href || anchor.getAttribute("href"), location.href); } catch { continue; }
      if (!["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname.toLowerCase())
        || url.protocol !== "https:" || url.username || url.password) continue;
      const match = url.pathname.match(/^\/(?:explore\/|discovery\/item\/)([A-Za-z0-9_-]{1,128})/);
      if (!match || notes.has(match[1])) continue;
      const card = anchor.closest?.('[class*="note-item"],[class*="note-card"],[class*="noteItem"],[data-note-id]') || anchor;
      const titleNode = card.querySelector?.('[class*="title"],[class*="desc"]');
      const image = card.querySelector?.("img[alt]");
      const title = (textOf(titleNode) || image?.alt || anchor.getAttribute("aria-label") || textOf(anchor)).slice(0, 200);
      if (!title.trim()) continue;
      const bodyNode = card.querySelector?.('[class*="desc"],[class*="content"]');
      const body = (textOf(bodyNode) || textOf(anchor)).slice(0, 1_200);
      const countIn = (selectors) => {
        for (const selector of selectors) {
          const node = card.querySelector?.(selector);
          const count = parseCount(node?.getAttribute?.("aria-label") || textOf(node));
          if (count !== null) return count;
        }
        return null;
      };
      const timeNode = card.querySelector?.("time[datetime]") || card.querySelector?.('[class*="publish-time"],[class*="time"]');
      notes.set(match[1], {
        noteUrl: url.origin + url.pathname,
        title: title.trim(),
        body,
        likes: countIn(['[class*="like-wrapper"]','[class*="like-count"]','[aria-label*="赞"]']),
        comments: countIn(['[class*="comment-count"]','[aria-label*="评论"]']),
        collects: countIn(['[class*="collect-count"]','[aria-label*="收藏"]']),
        tags: [...new Set(Array.from(body.matchAll(/#([\p{L}\p{N}_-]{1,40})/gu), (item) => item[1]))].slice(0, 20),
        publishedAt: (timeNode?.getAttribute?.("datetime") || textOf(timeNode) || "").slice(0, 80) || null,
      });
    }
  }
  try {
    for (let step = 0; step <= MAX_SCROLLS; step += 1) {
      const currentText = textOf(document.body);
      if (/验证码|安全验证|访问异常|操作频繁|请求过于频繁/.test(currentText)) return { state: "verification-required" };
      if (/登录后查看|登录后获取|请先登录/.test(currentText)) return { state: "login-required" };
      readCards();
      if (notes.size >= MAX_NOTES) {
        state = "complete";
        break;
      }
      const height = Math.max(scrollRoot.scrollHeight || 0, document.body?.scrollHeight || 0);
      const y = window.scrollY || 0;
      const viewport = Math.max(window.innerHeight || 0, 600);
      const atBottom = y + viewport >= height - 4;
      if (atBottom && height === lastHeight) stableBottomRounds += 1;
      else stableBottomRounds = 0;
      lastHeight = height;
      if (stableBottomRounds >= 2) {
        state = "complete";
        break;
      }
      if (step === MAX_SCROLLS) break;
      window.scrollTo(originalX, Math.min(y + Math.floor(viewport * 0.8), height));
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
    readCards();
    return { state, profile, notes: Array.from(notes.values()).slice(0, MAX_NOTES) };
  } finally {
    window.scrollTo(originalX, originalY);
  }
}
