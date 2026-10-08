import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const parser = fs.readFileSync(path.join(root, "browser-extension/extract.js"), "utf8");

function node(text = "", {
  className = "", attrs = {}, selectors = {}, lists = {}, width = 0, height = 0,
  naturalWidth = width, naturalHeight = height, parent = null, url = "", tagName = url ? "IMG" : "DIV",
  style = {}, rect = null, alt = "",
} = {}) {
  return {
    innerText: text,
    textContent: text,
    selectors,
    className,
    lists,
    tagName,
    naturalWidth,
    naturalHeight,
    width,
    height,
    currentSrc: url,
    src: url,
    alt,
    style,
    parentElement: parent,
    getAttribute(name) { return attrs[name] ?? null; },
    querySelector(selector) { return selectors[selector] ?? null; },
    querySelectorAll(selector) {
      if (selector === 'img,[style*="background-image"]') return this.lists[selector] ?? this.lists.img ?? [];
      return this.lists[selector] ?? [];
    },
    getBoundingClientRect() { return rect || { width, height }; },
  };
}

function parsePage({ url, title, bodyText, selectors = {}, lists = {}, queryLog = null }) {
  const document = {
    title,
    body: node(bodyText),
    querySelector(selector) { return selectors[selector] ?? null; },
    querySelectorAll(selector) {
      queryLog?.push(selector);
      if (selector === 'img,[style*="background-image"]') return lists[selector] ?? lists.img ?? [];
      return lists[selector] ?? [];
    },
  };
  const parsedUrl = new URL(url);
  return vm.runInNewContext(parser, {
    document,
    location: { href: url, hostname: parsedUrl.hostname, pathname: parsedUrl.pathname },
    window: { getSelection: () => "" },
    URL,
    Date,
  });
}

const labelCounter = (text) => node(text);
const selectedRoot = node("产品体验笔记。正文里有赞99999、收藏888、评论777，数字不能当互动量。", {
  lists: {
    img: [
      node("", { width: 900, height: 1200, url: "https://sns-img-bd.xhscdn.com/cover/1.jpg" }),
      node("", { className: "avatar", width: 40, height: 40, url: "https://sns-img-bd.xhscdn.com/avatar/2.jpg" }),
      node("", { width: 800, height: 900, url: "https://127.0.0.1:443/private.jpg" }),
    ],
  },
});
const longComment = "评论内容".repeat(110);
const commentNode = node(longComment, {
  className: "comment-item",
  selectors: {
    '[class*="content"]': node(longComment),
    '[class*="user-name"]': node("读者A"),
  },
});
const actionCommentTotal = node("评论 13", { className: "comment-count" });
const actionBar = node("", {
  lists: { '[aria-label],button,[class*="comment-count"],[class*="commentCount"]': [actionCommentTotal] },
});
selectedRoot.selectors['[class*="interact"]'] = actionBar;
selectedRoot.lists['[aria-label],button,[class*="comment-count"],[class*="commentCount"]'] = [
  actionCommentTotal,
  node("评论 1", { className: "comment-count", parent: commentNode }),
];
const note = parsePage({
  url: "https://www.xiaohongshu.com/explore/abc123",
  title: "体验记录 - 小红书",
  bodyText: "赞99999 收藏888 评论777",
  rootNode: selectedRoot,
  selectors: {
    '[class*="note-content"]': selectedRoot,
    '[class*="author"] [class*="name"]': node("作者甲"),
    '[class*="like-count"]': labelCounter("1.2万"),
    '[class*="collect-count"]': labelCounter("2.5k"),
    '[class*="share-count"]': labelCounter("转发 17"),
  },
  lists: {
    '[class*="comment-item"],[class*="commentItem"],[data-testid*="comment"]': [commentNode],
  },
});
assert.equal(note.pageType, "note");
assert.equal(note.title, "体验记录");
assert.equal(note.author, "作者甲");
assert.equal(note.metrics.like, 12_000);
assert.equal(note.metrics.collect, 2_500);
assert.equal(note.metrics.share, 17, "share counts are read only from an explicitly labeled visible counter");
assert.equal(note.metrics.comment, 13, "the action bar's total comment count wins over a comment row's count");
assert.equal(note.images.length, 1, "avatar and private IP image references are excluded");
assert.equal(note.images[0].url, "https://sns-img-bd.xhscdn.com/cover/1.jpg");
assert.equal(note.imageStatus.state, "ready");
assert.equal(note.comments.length, 1);
assert.equal(note.metrics.comment, 13, "total comments are distinct from the one loaded comment excerpt");
assert.equal(note.comments[0].text.length, 350);
assert.equal(note.comments[0].truncated, true);
assert.ok(!note.missingFields.some((field) => field.field === "comment"));

