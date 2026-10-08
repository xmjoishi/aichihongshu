// Shared content-first preview and capture payload for the popup and read-only tab.
(() => {
  const METRICS = {
    note: [["like", "赞"], ["collect", "藏"], ["comment", "评"], ["share", "转发"]],
    profile: [["followers", "粉丝"], ["follows", "关注"], ["noteCount", "笔记"]],
  };

  function selectedSet(values) {
    return new Set((Array.isArray(values) ? values : [])
      .map(Number).filter((value) => Number.isInteger(value) && value >= 0));
  }

  function buildModel(parsed, options = {}) {
    const pageType = options.pageType || parsed?.pageType || "web";
    const clipKind = options.clipKind || (pageType === "profile" ? "account" : "note");
    const modules = options.modules || { collect: {}, data: {} };
    const collect = modules.collect || {};
    const data = modules.data || {};
    const imageSelection = selectedSet(options.selectedImageIndexes);
    const commentSelection = selectedSet(options.selectedCommentIndexes);
    const previous = options.pageContext?.lastSnapshotMetrics || null;
    const metricEntries = (METRICS[pageType] || []).map(([key, label]) => [key, key === "comment" ? "评论总数" : label]);
    return {
      batchId: String(options.batchId || ""),
      pageType,
      clipKind,
      title: String(parsed?.title || ""),
      author: String(parsed?.author || ""),
      sourceUrl: String(parsed?.sourceUrl || ""),
      body: pageType === "profile" ? "" : String(parsed?.body || parsed?.bodyExcerpt || ""),
      bodyIncluded: pageType !== "profile" && Boolean(collect.titleBody),
      profile: parsed?.profile && typeof parsed.profile === "object" ? parsed.profile : null,
      profileNotes: (Array.isArray(parsed?.profileNotes) ? parsed.profileNotes : []).slice(0, 30),
      metricsIncluded: Boolean(data.metrics),
      publishedAt: parsed?.publishedAt == null ? "" : String(parsed.publishedAt),
      publishedLocation: parsed?.publishedLocation == null ? "" : String(parsed.publishedLocation),
      publishedIncluded: Boolean(data.publishedAt),
      observedAt: parsed?.observedAt == null ? "" : String(parsed.observedAt),
      lastSnapshotAt: String(options.pageContext?.lastSnapshotAt || ""),
      pageContext: options.pageContext || null,
      imageStatus: parsed?.imageStatus || null,
      imageModuleEnabled: Boolean(collect.images),
      commentModuleEnabled: Boolean(collect.comments),
      metrics: metricEntries.map(([key, label]) => ({
        key,
        label,
        value: Number.isFinite(parsed?.metrics?.[key]) ? parsed.metrics[key] : null,
        previous: Number.isFinite(previous?.[key]) ? previous[key] : null,
      })),
      images: (Array.isArray(parsed?.images) ? parsed.images : []).slice(0, 12).map((image, index) => ({
        ...image,
        index,
        selected: imageSelection.has(index),
        included: Boolean(collect.images && imageSelection.has(index)),
      })),
      comments: (Array.isArray(parsed?.comments) ? parsed.comments : []).slice(0, 20).map((comment, index) => ({
        ...comment,
        index,
        selected: commentSelection.has(index),
        included: Boolean(collect.comments && commentSelection.has(index)),
      })),
    };
  }

  function buildCaptureMessage(parsed, options = {}) {
    const pageType = options.pageType || parsed?.pageType || "web";
    const modules = options.modules || { collect: {}, data: {} };
    const imageSelection = selectedSet(options.selectedImageIndexes);
    const commentSelection = selectedSet(options.selectedCommentIndexes);
    const clipKind = options.clipKind || (pageType === "profile" ? "account" : "note");
    const imageOnly = clipKind === "material";
    const images = (Array.isArray(parsed?.images) ? parsed.images : [])
      .filter((_, index) => imageSelection.has(index)).slice(0, 12);
    const comments = (Array.isArray(parsed?.comments) ? parsed.comments : [])
      .filter((_, index) => commentSelection.has(index)).slice(0, 20);
    const dataMetrics = Boolean(modules.data?.metrics);
    const publishedIncluded = Boolean(modules.data?.publishedAt);
    const collect = {
      titleBody: !imageOnly && Boolean(modules.collect?.titleBody),
      authorSource: Boolean(modules.collect?.authorSource),
      images: (pageType === "note" || imageOnly) && Boolean(modules.collect?.images) && images.length > 0,
      comments: pageType === "note" && Boolean(modules.collect?.comments) && comments.length > 0,
    };
    const data = {
      metrics: dataMetrics && pageType !== "web",
      publishedAt: publishedIncluded && pageType !== "web",
    };
    const kind = options.kind || "clip";
    return {
      kind,
      pageType,
      materialType: clipKind === "account" ? "profile_material"
        : clipKind === "material" ? "image_material"
          : pageType === "note" ? "note_material" : "web_material",
      clipKind,
      imageTransferProtocol: collect.images,
      title: String(imageOnly ? (parsed?.title || "图片素材")
        : clipKind === "account" ? (parsed?.author || parsed?.title || "主页账号") : (parsed?.title || "")),
      sourceUrl: String(parsed?.sourceUrl || ""),
      body: collect.titleBody && pageType !== "profile" ? String(parsed?.body || "") : "",
      bodyExcerpt: collect.titleBody ? String(parsed?.bodyExcerpt || "") : "",
      evidence: parsed?.evidence || {},
      missingFields: parsed?.missingFields || [],
      publishedAt: data.publishedAt ? (parsed?.publishedAt || null) : null,
      publishedLocation: data.publishedAt ? (parsed?.publishedLocation || null) : null,
      images: collect.images ? images : [],
      comments: collect.comments ? comments : [],
      author: collect.authorSource || clipKind === "account" ? String(parsed?.author || "") : "",
      like: data.metrics ? (parsed?.metrics?.like ?? null) : null,
      collect: data.metrics ? (parsed?.metrics?.collect ?? null) : null,
      comment: data.metrics ? (parsed?.metrics?.comment ?? null) : null,
      share: data.metrics ? (parsed?.metrics?.share ?? null) : null,
      followers: data.metrics ? (parsed?.metrics?.followers ?? null) : null,
      noteCount: data.metrics ? (parsed?.metrics?.noteCount ?? null) : null,
      profile: pageType === "profile" ? (parsed?.profile ?? null) : null,
      pageMetrics: pageType === "profile" || pageType === "note" ? (parsed?.metrics ?? {}) : {},
      observedAt: parsed?.observedAt,
      modules: { collect, data },
      protocolVersion: Number(options.protocolVersion || 0),
      requestId: String(options.requestId || ""),
      targetAccountId: Number(options.targetAccountId || 0),
      extensionVersion: String(options.extensionVersion || ""),
    };
  }

  function append(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    parent.append(element);
    return element;
  }

  function formatCount(value) {
    return value == null ? "未知" : new Intl.NumberFormat("zh-CN").format(value);
  }

  function safeHttpsImage(raw) {
    try {
      const url = new URL(String(raw || ""));
      return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }

  function originLabel(raw, pageType) {
    if (pageType === "profile") return "小红书主页";
    try {
      const url = new URL(raw);
      return url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com")
        ? "小红书笔记" : "普通网页文章";
    } catch { return pageType === "note" ? "网页笔记" : "网页素材"; }
  }

  function observedLabel(raw) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? "采集时间未知"
      : `采集于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
  }

  function addMetricRow(root, metrics, model) {
    if (!metrics.length) return;
    const grid = append(root, "div", "clip-metrics");
    for (const metric of metrics) {
      const card = append(grid, "div", "clip-metric");
      append(card, "span", "clip-muted", metric.label);
      append(card, "strong", "", formatCount(metric.value));
      if (model.metricsIncluded && model.lastSnapshotAt) {
        let delta = "变化未知";
        if (metric.value != null && metric.previous != null) {
          const amount = metric.value - metric.previous;
          delta = `较上次 ${amount > 0 ? "+" : ""}${formatCount(amount)}`;
        }
        append(card, "span", "clip-muted", delta);
      }
    }
  }

  function appendImage(parent, rawUrl, alt, className = "") {
    const image = append(parent, "img", className);
    image.alt = alt;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    const src = safeHttpsImage(rawUrl);
    if (src) image.src = src;
    else image.hidden = true;
    image.addEventListener("error", () => { image.hidden = true; });
    return image;
  }

  function appendImageControls(parent, model, handlers, currentIndex) {
    const controls = append(parent, "div", "image-selection-toolbar");
    const selected = model.images.filter((image) => image.selected).length;
    append(controls, "span", "image-selection-count", `已选 ${selected} / ${model.images.length} 张`);
    const actions = append(controls, "div", "image-selection-actions");
    const selectAll = append(actions, "button", "inline-action", "全选");
    selectAll.type = "button";
    selectAll.disabled = handlers.interactive !== true;
    selectAll.addEventListener("click", () => handlers.onSelectAllImages?.());
    const clear = append(actions, "button", "inline-action", "清空");
    clear.type = "button";
    clear.disabled = handlers.interactive !== true;
    clear.addEventListener("click", () => handlers.onClearImages?.());
    if (currentIndex != null) append(controls, "span", "clip-muted", `图片 ${currentIndex + 1} / ${model.images.length}`);
  }

  function appendImageToggle(parent, image, handlers) {
    const label = append(parent, "label", "image-thumb");
    label.classList.toggle("is-selected", image.selected);
    const checkbox = append(label, "input", "");
    checkbox.type = "checkbox";
    checkbox.checked = image.selected;
    checkbox.disabled = handlers.interactive !== true;
    checkbox.setAttribute("aria-label", `选择第 ${image.index + 1} 张图片`);
    checkbox.addEventListener("change", () => handlers.onImageToggle?.(image.index, checkbox.checked));
    appendImage(label, image.url, `图片 ${image.index + 1}`, "clip-thumbnail");
    const number = append(label, "span", "thumb-number", String(image.index + 1));
    number.setAttribute("aria-hidden", "true");
  }

  function appendNoteImages(root, model, handlers) {
    const currentIndex = model.images.length
      ? Math.max(0, Math.min(model.images.length - 1, Number(handlers.activeImageIndex) || 0)) : null;
    appendImageControls(root, model, handlers, currentIndex);
    if (!model.images.length) {
      append(root, "div", "image-empty", model.imageStatus?.reason || "当前页面没有可保存图片");
      return;
    }
    const current = model.images[currentIndex];
    const stage = append(root, "div", "image-stage");
    const previous = append(stage, "button", "image-nav previous", "‹");
    previous.type = "button";
    previous.setAttribute("aria-label", "上一张");
    previous.disabled = handlers.interactive !== true || model.images.length < 2;
    previous.addEventListener("click", () => handlers.onImageNavigate?.(-1));
    appendImage(stage, current.url, `图片 ${currentIndex + 1}`, "image-stage-img");
    const next = append(stage, "button", "image-nav next", "›");
    next.type = "button";
    next.setAttribute("aria-label", "下一张");
    next.disabled = handlers.interactive !== true || model.images.length < 2;
    next.addEventListener("click", () => handlers.onImageNavigate?.(1));
    const selectCurrent = append(stage, "label", "stage-selection");
    const currentCheckbox = append(selectCurrent, "input", "");
    currentCheckbox.type = "checkbox";
    currentCheckbox.checked = current.selected;
    currentCheckbox.disabled = handlers.interactive !== true;
    currentCheckbox.setAttribute("aria-label", `选择第 ${currentIndex + 1} 张图片`);
    currentCheckbox.addEventListener("change", () => handlers.onImageToggle?.(currentIndex, currentCheckbox.checked));
    append(selectCurrent, "span", "", current.selected ? "保留这张原图" : "不保存这张图");
    const thumbnails = append(root, "div", "image-thumbnails");
    thumbnails.setAttribute("role", "group");
    thumbnails.setAttribute("aria-label", "选择要保存的图片");
    for (const image of model.images) {
      const item = append(thumbnails, "div", `thumbnail-item${image.index === currentIndex ? " is-current" : ""}`);
      const thumb = append(item, "button", "thumbnail-activate", "");
      thumb.type = "button";
      thumb.setAttribute("aria-label", `预览第 ${image.index + 1} 张图片`);
      thumb.addEventListener("click", () => handlers.onImageActive?.(image.index));
      appendImage(thumb, image.url, `图片 ${image.index + 1}`, "clip-thumbnail");
      const toggle = append(item, "label", "thumbnail-toggle");
      const checkbox = append(toggle, "input", "");
      checkbox.type = "checkbox";
      checkbox.checked = image.selected;
      checkbox.disabled = handlers.interactive !== true;
      checkbox.setAttribute("aria-label", `选择第 ${image.index + 1} 张图片`);
      checkbox.addEventListener("change", () => handlers.onImageToggle?.(image.index, checkbox.checked));
      append(toggle, "span", "", `${image.index + 1}`);
    }
  }

  function appendMaterialGrid(root, model, handlers) {
    appendImageControls(root, model, handlers, null);
    if (!model.images.length) {
      append(root, "div", "image-empty", model.imageStatus?.reason || "当前页面没有可保存素材");
      return;
    }
    const grid = append(root, "div", "material-image-grid");
    for (const image of model.images) appendImageToggle(grid, image, handlers);
  }

  function appendComments(root, model, handlers) {
    const details = append(root, "details", "comment-disclosure");
    details.open = handlers.commentsOpen === true;
    details.addEventListener("toggle", () => handlers.onCommentsToggle?.(details.open));
    const summary = append(details, "summary", "comment-summary");
    const selected = model.comments.filter((comment) => comment.selected).length;
    append(summary, "strong", "", "评论摘录");
    append(summary, "span", "clip-muted", `${model.comments.length} 条已加载 · ${selected} 条已选 · 默认不保存`);
    if (!model.comments.length) {
      append(details, "p", "image-empty", "当前页面没有已加载的评论片段");
      return;
    }
    const list = append(details, "div", "comment-list");
    for (const comment of model.comments) {
      const card = append(list, "article", "comment-card");
      const label = append(card, "label", "comment-toggle");
      const checkbox = append(label, "input", "");
      checkbox.type = "checkbox";
      checkbox.checked = comment.selected;
      checkbox.disabled = handlers.interactive !== true;
      checkbox.setAttribute("aria-label", `选择评论 ${comment.index + 1}`);
      checkbox.addEventListener("change", () => handlers.onCommentToggle?.(comment.index, checkbox.checked));
      append(label, "strong", "", `${comment.author || "匿名用户"}${comment.likes == null ? "" : ` · 赞 ${formatCount(comment.likes)}`}`);
      append(card, "p", "comment-text", `${comment.text || ""}${comment.truncated ? "…（已截断）" : ""}`);
    }
  }

  function appendProfileNotes(root, model, handlers) {
    const details = append(root, "details", "profile-note-picker");
    details.open = handlers.profileNotesOpen === true;
    details.addEventListener("toggle", () => handlers.onProfileNotesToggle?.(details.open));
    const summary = append(details, "summary", "comment-summary");
    append(summary, "strong", "", "选择主页笔记");
    append(summary, "span", "clip-muted", `${model.profileNotes.length} 篇主页当前可见笔记 · 逐篇单独剪藏`);
    if (!model.profileNotes.length) {
      append(details, "p", "image-empty", "当前页面没有可识别笔记卡片；可返回主页重新打开插件解析。");
      return;
    }
    const list = append(details, "ol", "profile-note-list");
    for (const note of model.profileNotes) {
      const row = append(list, "li", "profile-note-row");
      const info = append(row, "div", "profile-note-info");
      append(info, "strong", "", note.title || "未命名笔记");
      append(info, "span", "clip-muted", [
        note.likes == null ? "赞未知" : `赞 ${formatCount(note.likes)}`,
        note.collects == null ? "藏未知" : `藏 ${formatCount(note.collects)}`,
        note.comments == null ? "评未知" : `评 ${formatCount(note.comments)}`,
      ].join(" · "));
      const open = append(row, "button", "inline-action", "单独剪藏 ↗");
      open.type = "button";
      open.disabled = handlers.interactive !== true;
      open.addEventListener("click", () => handlers.onProfileNoteOpen?.(note.noteUrl));
    }
  }

  function render(root, model, handlers = {}) {
    const priorScroll = root.scrollTop;
    root.replaceChildren();
    root.setAttribute("aria-label", "当前页面剪藏预览");
    const account = model.clipKind === "account" || model.pageType === "profile";

    if (account) {
      const profile = model.profile || {};
      const card = append(root, "section", "account-preview");
      const avatar = append(card, "div", "account-avatar");
      append(avatar, "span", "avatar-fallback", (model.author || model.title || "账").slice(0, 1));
      const avatarUrl = safeHttpsImage(profile.avatarUrl);
      if (avatarUrl) {
        const image = append(avatar, "img", "account-avatar-img");
        image.alt = `${model.author || "作者"}头像`;
        image.src = avatarUrl;
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => { image.hidden = true; });
      }
      const info = append(card, "div", "account-info");
      append(info, "span", "source-badge", originLabel(model.sourceUrl, "profile"));
      append(info, "h1", "clip-title", model.author || model.title || "未识别主页昵称");
      if (profile.bio) append(info, "p", "clip-body profile-bio", profile.bio);
      const profileFacts = [];
      if (profile.ipLocation) profileFacts.push(`IP 属地 ${profile.ipLocation}`);
      if (Array.isArray(profile.tags) && profile.tags.length) profileFacts.push(profile.tags.join("、"));
      if (profileFacts.length) append(info, "p", "clip-muted profile-facts", profileFacts.join(" · "));
      addMetricRow(info, model.metrics, model);
      appendProfileNotes(root, model, handlers);
    } else {
      const columns = append(root, "div", `clip-columns${model.clipKind === "material" ? " is-material" : ""}`);
      const media = append(columns, "section", "clip-media");
      if (model.clipKind === "material") appendMaterialGrid(media, model, handlers);
      else if (model.pageType === "note") appendNoteImages(media, model, handlers);
      else append(media, "div", "image-empty", model.images.length
        ? `文章中识别到 ${model.images.length} 张配图。调整为“素材剪藏”后可单独选择并保存原图。`
        : "普通网页文章按正文剪藏；如需单独保存图片，请选择“素材剪藏”。");

      const content = append(columns, "section", "clip-details");
      append(content, "span", "source-badge", originLabel(model.sourceUrl, model.pageType));
      append(content, "h1", "clip-title", model.title || "（未识别标题）");
      const sourceLine = append(content, "div", "clip-source-line");
      append(sourceLine, "strong", "", model.author || "作者未知");
      let sourceHost = model.sourceUrl;
      try { sourceHost = new URL(model.sourceUrl).host; } catch { /* keep original text */ }
      append(sourceLine, "span", "clip-muted", sourceHost || "来源未知");
      const body = append(content, "p", "clip-body", model.body || (model.clipKind === "material" ? "单独保存所选图片素材。" : "页面正文未识别。"));
      body.classList.toggle("is-empty", !model.body);
      if (!model.bodyIncluded && model.clipKind !== "material") {
        append(content, "p", "clip-muted", "未开启标题与正文摘要；预览内容不会保存。");
      }
      addMetricRow(content, model.metrics, model);
      const facts = [];
      if (model.publishedAt) facts.push(`发布于 ${model.publishedAt}${model.publishedLocation ? ` · ${model.publishedLocation}` : ""}`);
      facts.push(observedLabel(model.observedAt));
      append(content, "p", "clip-meta-line", facts.join(" · "));
      appendComments(content, model, handlers);
    }
    root.scrollTop = priorScroll;
  }

  globalThis.AichiCapturePreview = Object.freeze({ buildModel, buildCaptureMessage, render });
})();
