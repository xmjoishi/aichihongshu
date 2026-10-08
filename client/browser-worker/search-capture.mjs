const MAX_KEYWORD_LENGTH = 80;
export const MAX_SEARCH_NOTES = 50;

export function validateSearchUrl(value) {
  if (typeof value !== "string" || value.length > 1_000) {
    throw new TypeError("搜索 URL 无效或超过长度限制");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("搜索 URL 格式无效");
  }
  if (url.protocol !== "https:" || !["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname.toLowerCase())) {
    throw new TypeError("搜索采集只支持小红书 HTTPS 页面");
  }
  if (url.username || url.password || !/^\/search_result\/?$/.test(url.pathname)) {
    throw new TypeError("搜索 URL 路径无效");
  }
  const params = [...url.searchParams.keys()].sort();
  if (params.length !== 2 || params[0] !== "keyword" || params[1] !== "max_count") {
    throw new TypeError("搜索 URL 参数无效");
  }
  const keyword = url.searchParams.get("keyword")?.trim() ?? "";
  const count = Number(url.searchParams.get("max_count"));
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH || /[\u0000-\u001f]/.test(keyword)) {
    throw new TypeError("单个搜索关键词不能为空且不能超过 80 个字符");
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_SEARCH_NOTES) {
    throw new TypeError(`搜索数量必须在 1 到 ${MAX_SEARCH_NOTES} 之间`);
  }
  return { url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, keyword, count };
}

export function readSearchPage({ maxNotes }) {
  const text = (value, max) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
  const bodyText = text(document.body?.innerText ?? "", 20_000);
  const pageUrl = location.href.toLowerCase();
  if (/\/login(?:[/?#]|$)/.test(pageUrl) || document.querySelector('input[type="password"], [class*="login-container"], [class*="LoginPage"]')) {
    return { state: "login-required", items: [] };
  }
  if (/验证码|安全验证|请完成验证|滑动验证|检测到异常/i.test(bodyText) || document.querySelector('[class*="captcha"], [class*="Captcha"], [class*="verify"], [class*="Verify"]')) {
    return { state: "verification-required", items: [] };
  }

  const anchors = Array.from(document.querySelectorAll('a[href*="/explore/"]'));
  const seen = new Set();
  const items = [];
  const metricText = (card, pattern) => {
    const nodes = Array.from(card.querySelectorAll('[class*="count"], [class*="Count"], span'));
    const node = nodes.find((candidate) => pattern.test(String(candidate.className || "")) && text(candidate.innerText, 40));
    return node ? text(node.innerText, 40) : "";
  };
  for (const anchor of anchors) {
    let noteUrl;
    try {
      noteUrl = new URL(anchor.getAttribute("href"), location.origin);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(noteUrl.protocol) || !["xiaohongshu.com", "www.xiaohongshu.com"].includes(noteUrl.hostname.toLowerCase())) continue;
    const noteMatch = noteUrl.pathname.match(/^\/explore\/([A-Za-z0-9_-]{1,128})\/?$/);
    if (!noteMatch || seen.has(noteMatch[1])) continue;
    seen.add(noteMatch[1]);
    const card = anchor.closest('[data-note-id], [class*="note-item"], [class*="NoteItem"], section, article') || anchor.parentElement || anchor;
    const titleNode = card.querySelector('[class*="title"], [class*="Title"]');
    const descNode = card.querySelector('[class*="desc"], [class*="Desc"], [class*="content"], [class*="Content"]');
    const authorNode = card.querySelector('[class*="author"], [class*="Author"], [class*="nickname"], [class*="NickName"]');
    const tagNodes = Array.from(card.querySelectorAll('a[href*="search_result"], [class*="tag"], [class*="Tag"]'));
    const tags = [...new Set(tagNodes.map((node) => text(node.innerText, 40)).filter(Boolean))].slice(0, 12);
    const image = card.querySelector("img[src]")?.getAttribute("src") ?? "";
    const imageUrl = image ? (() => {
      try {
        const url = new URL(image, location.origin);
        return url.protocol === "https:" ? url.toString().slice(0, 1_000) : "";
      } catch { return ""; }
    })() : "";
    items.push({
      note_id: noteMatch[1],
      note_url: `https://www.xiaohongshu.com/explore/${noteMatch[1]}`,
      title: text(titleNode?.innerText || anchor.getAttribute("title") || anchor.innerText, 240),
      desc: text(descNode?.innerText || card.innerText, 600),
      user_nickname: text(authorNode?.innerText, 120),
      liked_count: metricText(card, /like|heart|赞/i),
      collected_count: metricText(card, /collect|star|收藏/i),
      comment_count: metricText(card, /comment|评论/i),
      tag_list: tags.join(" "),
      image_url: imageUrl,
    });
    if (items.length >= maxNotes) break;
  }
  return { state: items.length ? "complete" : "empty", items };
}

function boundedText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeNoteUrl(value, noteId) {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/explore\/([A-Za-z0-9_-]{1,128})\/?$/);
    if (!match || (noteId && noteId !== match[1])) return null;
    return `https://www.xiaohongshu.com/explore/${match[1]}`;
  } catch {
    return null;
  }
}

export function sanitizeSearchSnapshot(value, expectedCount) {
  const state = ["complete", "empty", "login-required", "verification-required"].includes(value?.state)
    ? value.state : "empty";
  if (state === "login-required" || state === "verification-required") return { state, items: [] };
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(value?.items) ? value.items : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const noteId = boundedText(raw.note_id, 128);
    const noteUrl = safeNoteUrl(raw.note_url, noteId);
    if (!noteUrl || seen.has(noteUrl)) continue;
    seen.add(noteUrl);
    items.push({
      note_id: noteId,
      note_url: noteUrl,
      title: boundedText(raw.title, 240),
      desc: boundedText(raw.desc, 600),
      user_nickname: boundedText(raw.user_nickname, 120),
      liked_count: boundedText(raw.liked_count, 40),
      collected_count: boundedText(raw.collected_count, 40),
      comment_count: boundedText(raw.comment_count, 40),
      tag_list: boundedText(raw.tag_list, 240),
      image_url: boundedText(raw.image_url, 1_000).startsWith("https://") ? boundedText(raw.image_url, 1_000) : "",
    });
    if (items.length >= expectedCount) break;
  }
  return { state: items.length ? "complete" : "empty", items };
}
