import { useEffect, useMemo, useRef, useState } from "react";import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Lightbulb,
  Sparkles,
  Save,
  RefreshCw,
  ImagePlus,
  Users,
  TrendingUp,
  X,
} from "lucide-react";
import { api, fetchTopics, inspireStream, type InspireParams } from "../lib/api";
import { Item, ReferenceAccount, Insights, Note } from "../lib/types";
import { Empty } from "../components/ui";
import { useToast } from "../components/Toast";

type TopicItem = { word: string; count: number };
type RefPost = { title: string; likes: number; url?: string };

type DraftParts = {
  titles: string[];
  body: string;
  cta: string;
  tags: string[];
};

function parseDraft(raw: string): DraftParts {
  const getSection = (name: string, next: string[]) => {
    const nextGuard = next.map((n) => `---${n}---`).join("|");
    const pattern = new RegExp(`---${name}---\\n([\\s\\S]*?)(?=${nextGuard || "$"}|$)`);
    return raw.match(pattern)?.[1]?.trim() ?? "";
  };

  const titles = getSection("标题候选", ["正文", "互动引导", "话题标签"])
    .split("\n")
    .map((s) => s.replace(/^[\s\-\d\.\)、]+/, "").trim())
    .filter(Boolean);
  const body = getSection("正文", ["互动引导", "话题标签"]);
  const cta = getSection("互动引导", ["话题标签"]);
  const tagsText = getSection("话题标签", []);
  const tags = tagsText
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("#"));

  return { titles, body, cta, tags };
}

function shuffleTake<T>(arr: T[], count: number): T[] {
  if (!arr.length) return [];
  const cloned = [...arr];
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned.slice(0, Math.min(count, cloned.length));
}

