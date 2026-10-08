// Self-contained one-shot page parser injected by chrome.scripting. The output
// contains only visible text and public image references already present in DOM.
(() => {
  const MAX_BODY = 20_000;
  const MAX_IMAGES = 12;
  const MAX_COMMENTS = 20;
  const selection = String((window.getSelection && window.getSelection()) || "").trim();
  const sourceUrl = String(location.href || "");
  const host = String(location.hostname || "").toLowerCase();
  const path = String(location.pathname || "");
  const rawTitle = String(document.title || "").trim();
  const title = rawTitle.replace(/\s*[-|—]\s*(小红书|Xiaohongshu|RED)\s*$/i, "").trim() || rawTitle;
  const xhsHost = host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");

  const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\u00a0/g, " ").trim();
  const first = (selectors, root = document) => {
    for (const selector of selectors) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch { /* stale site selector */ }
    }
    return null;
  };
  const all = (selector, root = document) => {
    try { return Array.from(root.querySelectorAll(selector) || []); } catch { return []; }
  };

  function isPublicImageHost(hostname) {
    const hostnameValue = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!hostnameValue || hostnameValue === "localhost" || hostnameValue.endsWith(".localhost") || hostnameValue.endsWith(".local")) return false;
    if (hostnameValue.includes(":")) return false;
    const octets = hostnameValue.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : NaN);
    if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [a, b] = octets;
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && [0, 2].includes(octets[2]))
        || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && octets[2] === 100)
        || (a === 203 && b === 0 && octets[2] === 113)) return false;
    }
    return true;
  }

  let pageType = "web";
  if (xhsHost && /^\/user\/profile\//.test(path)) pageType = "profile";
  else if (xhsHost && /^\/(explore|discovery\/item|search_result)\//.test(path)) pageType = "note";

  const profileRoot = pageType === "profile"
    ? first(['[class*="user-info"]', '[class*="profile-header"]', '[class*="profile"]', "main"])
    : null;

  const contentRoot = pageType === "profile" ? null : first([
    "#detail-desc",
    '[class*="note-content"]',
    '[class*="noteContent"]',
    '[class*="note-detail"]',
    "article",
    "main",
  ]);
  // A creator page is a profile plus a list of notes, not one giant note body.
  // Keep the feed out of the biography/body field even when the site uses <main>.
  let body = pageType === "profile" ? "" : selection || textOf(contentRoot);
  if (!body && pageType !== "profile") body = textOf(first(["article", "main"]) || document.body);
  body = body.replace(/\n{3,}/g, "\n\n").slice(0, MAX_BODY);

  const authorNode = pageType === "profile"
    ? first([
      '[class*="user-info"] [class*="name"]',
      '[class*="profile"] [class*="name"]',
      '[class*="nickname"]',
      "main h1",
    ], profileRoot || document)
    : first([
    '[class*="author"] [class*="name"]',
    '[class*="user-name"]',
    'a[href*="/user/profile/"] [class*="name"]',
    'a[href*="/user/profile/"]',
    ]);
  const author = textOf(authorNode).slice(0, 200);

  function parseCount(raw) {
    if (!raw) return null;
    const match = String(raw).replace(/,/g, "").match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(万|億|亿|w|W|k|K)?(?:$|[^\p{L}\d])/u);
    if (!match) return null;
    let count = Number(match[1]);
    const unit = (match[2] || "").toLowerCase();
    if (unit === "万" || unit === "w") count *= 10_000;
    else if (unit === "亿" || unit === "億") count *= 100_000_000;
    else if (unit === "k") count *= 1_000;
    return Number.isSafeInteger(Math.floor(count)) && count >= 0 ? Math.floor(count) : null;
  }

  const metricLabels = {
    like: /点赞|获赞|赞同|likes?\b/i,
    collect: /收藏|collects?\b/i,
    comment: /评论|comments?\b/i,
    share: /转发|分享|shares?\b/i,
    followers: /粉丝|followers?\b/i,
    follows: /关注|following\b/i,
    noteCount: /笔记|作品|notes?\b/i,
  };
  const evidence = {};
  function findMetric(key, selectors) {
    if (pageType === "web" || (pageType === "profile" && ["like", "collect", "comment"].includes(key))) {
      evidence[key] = { source: null, missingReason: "页面类型不适用" };
      return null;
    }
    for (const selector of selectors) {
      const metricRoot = pageType === "profile" ? (profileRoot || document) : document;
      const node = first([selector], metricRoot);
      const value = parseCount(textOf(node));
      if (value !== null) {
        evidence[key] = { source: `selector:${selector}`, missingReason: null };
        return value;
      }
    }
    // Only inspect small, labeled counter nodes. Never scrape arbitrary numbers
    // from the whole page body as engagement metrics.
    const roots = pageType === "profile"
      ? [profileRoot]
      : [first(['[class*="interact"]', '[class*="engage"]', '[class*="note-detail"]', "article", "main"])];
    const label = metricLabels[key];
    for (const root of roots.filter(Boolean)) {
      for (const node of all('[aria-label],button,[class*="count"],[class*="stat"]', root)) {
        const candidate = `${node.getAttribute?.("aria-label") || ""} ${textOf(node)}`;
        if (!label.test(candidate)) continue;
        if (key === "follows" && /粉丝|followers?\b/i.test(candidate)) continue;
        const value = parseCount(candidate);
        if (value !== null) {
          evidence[key] = { source: "labeled-visible-counter", missingReason: null };
          return value;
        }
      }
    }
    evidence[key] = { source: null, missingReason: "当前 DOM 未找到带标签的可见计数" };
    return null;
  }

  function findCommentTotal() {
    const missingReason = "未找到笔记操作栏的评论总数；已加载评论片段数不代表总数";
    const scope = noteDetailScope() || document;
    const actionRoot = first([
      '[class*="interact"]', '[class*="engage"]', '[class*="action-bar"]',
      '[class*="toolbar"]', '[class*="bottom-bar"]',
    ], scope);
    const roots = [...new Set([actionRoot, scope].filter(Boolean))];
    const candidates = [];
    for (const root of roots) {
      for (const node of all('[aria-label],button,[class*="comment-count"],[class*="commentCount"]', root)) {
        let ancestor = node;
        let insideCommentList = false;
        for (let depth = 0; ancestor && depth < 7; depth += 1, ancestor = ancestor.parentElement) {
          if (/comment[-_ ]?(?:item|list|content|children)|reply[-_ ]?(?:item|list)|sub[-_ ]?comment/i.test(nodeLabel(ancestor))) {
            insideCommentList = true;
            break;
          }
        }
        if (insideCommentList) continue;
        const aria = String(node.getAttribute?.("aria-label") || "").trim();
        const label = `${aria} ${textOf(node)}`.replace(/\s+/g, " ").trim();
        if (!/评论|comments?\b/i.test(label) || label.length > 100) continue;
        const numericPart = label.match(/评论\s*[:：]?\s*([\d,.]+\s*(?:万|億|亿|w|W|k|K)?)/i)
          || label.match(/([\d,.]+\s*(?:万|億|亿|w|W|k|K)?)\s*(?:条)?评论/i)
          || label.match(/comments?\s*[:：]?\s*([\d,.]+\s*[kK]?)/i);
        const value = parseCount(numericPart?.[1] || "");
        if (value === null) continue;
        const nodeName = nodeLabel(node);
        candidates.push({
          value,
          label,
          score: (actionRoot && (node === actionRoot || actionRoot.contains?.(node)) ? 8 : 0)
            + (/comment[-_]?count/i.test(nodeName) ? 5 : 0)
            + (aria ? 2 : 0)
            - Math.min(label.length, 100) / 100,
        });
      }
    }
    candidates.sort((left, right) => right.score - left.score || left.label.length - right.label.length);
    const match = candidates[0];
    if (match) {
      evidence.comment = { source: "note-action-comment-total", missingReason: null };
      return match.value;
    }
    evidence.comment = { source: null, missingReason };
    return null;
  }

  const metrics = {
    like: findMetric("like", ['[class*="like-count"]', '[class*="like"] [class*="count"]']),
    collect: findMetric("collect", ['[class*="collect-count"]', '[class*="collect"] [class*="count"]']),
    comment: pageType === "note" ? findCommentTotal() : findMetric("comment", []),
    share: pageType === "note" ? findMetric("share", ['[class*="share-count"]', '[class*="share"] [class*="count"]']) : null,
    followers: findMetric("followers", ['[class*="follower-count"]', '[class*="follower"] [class*="count"]']),
    follows: findMetric("follows", []),
    noteCount: findMetric("noteCount", ['[class*="note-count"]', '[class*="note-count"]']),
  };

  let profile = null;
  if (profileRoot) {
    const avatarNode = first([
      '[class*="avatar"] img',
      '[class*="user-info"] img',
      '[class*="profile"] img',
    ], profileRoot);
    const avatarCandidate = String(avatarNode?.currentSrc || avatarNode?.src || "").trim();
    let avatarUrl = "";
    try {
      const avatar = new URL(avatarCandidate);
      if (avatar.protocol === "https:" && !avatar.username && !avatar.password && isPublicImageHost(avatar.hostname)) {
        avatarUrl = avatar.href.slice(0, 2_000);
      }
    } catch { /* missing or unsafe avatar */ }

    const bio = textOf(first([
      '[class*="user-desc"]',
      '[class*="profile-desc"]',
      '[class*="user-info"] [class*="desc"]',
      '[class*="profile"] [class*="desc"]',
    ], profileRoot)).slice(0, 2_000);
    const profileText = textOf(profileRoot);
    const ipMatch = profileText.match(/(?:IP属地|IP\s*location)\s*[:：]?\s*([^\s·|]+)/i);
    const tags = Array.from(new Set(all('[class*="tag"],[class*="label"]', profileRoot)
      .map((node) => textOf(node).replace(/^#/, "").trim())
      .filter((value) => value.length >= 1 && value.length <= 80 && !/粉丝|关注|笔记|作品|IP属地/i.test(value))))
      .slice(0, 30);
    profile = {
      avatarUrl,
      bio,
      ipLocation: ipMatch?.[1]?.slice(0, 100) || "",
      follows: metrics.follows,
      tags,
    };
  }

  const profileNotes = [];
  if (pageType === "profile") {
    const feedRoot = first([
      '[class*="feeds-container"]', '[class*="note-list"]', '[class*="noteList"]',
      '[class*="user-note"]', '[class*="userNotes"]',
    ], document) || first(["main"], document);
    const seenProfileNotes = new Set();
    for (const anchor of all('a[href*="/explore/"],a[href*="/discovery/item/"]', feedRoot || document)) {
      let noteUrl;
      try { noteUrl = new URL(anchor.href || anchor.getAttribute?.("href") || "", sourceUrl); } catch { continue; }
      if ((noteUrl.hostname !== "xiaohongshu.com" && !noteUrl.hostname.endsWith(".xiaohongshu.com"))
        || noteUrl.protocol !== "https:" || noteUrl.username || noteUrl.password) continue;
      const match = noteUrl.pathname.match(/^\/(?:explore\/|discovery\/item\/)([A-Za-z0-9_-]+)/);
      if (!match || seenProfileNotes.has(match[1])) continue;
      const card = anchor.closest?.('[class*="note-item"],[class*="note-card"],[class*="noteItem"],[data-note-id]') || anchor;
      const titleNode = first(['[class*="title"]', '[class*="desc"]'], card);
      const image = first(["img[alt]"], card);
      const noteTitle = (textOf(titleNode) || String(image?.alt || "").trim()
        || String(anchor.getAttribute?.("aria-label") || "").trim() || textOf(anchor)).slice(0, 200);
      if (!noteTitle) continue;
      const noteBody = textOf(first(['[class*="desc"]', '[class*="content"]'], card) || anchor).slice(0, 1_200);
      const countFrom = (selector) => {
        const node = first([selector], card);
        return parseCount(node?.getAttribute?.("aria-label") || textOf(node));
      };
      const timeNode = first(['time[datetime]', '[class*="publish-time"]', '[class*="time"]'], card);
      profileNotes.push({
        noteUrl: `${noteUrl.origin}${noteUrl.pathname}`,
        title: noteTitle,
        body: noteBody,
        likes: countFrom('[class*="like-count"]') ?? countFrom('[aria-label*="赞"]'),
        comments: countFrom('[class*="comment-count"]') ?? countFrom('[aria-label*="评论"]'),
        collects: countFrom('[class*="collect-count"]') ?? countFrom('[aria-label*="收藏"]'),
        publishedAt: String(timeNode?.getAttribute?.("datetime") || textOf(timeNode) || "").slice(0, 80) || null,
      });
      seenProfileNotes.add(match[1]);
      if (profileNotes.length >= 30) break;
    }
  }

  const IMAGE_CONTAINER_SELECTORS = [
    "#detail-img-container",
    "#detail-image",
    '[class*="swiper-wrapper"]',
    '[class*="carousel"]',
    '[class*="slider"]',
    '[class*="note-image"]',
    '[class*="note-img"]',
    '[class*="image-list"]',
    '[class*="img-list"]',
    '[class*="detail-image"]',
  ].join(",");
  const EXCLUDED_IMAGE_REGION = /recommend|related|similar|guess|猜你喜欢|推荐|瀑布|waterfall|feed-list|comment|avatar|profile|author|user-info|toolbar|icon/i;

  function nodeLabel(node) {
    return [
      node?.id,
      node?.className,
      node?.getAttribute?.("id"),
      node?.getAttribute?.("class"),
      node?.getAttribute?.("aria-label"),
      node?.getAttribute?.("data-testid"),
    ].filter((part) => typeof part === "string").join(" ");
  }

  function inExcludedImageRegion(node) {
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (EXCLUDED_IMAGE_REGION.test(nodeLabel(current))) return true;
    }
    return false;
  }

  function domDistance(left, right, maxDepth = 8) {
    if (!left || !right) return Infinity;
    const leftAncestors = new Map();
    let current = left;
    for (let depth = 0; current && depth <= maxDepth; depth += 1, current = current.parentElement) {
      leftAncestors.set(current, depth);
    }
    current = right;
    let best = Infinity;
    for (let depth = 0; current && depth <= maxDepth; depth += 1, current = current.parentElement) {
      const leftDepth = leftAncestors.get(current);
      if (leftDepth !== undefined) best = Math.min(best, leftDepth + depth);
    }
    return best;
  }

  function noteDetailScope() {
    if (!contentRoot) return null;
    const chain = [];
    let current = contentRoot;
    for (let depth = 0; current && depth <= 5; depth += 1, current = current.parentElement) chain.push(current);
    const strongScope = /note[-_]?detail|note[-_]?container|note[-_]?.*modal|detail[-_]?container|article|^main$/i;
    const weakScope = /detail|note[-_]?content/i;
    return chain.find((node) => strongScope.test(nodeLabel(node)))
      || chain.find((node) => weakScope.test(nodeLabel(node)))
      || contentRoot;
  }

  function imageRootForCurrentPage() {
    if (pageType === "profile" || !contentRoot) return { root: null, explicit: false };
    const scope = pageType === "note" ? noteDetailScope() : contentRoot;
    if (!scope || inExcludedImageRegion(scope)) return { root: null, explicit: false };
    const candidates = [];
    const seen = new Set();
    const addCandidate = (root, explicit, distance) => {
      if (!root || seen.has(root) || inExcludedImageRegion(root) || distance > 8) return;
      seen.add(root);
      candidates.push({ root, explicit, distance });
    };

    // Search only inside the current article/note scope. This finds sibling
    // carousels without scanning recommendations or images across the whole page.
    for (const root of all(IMAGE_CONTAINER_SELECTORS, scope)) {
      addCandidate(root, true, domDistance(root, contentRoot));
    }
    candidates.sort((a, b) => a.distance - b.distance || Number(b.explicit) - Number(a.explicit));
    if (candidates.length) return candidates[0];

    // If site class names changed, inspect the identified detail scope only. A
    // missing scope is an explicit unsupported-structure state, never document-wide.
    return { root: scope, explicit: false, distance: domDistance(scope, contentRoot) };
  }

  function srcsetCandidates(image) {
    const raw = String(image?.getAttribute?.("srcset") || image?.srcset || "");
    return raw.split(",").map((entry) => {
      const [url, descriptor = ""] = entry.trim().split(/\s+/, 2);
      const match = descriptor.match(/^(\d+(?:\.\d+)?)(w|x)$/i);
      return { url, rank: match ? Number(match[1]) : 0 };
    }).filter((candidate) => candidate.url).sort((a, b) => b.rank - a.rank).map((candidate) => candidate.url);
  }

  function publicImageUrl(candidates, diagnostics) {
    for (const raw of candidates) {
      const value = String(raw || "").trim();
      if (!value) continue;
      let parsedUrl;
      try { parsedUrl = new URL(value, sourceUrl); } catch { diagnostics.rejectedUrl += 1; continue; }
      if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password
        || !isPublicImageHost(parsedUrl.hostname)) {
        diagnostics.rejectedUrl += 1;
        continue;
      }
      return parsedUrl.href.slice(0, 2_000);
    }
    return "";
  }

  function backgroundImageUrl(node) {
    const inlineStyle = String(node?.style?.backgroundImage || "");
    const attributeStyle = String(node?.getAttribute?.("style") || "");
    const css = inlineStyle || (attributeStyle.match(/background(?:-image)?\s*:\s*([^;]+)/i)?.[1] || "");
    return Array.from(css.matchAll(/url\(["']?([^"')]+)["']?\)/gi), (match) => match[1]);
  }

  const imageDiagnostics = { rejectedUrl: 0, notLoaded: 0, tooSmall: 0, excluded: 0 };
  const selectedImageRoot = imageRootForCurrentPage();
  const imageRoot = selectedImageRoot.root;
  const imageMap = new Map();
  if (imageRoot) {
    const mediaNodes = all('img,[style*="background-image"]', imageRoot);
    if ((imageRoot?.style?.backgroundImage || imageRoot?.getAttribute?.("style")) && !mediaNodes.includes(imageRoot)) {
      mediaNodes.unshift(imageRoot);
    }
    for (const [domIndex, image] of mediaNodes.entries()) {
      if (inExcludedImageRegion(image)) { imageDiagnostics.excluded += 1; continue; }
      const isImg = String(image?.tagName || image?.nodeName || "").toLowerCase() === "img";
      const urls = isImg
        ? [image.currentSrc, ...srcsetCandidates(image), image.getAttribute?.("src"), image.src]
        : backgroundImageUrl(image);
      const url = publicImageUrl(urls, imageDiagnostics);
      if (!url) continue;
      const bounds = isImg ? null : image.getBoundingClientRect?.();
      const width = Number(isImg ? image.naturalWidth : bounds?.width || image.width || 0);
      const height = Number(isImg ? image.naturalHeight : bounds?.height || image.height || 0);
      if (isImg && (width <= 0 || height <= 0)) { imageDiagnostics.notLoaded += 1; continue; }
      if (width < 160 || height < 160 || /avatar|head|profile|icon|logo/i.test(`${url} ${image.alt || ""}`)) {
        imageDiagnostics.tooSmall += 1;
        continue;
      }
      const noteId = new URL(sourceUrl).pathname.split("/").filter(Boolean).pop() || "";
      const taggedNoteId = String(image.getAttribute?.("data-note-id")
        || image.getAttribute?.("data-xhs-note-id") || "").trim();
      if (taggedNoteId && noteId && taggedNoteId !== noteId) continue;
      if (!imageMap.has(url)) {
        imageMap.set(url, {
          url,
          width,
          height,
          domIndex,
          source: isImg ? "visible-note-image" : "visible-note-background",
          selected: false,
        });
      }
      if (imageMap.size >= MAX_IMAGES * 3) break;
    }
  }
  const images = Array.from(imageMap.values()).slice(0, MAX_IMAGES);
  const imageStatus = pageType === "profile"
    ? { state: "not-applicable", reason: "主页资料不混入主页笔记或其他图片" }
    : images.length
      ? { state: "ready", reason: "已识别当前笔记已加载图片" }
      : !imageRoot
        ? { state: "unsupported-structure", reason: "无法定位当前笔记正文/详情区；不会扫描整页推荐内容" }
        : imageDiagnostics.notLoaded
          ? { state: "not-loaded", reason: "已找到当前笔记图片，但图片尚未加载完成" }
          : imageDiagnostics.rejectedUrl
            ? { state: "rejected-url", reason: "已找到当前笔记图片，但 URL 不是安全的 HTTPS 公网地址" }
            : imageDiagnostics.tooSmall
              ? { state: "no-eligible-image", reason: "当前详情区没有达到最小尺寸的笔记主图" }
              : selectedImageRoot.explicit
                ? { state: "no-image", reason: "已找到笔记图片容器，但其中没有已加载的图片" }
    : { state: "container-not-found", reason: pageType === "note"
      ? "当前笔记详情区没有识别到图片容器；不会扫描整页推荐内容"
      : "当前文章内容区没有识别到图片容器；不会扫描整页推荐内容" };

  const comments = [];
  if (pageType === "note") {
    const seenComments = new Set();
    for (const node of all('[class*="comment-item"],[class*="commentItem"],[data-testid*="comment"]')) {
      const contentNode = first(['[class*="content"]', '[class*="text"]', '[class*="desc"]'], node);
      const content = textOf(contentNode || node).replace(/\s+/g, " ").trim();
      if (!content || content.length < 2 || seenComments.has(content)) continue;
      seenComments.add(content);
      const authorNodeForComment = first(['[class*="user-name"]', '[class*="author"]', "a"], node);
      const countNode = first(['[class*="like"] [class*="count"]', '[aria-label*="赞"]'], node);
      comments.push({
        author: textOf(authorNodeForComment).slice(0, 80),
        text: content.slice(0, 350),
        likes: parseCount(textOf(countNode)),
        truncated: content.length > 350,
        source: "currently-loaded-comment",
      });
      if (comments.length >= MAX_COMMENTS) break;
    }
  }

  const publishedNode = pageType === "note" ? first(['time[datetime]', '[class*="publish-time"]', '[class*="date"]']) : null;
  const rawPublishedText = textOf(publishedNode);
  const publishedTextParts = rawPublishedText.match(/^((?:\d{4}[./年-])?\d{1,2}[./月-]\d{1,2}日?)(?:\s+|·|[，,]\s*)(?:(?:IP属地|来自)\s*)?([\p{L}·]{2,24})$/u);
  const publishedAt = publishedNode
    ? String(publishedNode.getAttribute?.("datetime") || publishedTextParts?.[1] || rawPublishedText).slice(0, 80)
    : null;
  const publishedLocation = publishedTextParts?.[2]?.slice(0, 100) || null;
  const missingFields = ["like", "collect", "comment", "share", "followers", "noteCount"]
    .filter((key) => metrics[key] === null).map((key) => ({ field: key, reason: evidence[key]?.missingReason }));

  return {
    parserVersion: 2,
    pageType,
    title: title.slice(0, 200),
    sourceUrl: sourceUrl.slice(0, 2_000),
    body,
    bodyExcerpt: body.slice(0, 400),
    author,
    observedAt: new Date().toISOString(),
    metrics,
    profile,
    profileNotes,
    evidence,
    missingFields,
    images,
    imageStatus,
    comments,
    publishedAt,
    publishedLocation,
    hasSelection: selection.length > 0,
    warnings: pageType === "note" && imageStatus.state !== "ready" ? [imageStatus.reason] : [],
  };
})();