const unknownComment = parsePage({
  url: "https://www.xiaohongshu.com/explore/unknown-comment-count",
  title: "评论数不可见",
  bodyText: "正文文字中提到评论13，不代表页面计数。",
  selectors: { '[class*="note-content"]': node("正文文字中提到评论13，不代表页面计数。") },
});
assert.equal(unknownComment.metrics.comment, null, "missing total stays unknown instead of counting loaded excerpts or body text");

const published = parsePage({
  url: "https://www.xiaohongshu.com/explore/published-location",
  title: "发布时间与属地",
  bodyText: "正文",
  selectors: {
    '[class*="note-content"]': node("正文"),
    '[class*="publish-time"]': node("09-15 四川"),
  },
});
assert.equal(published.publishedAt, "09-15", "do not invent a year for month-day dates");
assert.equal(published.publishedLocation, "四川");

const profileRoot = node("粉丝 2.1万 笔记 58 关注 320 IP属地 上海", {
  selectors: {
    '[class*="user-info"] [class*="name"]': node("创作者甲"),
    '[class*="avatar"] img': node("", { url: "https://sns-img-bd.xhscdn.com/avatar/creator.jpg" }),
    '[class*="user-desc"]': node("分享生活灵感"),
  },
  lists: {
    '[aria-label],button,[class*="count"],[class*="stat"]': [node("粉丝 2.1万"), node("笔记 58"), node("关注 320")],
    '[class*="tag"],[class*="label"]': [node("#家居"), node("生活方式"), node("家居")],
  },
});
const profileCard = node("日常收纳 | 简单整理", {
  tagName: "A",
  attrs: { href: "https://www.xiaohongshu.com/explore/profile-note-1" },
  selectors: {
    '[class*="title"]': node("日常收纳"),
    '[class*="desc"]': node("简单整理空间的日常记录"),
  },
});
const profileFeed = node("", { lists: { 'a[href*="/explore/"],a[href*="/discovery/item/"]': [profileCard] } });
const profile = parsePage({
  url: "https://www.xiaohongshu.com/user/profile/user-01",
  title: "创作者主页 - 小红书",
  bodyText: "粉丝 2.1万 笔记 58 关注 320 IP属地 上海",
  selectors: { '[class*="profile"]': profileRoot, '[class*="feeds-container"]': profileFeed },
});
assert.equal(profile.pageType, "profile");
assert.equal(profile.metrics.followers, 21_000);
assert.equal(profile.metrics.noteCount, 58);
assert.equal(profile.profile.avatarUrl, "https://sns-img-bd.xhscdn.com/avatar/creator.jpg");
assert.equal(profile.profile.bio, "分享生活灵感");
assert.equal(profile.profile.follows, 320);
assert.equal(profile.profile.ipLocation, "上海");
assert.deepEqual(Array.from(profile.profile.tags), ["家居", "生活方式"]);
assert.equal(profile.body, "", "profile note cards are never concatenated into profile body");
assert.equal(profile.profileNotes.length, 1);
assert.equal(profile.profileNotes[0].title, "日常收纳");

const web = parsePage({
  url: "https://example.com/article",
  title: "普通文章",
  bodyText: "赞 99 收藏 88 评论 77，2024 年发布。",
});
assert.equal(web.pageType, "web");
assert.equal(web.metrics.like, null);
assert.equal(web.metrics.collect, null);
assert.equal(web.metrics.comment, null);
assert.equal(web.images.length, 0);