function pickRelatedImages(allItems: Item[], selectedIds: number[]): Item[] {
  const byId = new Map<number, Item>(allItems.map((x) => [x.id, x]));
  const selected = selectedIds.map((id) => byId.get(id)).filter(Boolean) as Item[];
  if (!selected.length) return [];

  const tokenSet = new Set<string>();
  selected.forEach((it) => {
    [it.style, it.scene, it.color, it.material, ...(it.tags || [])]
      .filter(Boolean)
      .forEach((t) => tokenSet.add(String(t).trim()));
  });
  const tokens = [...tokenSet];

  const extras = allItems
    .filter((it) => !selectedIds.includes(it.id))
    .map((it) => {
      const values = [it.style, it.scene, it.color, it.material, ...(it.tags || [])].filter(Boolean).map(String);
      let score = 0;
      for (const token of tokens) {
        if (values.some((v) => v.includes(token) || token.includes(v))) score += 1;
      }
      return { it, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.it);

  return [...selected, ...extras];
}

export default function Inspire() {
  const { toast } = useToast();

  const [topic, setTopic] = useState("");
  const [selectedTopicWords, setSelectedTopicWords] = useState<string[]>([]);
  const [extraImageDesc, setExtraImageDesc] = useState("");
  const [extraInstruction, setExtraInstruction] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  // 抽屉里标签的选中状态（生成后默认全选，可手动取消）
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const [topicPool, setTopicPool] = useState<TopicItem[]>([]);
  const [itemPool, setItemPool] = useState<Item[]>([]);
  const [accountPool, setAccountPool] = useState<ReferenceAccount[]>([]);

  const [rawResult, setRawResult] = useState("");
  const [selectedTitle, setSelectedTitle] = useState(0);
  const [titleText, setTitleText] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [savedNote, setSavedNote] = useState<Note | null>(null);
  // "closed" | "peek" | "open"
  const [drawerState, setDrawerState] = useState<"closed" | "peek" | "open">("peek");
  const ctrlRef = useRef<AbortController | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [bannerHeight, setBannerHeight] = useState(48);

  useEffect(() => {
    const el = bannerRef.current;
    if (!el) return;
    setBannerHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setBannerHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { data: allItems = [], isLoading: itemsLoading } = useQuery<Item[]>({
    queryKey: ["inspire-items-all"],
    queryFn: () => api.get("/api/library/?offset=0&limit=200"),
  });

  const { data: allAccounts = [], isLoading: accountsLoading } = useQuery<ReferenceAccount[]>({
    queryKey: ["inspire-accounts-all"],
    queryFn: () => api.get("/api/accounts/"),
  });

  const { data: topicsData, refetch: refetchTopics, isFetching: topicsRefreshing } = useQuery<{ topics: TopicItem[] }>({
    queryKey: ["inspire-topics"],
    queryFn: fetchTopics,
  });

  const { data: insights } = useQuery<Insights>({
    queryKey: ["inspire-insights"],
    queryFn: () => api.get("/api/analytics/insights"),
  });

  useEffect(() => {
    if (!topicsData?.topics) return;
    setTopicPool(shuffleTake(topicsData.topics, 12));
  }, [topicsData]);

  useEffect(() => {
    if (!allItems.length) return;
    setItemPool(shuffleTake(allItems, 9));
  }, [allItems]);

  useEffect(() => {
    if (!allAccounts.length) return;
    setAccountPool(shuffleTake(allAccounts, 9));
  }, [allAccounts]);

  const parsed = useMemo(() => parseDraft(rawResult), [rawResult]);

  useEffect(() => {
    setSelectedTitle(0);
    setTitleText(parsed.titles[0] || "");
    setBody(parsed.body + (parsed.cta ? `\n\n${parsed.cta}` : ""));
    setTags(parsed.tags);
    setSelectedTags(parsed.tags); // 生成后标签默认全选
  }, [parsed.body, parsed.cta, parsed.tags, rawResult]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  const selectedTitleText = titleText.trim();

  const insightHints = useMemo(() => {
    if (!insights) return [] as string[];
    const topHour = [...insights.hour_dist].sort((a, b) => b.avg_likes - a.avg_likes)[0];
    const topTag = insights.tag_freq[0];
    const topTitleBucket = [...insights.title_length_dist].sort((a, b) => b.avg_likes - a.avg_likes)[0];
    return [
      topHour ? `历史最佳发布时间：${topHour.hour} 点左右` : "",
      topTag ? `历史高赞标签：#${topTag.tag}` : "",
      topTitleBucket ? `高赞标题常见长度：${topTitleBucket.range}` : "",
    ].filter(Boolean);
  }, [insights]);

  const relatedImages = useMemo(() => pickRelatedImages(allItems, selectedItemIds), [allItems, selectedItemIds]);
  const drawerExpanded = drawerState === "open";
  const hasContent = !!(titleText.trim() || body.trim());

  function toggleId<T extends number | string>(value: T, list: T[], setList: (next: T[]) => void) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  function refreshTopicPool() {
    if (topicsData?.topics?.length) {
      setTopicPool(shuffleTake(topicsData.topics, 12));
      return;
    }
    refetchTopics();
  }

  function refreshItemPool() {
    setItemPool(shuffleTake(allItems, 9));
  }

  function refreshAccountPool() {
    setAccountPool(shuffleTake(allAccounts, 9));
  }

  function clearAll() {
    ctrlRef.current?.abort();
    setTopic("");
    setSelectedTopicWords([]);
    setExtraImageDesc("");
    setExtraInstruction("");
    setSelectedItemIds([]);
    setSelectedAccountIds([]);
    setRawResult("");
    setSelectedTitle(0);
    setTitleText("");
    setBody("");
    setTags([]);
    setSelectedTags([]);
    setSavedNote(null);
    setDrawerState("peek");
  }

  function startGenerate() {
    ctrlRef.current?.abort();
    setSavedNote(null);
    setRawResult("");
    setGenerating(true);
    setDrawerState("open");

    const combinedTopic = [topic.trim(), ...selectedTopicWords.filter(w => !topic.includes(w))].filter(Boolean).join(" / ");
    const params: InspireParams = {
      topic: combinedTopic,
      item_ids: selectedItemIds,
      extra_image_desc: extraImageDesc,
      account_ids: selectedAccountIds,
      extra_instruction: extraInstruction,
    };

    ctrlRef.current = inspireStream(
      params,
      (chunk) => {
        if (typeof chunk.text === "string") {
          setRawResult((prev) => prev + chunk.text);
        }
        if (typeof chunk.error === "string") {
          toast(chunk.error, "error");
          setGenerating(false);
        }
      },
      () => setGenerating(false),
      (err) => {
        toast(err.message || "生成失败", "error");
        setGenerating(false);
      },
    );
  }

  async function saveDraft() {
    if (!selectedTitleText && !body.trim()) {
      toast("先生成一版内容再保存", "warning");
      return;
    }
    try {
      const created = await api.post("/api/content/", {
        title: selectedTitleText || undefined,
        body: body.trim() || undefined,
        tags: selectedTags,
      });
      const note = await api.patch(`/api/content/${created.id}`, {
        title: selectedTitleText || undefined,
        body: body.trim() || undefined,
        tags: selectedTags,
        item_ids: selectedItemIds,
        note_type: selectedItemIds.length > 1 ? "image" : "text",
      });
      setSavedNote(note);
      toast("已保存到笔记草稿", "success");
    } catch (err) {
      toast((err as Error).message || "保存失败", "error");
    }
  }

  function normalizeTopNotes(val: ReferenceAccount["top_notes"]): RefPost[] {
    if (!Array.isArray(val)) return [];
    const result: RefPost[] = [];
    for (const x of val) {
      if (!x || typeof x !== "object") continue;
      const t = x as { title?: string; likes?: number; url?: string };
      if (!t.title) continue;
      result.push({
        title: t.title,
        likes: Number(t.likes || 0),
        url: t.url,
      });
    }
    return result;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── 顶部通栏 Banner（单行紧凑） ── */}
      <div
        ref={bannerRef}
        className="shrink-0 border-b border-[#ffd6de] bg-gradient-to-r from-[#fff4f6] via-white to-[#fff7f3] px-6 py-3"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-[#ff2442]">
            <Sparkles size={18} />
            <h1 className="text-lg font-semibold">灵感梦工厂</h1>
            <span className="text-sm text-zinc-400 font-normal hidden sm:inline">· 做梦结果在右侧抽屉生成，未保存不进笔记列表</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={clearAll}
              disabled={generating}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X size={14} />
              梦忘了
            </button>
            <button
              onClick={startGenerate}
              disabled={generating}
              className="shrink-0 inline-flex items-center gap-2 rounded-2xl bg-[#ff2442] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#e61f3b] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {generating ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {generating ? "正在做梦..." : "开始做梦"}
            </button>
          </div>
        </div>
      </div>

      {/* ── 主内容区（可滚动，不受抽屉影响） ── */}
      <div className="relative flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto p-6">
          <div className="mx-auto max-w-5xl space-y-4 pb-8">
            {/* 第一行：话题 + 数据反馈 */}
            <div className="grid gap-4 md:grid-cols-2">
              {/* 话题/热点 */}
              <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <Lightbulb size={16} className="text-[#ff2442]" />
                    话题 / 热点
                  </div>
                  <button
                    onClick={refreshTopicPool}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                  >
                    <RefreshCw size={12} className={topicsRefreshing ? "animate-spin" : ""} /> 刷新
                  </button>
                </div>
                <input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="或直接输入话题…"
                  className="w-full rounded-2xl border border-zinc-200 px-4 py-2.5 text-sm outline-none transition focus:border-[#ff2442]"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {topicPool.map((t) => {
                    const active = selectedTopicWords.includes(t.word);
                    return (
                      <button
                        key={t.word}
                        onClick={() => toggleId(t.word, selectedTopicWords, setSelectedTopicWords)}
                        className={`rounded-2xl border px-3 py-1.5 text-xs font-medium transition ${
                          active
                            ? "border-[#ff2442] bg-[#fff5f7] text-[#ff2442]"
                            : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                        }`}
                      >
                        {t.word}
                        <span className={`ml-1 text-[10px] ${active ? "text-[#ff9aaa]" : "text-zinc-400"}`}>·{t.count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 数据反馈 */}
              <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-800">
                  <TrendingUp size={16} className="text-[#ff2442]" />
                  自动注入的数据反馈
                </div>
                <div className="space-y-2 text-sm text-zinc-600">
                  {insightHints.length ? (
                    insightHints.map((hint) => (
                      <div key={hint} className="rounded-2xl bg-zinc-50 px-3 py-2">{hint}</div>
                    ))
                  ) : (
                    <div className="text-zinc-400">还没有足够的历史数据，先生成几篇再看规律。</div>
                  )}
                </div>
                <textarea
                  value={extraInstruction}
                  onChange={(e) => setExtraInstruction(e.target.value)}
                  placeholder="额外要求：比如『别太像模板文』『多一点租房打工人吐槽感』"
                  className="mt-3 h-20 w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm outline-none transition focus:border-[#ff2442]"
                />
              </div>
            </div>

            {/* 第二行：图库素材 + 榜样 */}
            <div className="grid gap-4 md:grid-cols-2">
              {/* 图库素材 */}
              <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <ImagePlus size={16} className="text-[#ff2442]" />
                    图库素材（随机9张）
                  </div>
                  <button
                    onClick={refreshItemPool}
                    disabled={itemsLoading || !allItems.length}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
                  >
                    <RefreshCw size={12} /> 刷新
                  </button>
                </div>
                {itemsLoading ? (
                  <div className="py-8 text-center text-sm text-zinc-500">加载图库中...</div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {itemPool.map((item) => {
                      const active = selectedItemIds.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          onClick={() => toggleId(item.id, selectedItemIds, setSelectedItemIds)}
                          className={`overflow-hidden rounded-2xl border text-left transition ${active ? "border-[#ff2442] ring-2 ring-[#ffd3db]" : "border-zinc-200 hover:border-zinc-300"}`}
                        >
                          <img src={api.imageUrl(item.id)} alt={item.title} className="aspect-square w-full object-cover" />
                          <div className="truncate px-2 py-2 text-xs text-zinc-700">{item.title}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
                <textarea
                  value={extraImageDesc}
                  onChange={(e) => setExtraImageDesc(e.target.value)}
                  placeholder="图库不够时，写还需要什么图：比如『还需要一张清晨自然光卧室局部图』"
                  className="mt-3 h-24 w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm outline-none transition focus:border-[#ff2442]"
                />
              </div>

              {/* 榜样 */}
              <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <Users size={16} className="text-[#ff2442]" />
                    榜样 + 帖子（随机9宫格）
                  </div>
                  <button
                    onClick={refreshAccountPool}
                    disabled={accountsLoading || !allAccounts.length}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
                  >
                    <RefreshCw size={12} /> 刷新
                  </button>
                </div>
                {accountsLoading ? (
                  <div className="py-8 text-center text-sm text-zinc-500">加载榜样中...</div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {accountPool.map((account) => {
                      const active = selectedAccountIds.includes(account.account_id);
                      const topPosts = normalizeTopNotes(account.top_notes).slice(0, 1);
                      return (
                        <button
                          key={account.account_id}
                          onClick={() => toggleId(account.account_id, selectedAccountIds, setSelectedAccountIds)}
                          className={`rounded-2xl border p-3 text-left transition ${active ? "border-[#ff2442] bg-[#fff5f7]" : "border-zinc-200 hover:border-zinc-300"}`}
                        >
                          <div className="mb-2 flex items-center justify-between">
                            <div className="truncate text-sm font-medium text-zinc-800">{account.name || account.account_id}</div>
                            <div className="text-xs text-[#ff2442]">{active ? "已选" : "选择"}</div>
                          </div>
                          <div className="mb-2 text-xs text-zinc-500">均赞 {Math.round(account.avg_likes || 0)} · {account.note_count} 篇</div>
                          {topPosts.length ? (
                            <div className="rounded-xl bg-zinc-50 p-2 text-xs text-zinc-600">
                              <div className="truncate">帖：{topPosts[0].title}</div>
                              <div className="mt-1 text-zinc-400">赞 {topPosts[0].likes}</div>
                            </div>
                          ) : (
                            <div className="rounded-xl bg-zinc-50 p-2 text-xs text-zinc-400">暂无帖子样本</div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── 右侧浮动抽屉 ── */}
        <div
          className={`fixed right-0 bottom-0 flex transition-all duration-300 z-50`}
          style={{ top: `${bannerHeight}px` }}
        >
          {/* 书签 tab：红色，白字竖排，始终贴在抽屉左侧 */}
          <button
            onClick={() => setDrawerState((s) => (s === "open" ? "peek" : "open"))}
            className="shrink-0 self-start mt-20 flex flex-col items-center gap-2 rounded-l-xl bg-[#ff2442] px-2.5 py-4 shadow-lg hover:bg-[#e61f3b] transition"
          >
            <Sparkles size={13} className="text-white" />
            <span className="text-[11px] font-semibold tracking-widest text-white" style={{ writingMode: "vertical-rl" }}>
              梦里生成稿
            </span>
            {generating && (
              <RefreshCw size={10} className="animate-spin text-white/70" />
            )}
          </button>

          {/* 抽屉主体 */}
          <div
            className={`flex flex-col border-l border-zinc-200 bg-white shadow-2xl transition-all duration-300 overflow-hidden
              ${drawerExpanded ? "w-[38vw] min-w-[420px]" : "w-0"}
            `}
          >
          {/* 抽屉头部 */}
          {drawerExpanded && (
            <div className="shrink-0 flex items-center gap-2 border-b border-zinc-100 px-5 py-4">
              <Sparkles size={15} className="text-[#ff2442]" />
              <span className="text-sm font-semibold text-zinc-900">梦里生成稿</span>
              {generating && <RefreshCw size={12} className="animate-spin text-zinc-400 ml-1" />}
              <p className="ml-auto text-xs text-zinc-400">先改满意，再保存为草稿</p>
            </div>
          )}

          {/* 抽屉内容 */}
          {drawerExpanded && (
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {savedNote && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  已保存到笔记草稿。
                  <Link to={`/notes/${savedNote.id}`} className="ml-2 font-medium underline underline-offset-2">去编辑</Link>
                </div>
              )}

              <div>
                <div className="mb-2 text-sm font-medium text-zinc-800">关联图片</div>
                {relatedImages.length ? (
                  <div className="flex flex-wrap gap-2">
                    {relatedImages.map((img) => {
                      const isSelected = selectedItemIds.includes(img.id);
                      const selOrder = selectedItemIds.indexOf(img.id);
                      return (
                        <button
                          key={img.id}
                          onClick={() => toggleId(img.id, selectedItemIds, setSelectedItemIds)}
                          className={`group relative w-[72px] h-[72px] shrink-0 overflow-hidden rounded-xl border-2 transition-all ${
                            isSelected ? "border-[#ff2442] shadow-sm" : "border-transparent hover:border-zinc-300"
                          }`}
                        >
                          <img src={api.imageUrl(img.id)} alt={img.title} className="w-full h-full object-cover" />
                          {isSelected && (
                            <div className="absolute inset-0 bg-[#ff2442]/15 flex items-end justify-end p-1">
                              <span className="w-5 h-5 rounded-full bg-[#ff2442] text-white text-[10px] font-bold flex items-center justify-center">
                                {selOrder + 1}
                              </span>
                            </div>
                          )}
                          {/* 悬停时显示标题（未选中态） */}
                          {!isSelected && (
                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <p className="text-[9px] text-white truncate">{img.title}</p>
                            </div>
                          )}
                          {/* 选中态顶部渐变标题 */}
                          {isSelected && (
                            <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/40 to-transparent px-1.5 py-1">
                              <p className="text-[9px] text-white truncate">{img.title}</p>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <Empty message="先在左侧选几张图，这里会自动补齐相关图片" />
                )}
              </div>

              {parsed.titles.length > 0 && (
                <div>
                  <div className="mb-2 text-sm font-medium text-zinc-800">标题候选</div>
                  <div className="flex flex-wrap gap-2">
                    {parsed.titles.map((title, idx) => (
                      <button
                        key={`${idx}-${title}`}
                        onClick={() => { setSelectedTitle(idx); setTitleText(title); }}
                        className={`rounded-full px-4 py-2 text-sm transition ${selectedTitle === idx ? "bg-[#ff2442] text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="mb-2 text-sm font-medium text-zinc-800">标题</div>
                <input
                  value={titleText}
                  onChange={(e) => setTitleText(e.target.value)}
                  className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm outline-none transition focus:border-[#ff2442]"
                />
              </div>

              <div>
                <div className="mb-2 text-sm font-medium text-zinc-800">正文</div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="min-h-[280px] w-full rounded-2xl border border-zinc-200 px-4 py-4 text-sm leading-7 text-zinc-700 outline-none transition focus:border-[#ff2442]"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-sm font-medium text-zinc-800">
                  <span>标签</span>
                  {tags.length > 0 && (
                    <span className="text-xs font-normal text-zinc-400">点击可取消，已选 {selectedTags.length}/{tags.length}</span>
                  )}
                </div>
                {tags.length ? (
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => {
                      const active = selectedTags.includes(tag);
                      return (
                        <button
                          key={tag}
                          onClick={() => toggleId(tag, selectedTags, setSelectedTags)}
                          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                            active
                              ? "border-[#ff2442] bg-[#fff5f7] text-[#ff2442]"
                              : "border-zinc-200 bg-zinc-50 text-zinc-400 line-through"
                          }`}
                        >
                          {tag.startsWith("#") ? tag : `#${tag}`}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <Empty message="生成完成后这里会出现标签" />
                )}
              </div>
            </div>
          )}

          {/* 底部操作栏：重新生成 + 保存为草稿 并排 */}
          {drawerExpanded && (
            <div className="shrink-0 border-t border-zinc-100 px-5 py-4 flex gap-3">
              <button
                onClick={startGenerate}
                disabled={generating}
                className={`flex-1 inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-medium transition disabled:opacity-60
                  ${rawResult ? "border-zinc-300 text-zinc-700 hover:bg-zinc-50" : "border-zinc-200 text-zinc-400 cursor-not-allowed"}`}
              >
                <RefreshCw size={14} className={generating ? "animate-spin" : ""} />
                {generating ? "生成中..." : "重新生成"}
              </button>
              <button
                onClick={saveDraft}
                disabled={!hasContent}
                className={`flex-1 inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition
                  ${hasContent ? "bg-[#ff2442] text-white hover:bg-[#e61f3b]" : "bg-zinc-100 text-zinc-400 cursor-not-allowed"}`}
              >
                <Save size={14} />
                保存为草稿
              </button>
            </div>
          )}
          </div>{/* 抽屉主体结束 */}
        </div>{/* 书签+抽屉容器结束 */}
      </div>
    </div>
  );
}
