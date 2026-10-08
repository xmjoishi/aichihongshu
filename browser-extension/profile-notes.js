// Collect only public note cards already rendered on the explicitly opened
// creator page. Scrolling is bounded and the original page position is restored.
(() => (async () => {
  const MAX_NOTES = 30;
  const MAX_SCROLLS = 16;
  const WAIT_MS = 350;
  const originalX = window.scrollX || 0;
  const originalY = window.scrollY || 0;
  const host = location.hostname.toLowerCase();
  const xhsHost = host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  if (!xhsHost) return { state: "not-profile", notes: [] };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const textOf = (node) => String(node?.innerText || node?.textContent || "")
    .replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const parseCount = (raw) => {
    const match = String(raw || "").replace(/,/g, "")
      .match(/(?<![\d.])(\d+(?:\.\d+)?)\s*(万|億|亿|w|W|k|K)?/u);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = (match[2] || "").toLowerCase();
    const multiplier = unit === "万" || unit === "w" ? 10_000
      : unit === "亿" || unit === "億" ? 100_000_000
        : unit === "k" ? 1_000 : 1;
    const count = Math.floor(value * multiplier);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  };
  const challenge = () => /验证码|安全验证|访问异常|操作频繁|请求过于频繁/.test(textOf(document.body));
  const loginRequired = () => /passport\/login|\/login(?:\/|$)/i.test(location.pathname)
    || /登录后查看|登录后获取|请先登录/.test(textOf(document.body));
  if (challenge()) return { state: "verification-required", notes: [] };
  if (loginRequired()) return { state: "login-required", notes: [] };
  if (!/^\/user\/profile\//.test(location.pathname)) return { state: "not-profile", notes: [] };
  const notes = new Map();
  const scrollRoot = document.scrollingElement || document.documentElement;
  let stableBottomRounds = 0;
  let lastHeight = -1;
  let state = "partial";

  function noteScope() {
    return document.querySelector(
      '[class*="feeds-container"],[class*="note-list"],[class*="noteList"],[class*="user-note"],[class*="userNotes"]',
    ) || document.querySelector("main") || document;
  }

  function readCards() {
    const scope = noteScope();
    const anchors = Array.from(scope.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"]'));
    for (const anchor of anchors) {
      if (notes.size >= MAX_NOTES) break;
      let url;
      try { url = new URL(anchor.href || anchor.getAttribute("href"), location.href); } catch { continue; }
      const cardHost = url.hostname.toLowerCase();
      if ((cardHost !== "xiaohongshu.com" && !cardHost.endsWith(".xiaohongshu.com"))
        || url.protocol !== "https:" || url.username || url.password) continue;
      const match = url.pathname.match(/^\/(?:explore\/|discovery\/item\/)([A-Za-z0-9_-]+)/);
      if (!match) continue;
      const canonicalUrl = `${url.origin}${url.pathname}`;
      if (notes.has(match[1])) continue;

      const card = anchor.closest?.('[class*="note-item"],[class*="note-card"],[class*="noteItem"],[data-note-id]') || anchor;
      const titleNode = card.querySelector?.('[class*="title"],[class*="desc"]');
      const image = card.querySelector?.("img[alt]");
      const title = (textOf(titleNode) || String(image?.alt || "").trim()
        || String(anchor.getAttribute("aria-label") || "").trim() || textOf(anchor)).slice(0, 200);
      if (!title) continue;
      const bodyNode = card.querySelector?.('[class*="desc"],[class*="content"]');
      const body = (textOf(bodyNode) || textOf(anchor)).slice(0, 1_200);
      const labeledCount = (selectors) => {
        for (const selector of selectors) {
          const node = card.querySelector?.(selector);
          const count = parseCount(node?.getAttribute?.("aria-label") || textOf(node));
          if (count !== null) return count;
        }
        return null;
      };
      const timestamp = card.querySelector?.('time[datetime]');
      const timeNode = timestamp || card.querySelector?.('[class*="publish-time"],[class*="time"]');
      const tags = Array.from(new Set(Array.from(body.matchAll(/#([\p{L}\p{N}_-]{1,40})/gu), (item) => item[1])))
        .slice(0, 20);
      notes.set(match[1], {
        noteUrl: canonicalUrl,
        title,
        body,
        likes: labeledCount(['[class*="like-wrapper"]','[class*="like-count"]','[aria-label*="赞"]']),
        comments: labeledCount(['[class*="comment-count"]','[aria-label*="评论"]']),
        collects: labeledCount(['[class*="collect-count"]','[aria-label*="收藏"]']),
        tags,
        publishedAt: String(timeNode?.getAttribute?.("datetime") || textOf(timeNode) || "").slice(0, 80) || null,
      });
    }
  }

  try {
    for (let step = 0; step <= MAX_SCROLLS; step += 1) {
      if (challenge()) return { state: "verification-required", notes: [] };
      if (loginRequired()) return { state: "login-required", notes: [] };
      readCards();
      if (notes.size >= MAX_NOTES) {
        // Reaching the safety cap says only that the first 30 cards were read;
        // it does not prove the profile has no older notes.
        state = "partial";
        break;
      }
      const heightBefore = Math.max(scrollRoot.scrollHeight || 0, document.body?.scrollHeight || 0);
      const yBefore = window.scrollY || 0;
      const viewportHeight = Math.max(window.innerHeight || 0, 600);
      const atBottom = yBefore + viewportHeight >= heightBefore - 4;
      if (atBottom && heightBefore === lastHeight) stableBottomRounds += 1;
      else stableBottomRounds = 0;
      lastHeight = heightBefore;
      if (stableBottomRounds >= 2) {
        state = "complete";
        break;
      }
      if (step === MAX_SCROLLS) break;
      window.scrollTo(originalX, Math.min(yBefore + Math.floor(viewportHeight * 0.8), heightBefore));
      await wait(WAIT_MS);
    }
    if (challenge()) return { state: "verification-required", notes: [] };
    if (loginRequired()) return { state: "login-required", notes: [] };
    readCards();
    return { state, notes: Array.from(notes.values()).slice(0, MAX_NOTES) };
  } finally {
    window.scrollTo(originalX, originalY);
  }
})())();
