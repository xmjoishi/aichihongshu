// 页面提取器（自包含 IIFE）：被 executeScript files 注入后返回结构化结果。
// 尽量避开站点导航/页脚；指标解析失败保持 null。
(() => {
  const selection = String((window.getSelection && window.getSelection()) || "").trim();
  const title = String(document.title || "").replace(/\s*[-|—]\s*(小红书|Xiaohongshu|RED)\s*$/i, "").trim() || String(document.title || "").trim();
  const sourceUrl = String(location.href || "");
  const host = String(location.hostname || "").toLowerCase();
  const path = String(location.pathname || "");

  function visibleText(el) {
    if (!el) return "";
    return String(el.innerText || el.textContent || "").trim();
  }

  // 正文：优先笔记/文章容器，排除导航页脚；否则取选区。
  let body = selection;
  if (!body) {
    const candidates = [
      document.querySelector("#detail-title")?.parentElement,
      document.querySelector('[class*="note-content"]'),
      document.querySelector('[class*="note-text"]'),
      document.querySelector("article"),
      document.querySelector("main"),
      document.querySelector('[class*="content"]'),
    ].filter(Boolean);
    for (const root of candidates) {
      const clone = root.cloneNode(true);
      clone.querySelectorAll("nav,header,footer,script,style,aside,[class*='footer'],[class*='nav']").forEach((n) => n.remove());
      const text = visibleText(clone);
      if (text.length > 40) {
        body = text;
        break;
      }
    }
    if (!body) {
      const root = document.querySelector("main") || document.querySelector("article") || document.body;
      body = visibleText(root);
    }
  }

  // 作者
  const authorEl =
    document.querySelector('[class*="author"] [class*="name"]')
    || document.querySelector('[class*="user-name"]')
    || document.querySelector('a[href*="/user/profile/"]')
    || document.querySelector('[class*="author"]');
  const author = visibleText(authorEl).slice(0, 200);

  function parseCount(text) {
    if (!text) return null;
    const t = String(text).replace(/,/g, "").trim();
    const m = t.match(/(\d+(?:\.\d+)?)\s*(万|w|W|k|K)?/);
    if (!m) return null;
    let n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "万" || unit === "w") n = n * 10000;
    else if (unit === "k") n = n * 1000;
    return Math.floor(n);
  }

  // 先从常见互动节点取，再退回全文正则。
  function pickMetricBySelectors(selectors, labels) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = visibleText(el);
      const value = parseCount(text);
      if (value != null) return value;
    }
    for (const label of labels) {
      const re = new RegExp(label + "\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?\\s*(?:万|w|W|k|K)?)", "i");
      const hit = body.match(re) || document.body.innerText.match(re);
      if (hit) {
        const value = parseCount(hit[1]);
        if (value != null) return value;
      }
    }
    return null;
  }

  // 小红书互动栏常见：按钮/图标旁数字
  function pickFromLikeBar(index) {
    const bars = document.querySelectorAll(
      '[class*="interact"] [class*="count"], [class*="like-wrapper"] [class*="count"], [class*="chat-wrapper"] [class*="count"], [class*="collect"] [class*="count"], [class*="like"] span, [class*="collect"] span, [class*="comment"] span',
    );
    if (bars.length > index) return parseCount(visibleText(bars[index]));
    return null;
  }

  const like =
    pickFromLikeBar(0)
    ?? pickMetricBySelectors(['[class*="like"] [class*="count"]', '[class*="like-count"]'], ["赞", "点赞", "likes?", "Like"]);
  const collect =
    pickFromLikeBar(1)
    ?? pickMetricBySelectors(['[class*="collect"] [class*="count"]', '[class*="collect-count"]'], ["收藏", "collects?", "Collect"]);
  const comment =
    pickFromLikeBar(2)
    ?? pickMetricBySelectors(['[class*="comment"] [class*="count"]', '[class*="chat"] [class*="count"]'], ["评论", "comments?", "Comment"]);

  const metrics = {
    like,
    collect,
    comment,
    followers: pickMetricBySelectors(['[class*="follower"] [class*="count"]'], ["粉丝", "followers?", "Followers"]),
    noteCount: pickMetricBySelectors([], ["笔记", "notes?", "Notes"]),
  };

  let pageType = "web";
  if (host.includes("xiaohongshu") || host.includes("xhslink")) {
    if (/\/(explore|discovery\/item|search-result)/.test(path)) pageType = "note";
    else if (/\/user\/profile\//.test(path)) pageType = "profile";
    else pageType = "note";
  }

  return {
    pageType,
    title: title.slice(0, 200),
    sourceUrl: sourceUrl.slice(0, 2000),
    body: body.slice(0, 20000),
    bodyExcerpt: body.slice(0, 400),
    author,
    observedAt: new Date().toISOString(),
    metrics,
    hasSelection: selection.length > 0,
  };
})();