const articleImage = node("", { width: 1_200, height: 800, url: "https://images.example.org/article-photo.jpg" });
const articleAvatar = node("", { width: 48, height: 48, url: "https://images.example.org/author-avatar.jpg" });
const articlePrivate = node("", { width: 1_200, height: 800, url: "https://192.168.1.9/private.jpg" });
const articleRecommendations = node("", {
  className: "recommendation-list",
  lists: { img: [node("", { width: 1_200, height: 800, url: "https://images.example.org/recommended.jpg" })] },
});
const articleRoot = node("文章正文", {
  className: "article-content",
  lists: { img: [articleImage, articleAvatar, articlePrivate] },
});
articleImage.parentElement = articleRoot;
articleAvatar.parentElement = articleRoot;
articlePrivate.parentElement = articleRoot;
articleRoot.lists.img.push(...articleRecommendations.lists.img);
articleRecommendations.lists.img[0].parentElement = articleRecommendations;
const webWithImages = parsePage({
  url: "https://example.com/article-with-images",
  title: "图文文章",
  bodyText: "文章正文",
  selectors: { article: articleRoot },
});
assert.equal(webWithImages.pageType, "web");
assert.equal(webWithImages.images.length, 1, "only loaded, public, article-scoped pictures are selectable for material clipping");
assert.equal(webWithImages.images[0].url, articleImage.currentSrc);
assert.equal(webWithImages.imageStatus.state, "ready");

const imageContainerSelector = [
  "#detail-img-container", "#detail-image", '[class*="swiper-wrapper"]', '[class*="carousel"]',
  '[class*="slider"]', '[class*="note-image"]', '[class*="note-img"]', '[class*="image-list"]',
  '[class*="img-list"]', '[class*="detail-image"]',
].join(",");
const detailScope = node("", { className: "note-detail", lists: { [imageContainerSelector]: [] } });
const noteTextOutsideCarousel = node("正文区域", { className: "note-content", parent: detailScope });
const mainImage = node("", {
  parent: null,
  width: 900,
  height: 1200,
  url: "https://sns-img-bd.xhscdn.com/cover/main.jpg",
});
const srcsetImage = node("", {
  parent: null,
  width: 800,
  height: 1000,
  url: "",
  attrs: { srcset: "https://sns-img-bd.xhscdn.com/cover/low.jpg 1x, https://sns-img-bd.xhscdn.com/cover/high.jpg 2x" },
});
const duplicateImage = node("", {
  parent: null,
  width: 900,
  height: 1200,
  url: "https://sns-img-bd.xhscdn.com/cover/main.jpg",
});
const recommendation = node("", {
  className: "recommend-swiper-wrapper",
  lists: { img: [node("", { width: 900, height: 1200, url: "https://sns-img-bd.xhscdn.com/recommend/1.jpg" })] },
});
const currentCarousel = node("", {
  className: "swiper-wrapper note-image-list",
  parent: detailScope,
  lists: { img: [mainImage, srcsetImage, duplicateImage] },
});
mainImage.parentElement = currentCarousel;
srcsetImage.parentElement = currentCarousel;
duplicateImage.parentElement = currentCarousel;
detailScope.lists[imageContainerSelector] = [recommendation, currentCarousel];
assert.equal(mainImage.tagName, "IMG");
assert.equal(srcsetImage.tagName, "DIV");
srcsetImage.tagName = "IMG";
duplicateImage.tagName = "IMG";
const siblingScopeQueries = [];
const siblingCarouselNote = parsePage({
  url: "https://www.xiaohongshu.com/explore/note-with-sibling-carousel",
  title: "正文和图片分离 - 小红书",
  bodyText: "正文在详情描述区",
  selectors: { "#detail-desc": noteTextOutsideCarousel },
  queryLog: siblingScopeQueries,
  // A page-level recommendation is present but must never be searched for the current note.
  lists: {
    [imageContainerSelector]: [node("", {
      className: "recommend-carousel",
      lists: { img: [node("", { width: 900, height: 1200, url: "https://sns-img-bd.xhscdn.com/recommend/page-level.jpg" })] },
    })],
    '[class*="comment-item"],[class*="commentItem"],[data-testid*="comment"]': [],
  },
});
assert.equal(siblingCarouselNote.images.length, 2, "detail carousel siblings are searched and duplicate image URLs are removed");
assert.deepEqual(Array.from(siblingCarouselNote.images.map((image) => image.url)), [
  "https://sns-img-bd.xhscdn.com/cover/main.jpg",
  "https://sns-img-bd.xhscdn.com/cover/high.jpg",
]);
assert.equal(siblingCarouselNote.images[0].domIndex, 0);
assert.equal(siblingCarouselNote.images[0].source, "visible-note-image");
assert.ok(!siblingScopeQueries.includes(imageContainerSelector), "image container discovery never queries document scope");
assert.ok(!siblingScopeQueries.includes('img,[style*="background-image"]'), "document-level images are never scanned");

const lazyImage = node("", {
  width: 900,
  height: 1200,
  naturalWidth: 0,
  naturalHeight: 0,
  url: "https://sns-img-bd.xhscdn.com/cover/lazy.jpg",
});
const lazyDetail = node("", { className: "note-detail" });
const lazyCarousel = node("", { className: "note-image-carousel", parent: lazyDetail, lists: { img: [lazyImage] } });
lazyDetail.lists = { [imageContainerSelector]: [lazyCarousel] };
const lazy = parsePage({
  url: "https://www.xiaohongshu.com/explore/lazy",
  title: "懒加载 - 小红书",
  bodyText: "正文",
  selectors: { "#detail-desc": node("正文", { parent: lazyDetail }) },
  lists: { [imageContainerSelector]: [lazyCarousel] },
});
assert.equal(lazy.images.length, 0);
assert.equal(lazy.imageStatus.state, "not-loaded");

const rejectedDetail = node("", { className: "note-detail" });
const rejectedCarousel = node("", {
  className: "note-image-carousel",
  parent: rejectedDetail,
  lists: { img: [node("", { width: 900, height: 1200, url: "http://127.0.0.1/private.jpg" })] },
});
rejectedDetail.lists = { [imageContainerSelector]: [rejectedCarousel] };
const rejected = parsePage({
  url: "https://www.xiaohongshu.com/explore/rejected",
  title: "不安全图片 - 小红书",
  bodyText: "正文",
  selectors: { "#detail-desc": node("正文", { parent: rejectedDetail }) },
});
assert.equal(rejected.imageStatus.state, "rejected-url");

const backgroundDetail = node("", { className: "note-detail" });
const backgroundCarousel = node("", {
  className: "note-image-carousel",
  parent: backgroundDetail,
  lists: {
    'img,[style*="background-image"]': [node("", {
      className: "note-image-slide",
      style: { backgroundImage: 'url("https://sns-img-bd.xhscdn.com/cover/background.jpg")' },
      rect: { width: 640, height: 640 },
    })],
  },
});
backgroundDetail.lists = { [imageContainerSelector]: [backgroundCarousel] };
const background = parsePage({
  url: "https://www.xiaohongshu.com/explore/background",
  title: "背景轮播 - 小红书",
  bodyText: "正文",
  selectors: { "#detail-desc": node("正文", { parent: backgroundDetail }) },
  lists: { [imageContainerSelector]: [backgroundCarousel] },
});
assert.equal(background.images.length, 1);
assert.equal(background.images[0].source, "visible-note-background");
assert.equal(background.images[0].width, 640);

const emptyDetail = node("", { className: "note-detail", lists: { [imageContainerSelector]: [] } });
const emptyCarousel = node("", { className: "note-image-carousel", parent: emptyDetail, lists: { img: [] } });
emptyDetail.lists[imageContainerSelector] = [emptyCarousel];
const emptyLoaded = parsePage({
  url: "https://www.xiaohongshu.com/explore/empty-loaded",
  title: "空图片区 - 小红书",
  bodyText: "正文",
  selectors: { "#detail-desc": node("正文", { parent: emptyDetail }) },
});
assert.equal(emptyLoaded.imageStatus.state, "no-image", "recognized carousel with zero loaded images gets its own reason");

const noContainerDetail = node("", { className: "note-detail", lists: { [imageContainerSelector]: [] } });
const noContainer = parsePage({
  url: "https://www.xiaohongshu.com/explore/no-container",
  title: "没有图片区容器 - 小红书",
  bodyText: "正文",
  selectors: { "#detail-desc": node("正文", { parent: noContainerDetail }) },
});
assert.equal(noContainer.imageStatus.state, "container-not-found", "no recognized carousel is distinguished from an empty carousel");

const unsupported = parsePage({
  url: "https://www.xiaohongshu.com/explore/unsupported",
  title: "结构不支持 - 小红书",
  bodyText: "正文",
});
assert.equal(unsupported.imageStatus.state, "unsupported-structure");

console.log(JSON.stringify({ ok: true, fixtures: [
  "xhs-note", "xhs-profile", "ordinary-web", "sibling-carousel-srcset-dedupe", "lazy-image",
  "rejected-image-url", "evidenced-background-image", "empty-carousel", "missing-image-container", "unsupported-image-structure",
] }));
