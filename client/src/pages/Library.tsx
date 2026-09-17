import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE } from "../lib/api";
import { Item } from "../lib/types";
import { Spinner, Tag } from "../components/ui";
import LocalImage from "../components/LocalImage";
import {
  Upload, Plus, X, FileText, ChevronLeft, ChevronRight,
  LayoutGrid, Grid2x2, Grid3x3, Sparkles, Trash2, FolderOpen, RotateCcw,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "../components/Toast";
import { useHDRSetting } from "../hooks/useHDRSetting";
import {
  IS_TAURI_RUNTIME,
  createLocalDraftFromItems,
  deleteLocalItem,
  fileToBase64,
  fileToThumbnailBase64,
  importLocalImage,
  repairLocalImage,
  localItemToItem,
  purgeLocalItems,
  readLocalWorkspaceSnapshot,
  restoreLocalItem,
  updateLocalItemMetadata,
  type LocalWorkspaceSnapshot,
} from "../lib/local";
import { getCapability } from "../lib/capabilities";
import { useAccountChange, useAccountContext } from "../lib/accountContext";

// 列数 → Tailwind grid class
const COLS_CLASS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
  8: "grid-cols-8",
};

const PAGE_SIZE = 40;

const LIBRARY_VIEW_KEY = "aichihongshu.library-view.v1";

function libraryViewKey(scopeKey: string): string {
  return `${LIBRARY_VIEW_KEY}:${encodeURIComponent(scopeKey)}`;
}

// 解析 analysis_raw JSON 字符串，安全返回
function parseAnalysis(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default function Library() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { accountId, scopeKey } = useAccountContext();
  const libraryImport = getCapability("library.import");
  const libraryRepair = getCapability("library.repair");
  const libraryMetadataWrite = getCapability("library.metadata.write");
  const libraryRead = getCapability("library.read");
  const libraryAnalyze = getCapability("library.analyze");
  const libraryDelete = getCapability("library.delete");
  const createNoteFromLibrary = getCapability("note.createFromLibrary");
  // hdr 必须解构（即使不直接使用），变化时会触发组件重渲染，imgStyle() 才能读到最新值
  const { hdr: _hdr, imgStyle } = useHDRSetting();
  const [selected, setSelected] = useState<Item | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [draftingMulti, setDraftingMulti] = useState(false);
  const [filterTag, setFilterTag] = useState("");
  const [filterUnanalyzed, setFilterUnanalyzed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [page, setPage] = useState(0);
  const [cols, setCols] = useState(8);
  const [analyzingIds, setAnalyzingIds] = useState<Set<number>>(new Set());
  const [hoveredItem, setHoveredItem] = useState<Item | null>(null);
  const [previewItem, setPreviewItem] = useState<Item | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState({ title: "", tags: "", style: "", material: "", scene: "", color: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const repairFileRef = useRef<HTMLInputElement>(null);
  const libraryScrollRef = useRef<HTMLDivElement>(null);
  const viewScopeRef = useRef<string | null>(null);

  useAccountChange(() => {
    setSelected(null);
    setMultiSelected(new Set());
    setDraftingMulti(false);
    setAnalyzingIds(new Set());
    setHoveredItem(null);
    setPreviewItem(null);
    setShowTrash(false);
    setEditingMetadata(false);
    setPage(0);
  });

  useEffect(() => {
    viewScopeRef.current = scopeKey;
    try {
      const saved = JSON.parse(localStorage.getItem(libraryViewKey(scopeKey)) ?? "null") as Partial<{ filterTag: string; filterUnanalyzed: boolean; page: number; cols: number }> | null;
      if (saved) {
        if (typeof saved.filterTag === "string") setFilterTag(saved.filterTag);
        if (typeof saved.filterUnanalyzed === "boolean") setFilterUnanalyzed(saved.filterUnanalyzed);
        if (typeof saved.page === "number" && Number.isInteger(saved.page) && saved.page >= 0) setPage(saved.page);
        if (typeof saved.cols === "number" && Number.isInteger(saved.cols) && saved.cols >= 2 && saved.cols <= 8) setCols(saved.cols);
      }
      const scroll = Number(sessionStorage.getItem(`${libraryViewKey(scopeKey)}:scroll`));
      if (Number.isFinite(scroll) && libraryScrollRef.current) libraryScrollRef.current.scrollTop = scroll;
    } catch { /* preferences are optional */ }
  }, [scopeKey]);

  useEffect(() => {
    if (!selected) {
      setEditingMetadata(false);
      return;
    }
    setMetadataDraft({
      title: selected.title ?? "",
      tags: selected.tags.join(", "),
      style: selected.style ?? "",
      material: selected.material ?? "",
      scene: selected.scene ?? "",
      color: selected.color ?? "",
    });
    setEditingMetadata(false);
  }, [selected?.id, selected?.metadata_version]);

  useEffect(() => {
    if (viewScopeRef.current !== scopeKey) return;
    try {
      localStorage.setItem(libraryViewKey(scopeKey), JSON.stringify({ filterTag, filterUnanalyzed, page, cols }));
    } catch { /* preferences are optional */ }
  }, [scopeKey, filterTag, filterUnanalyzed, page, cols]);

  function explainCapability(capability: ReturnType<typeof getCapability>) {
    toast(`${capability.reason ?? "当前操作不可用"}。${capability.nextStep ?? "请稍后重试"}`, "info");
  }

  const { data: remoteItems = [], isLoading: remoteItemsLoading } = useQuery<Item[]>({
    queryKey: ["items", filterTag, page],
    queryFn: () =>
      api.get(
        `/api/library/?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}${
          filterTag ? `&tag=${encodeURIComponent(filterTag)}` : ""
        }`
      ),
    enabled: !IS_TAURI_RUNTIME,
    // 如果有正在分析的图片，每 3 秒轮询一次
    refetchInterval: analyzingIds.size > 0 ? 3000 : false,
  });
  const { data: localWorkspace, isLoading: localItemsLoading } = useQuery<LocalWorkspaceSnapshot>({
    queryKey: ["local-library", scopeKey, filterTag, filterUnanalyzed, page],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && libraryRead.available && accountId !== null,
  });
  const items: Item[] = IS_TAURI_RUNTIME
    ? (showTrash ? (localWorkspace?.trashItems ?? []) : (localWorkspace?.items ?? [])).map(localItemToItem)
    : remoteItems;
  const missingImageIds = new Set(IS_TAURI_RUNTIME ? (localWorkspace?.missingImageIds ?? []) : []);
  const isLoading = IS_TAURI_RUNTIME ? localItemsLoading : remoteItemsLoading;

  useEffect(() => {
    const element = libraryScrollRef.current;
    if (!element) return;
    const save = () => { try { sessionStorage.setItem(`${libraryViewKey(scopeKey)}:scroll`, String(element.scrollTop)); } catch { /* optional */ } };
    element.addEventListener("scroll", save, { passive: true });
    return () => element.removeEventListener("scroll", save);
  }, [scopeKey, items.length]);

  useEffect(() => {
    const rawTarget = searchParams.get("item");
    if (!rawTarget) return;
    const target = Number(rawTarget);
    if (!Number.isFinite(target)) return;
    const item = items.find((candidate) => candidate.id === target);
    if (item) setSelected(item);
  }, [items, searchParams]);

  // 轮询时检查哪些图片已完成分析，移除 analyzingIds
  useEffect(() => {
    if (analyzingIds.size === 0) return;
    setAnalyzingIds((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (next.has(item.id) && item.analysis_raw) {
          next.delete(item.id);
        }
      }
      return next;
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // 导入后追踪哪些图片需要等待 AI 分析
  async function handleUpload(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    if (!libraryImport.available) {
      explainCapability(libraryImport);
      return;
    }
    if (IS_TAURI_RUNTIME) {
      if (accountId == null) {
        toast("当前账号尚未就绪，无法导入素材", "error");
        return;
      }
      setUploading(true);
      let imported = 0;
      const failures: string[] = [];
      try {
        for (const file of Array.from(files)) {
          try {
            await importLocalImage({
              accountPoolId: accountId,
              fileName: file.name,
              mimeType: file.type || undefined,
              dataBase64: await fileToBase64(file),
              thumbnailDataBase64: await fileToThumbnailBase64(file),
            });
            imported += 1;
          } catch (error: unknown) {
            failures.push(`${file.name}: ${(error as Error)?.message ?? "导入失败"}`);
          }
        }
        if (imported > 0) {
          await qc.invalidateQueries({ queryKey: ["local-library"] });
        }
        if (failures.length === 0) {
          toast(`已导入 ${imported} 张图片`, "success");
        } else if (imported > 0) {
          toast(`已导入 ${imported} 张，${failures.length} 张失败：${failures[0]}`, "info");
        } else {
          toast(failures[0] ?? "没有素材导入成功", "error");
        }
      } finally {
        setUploading(false);
      }
      return;
    }
    setUploading(true);
    try {
      const newIds: number[] = [];
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("analyze", "true");
        const item: Item = await api.upload("/api/library/", fd);
        newIds.push(item.id);
      }
      // 标记这批图片为分析中
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        newIds.forEach((id) => next.add(id));
        return next;
      });
      qc.invalidateQueries({ queryKey: ["items"] });
      toast(`已导入 ${files.length} 张图片，AI 识别中...`, "success");
    } catch (e: unknown) {
      console.error("[Library] upload error:", e);
      toast((e as Error).message, "error");
    } finally {
      setUploading(false);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    await handleUpload(e.dataTransfer.files);
  }

  async function draftNote() {
    if (!selected) return;
    if (showTrash) {
      toast("回收站素材需先恢复后才能生成草稿", "info");
      return;
    }
    if (!createNoteFromLibrary.available) {
      explainCapability(createNoteFromLibrary);
      return;
    }
    if (IS_TAURI_RUNTIME) {
      if (accountId == null) {
        toast("当前账号尚未就绪，无法创建草稿", "error");
        return;
      }
      try {
        const localNote = await createLocalDraftFromItems([selected.id], accountId);
        navigate(`/notes/${localNote.id}`);
      } catch (e: unknown) {
        toast((e as Error).message, "error");
      }
      return;
    }
    try {
      const res = await api.post("/api/content/draft", { item_id: selected.id, save: true });
      navigate(`/notes/${res.note_id}`);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  async function saveMetadata() {
    if (!selected || !IS_TAURI_RUNTIME || accountId == null) return;
    if (!libraryMetadataWrite.available) {
      explainCapability(libraryMetadataWrite);
      return;
    }
    setSavingMetadata(true);
    try {
      const updated = await updateLocalItemMetadata({
        itemId: selected.id,
        accountPoolId: accountId,
        expectedMetadataVersion: selected.metadata_version ?? 1,
        title: metadataDraft.title,
        tags: metadataDraft.tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean),
        style: metadataDraft.style.trim() || undefined,
        material: metadataDraft.material.trim() || undefined,
        scene: metadataDraft.scene.trim() || undefined,
        color: metadataDraft.color.trim() || undefined,
      });
      setSelected(localItemToItem(updated));
      setEditingMetadata(false);
      await qc.invalidateQueries({ queryKey: ["local-library"] });
      toast("素材元数据已保存", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setSavingMetadata(false);
    }
  }

  async function handleRepair(files: FileList | File[] | null) {
    const file = files?.[0];
    if (!file || !selected || !IS_TAURI_RUNTIME || accountId == null) return;
    if (!libraryRepair.available) {
      explainCapability(libraryRepair);
      return;
    }
    setRepairing(true);
    try {
      const updated = await repairLocalImage({
        itemId: selected.id,
        accountPoolId: accountId,
        expectedImageVersion: selected.image_version ?? 1,
        fileName: file.name,
        mimeType: file.type || undefined,
        dataBase64: await fileToBase64(file),
        thumbnailDataBase64: await fileToThumbnailBase64(file),
      });
      setSelected(localItemToItem(updated));
      await qc.invalidateQueries({ queryKey: ["local-library"] });
      toast("素材图片已修复，旧分析结果已清除", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setRepairing(false);
    }
  }

  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingMulti, setDeletingMulti] = useState(false);
  const [restoringMulti, setRestoringMulti] = useState(false);
  const [purgingMulti, setPurgingMulti] = useState(false);
  const [deleteMultiConfirm, setDeleteMultiConfirm] = useState(false);

  async function deleteItem() {
    if (!selected) return;
    if (!libraryDelete.available) {
      explainCapability(libraryDelete);
      return;
    }
    setDeleting(true);
    try {
      if (IS_TAURI_RUNTIME) {
        if (accountId == null) throw new Error("当前账号尚未就绪");
        await deleteLocalItem(selected.id, accountId);
        await qc.invalidateQueries({ queryKey: ["local-library"] });
      } else {
        await api.delete(`/api/library/${selected.id}`);
        qc.invalidateQueries({ queryKey: ["items"] });
      }
      toast("已删除", "success");
      setSelected(null);
      setDeleteConfirm(false);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDeleting(false);
    }
  }

  async function deleteMulti() {
    if (multiSelected.size === 0) return;
    if (!libraryDelete.available) {
      explainCapability(libraryDelete);
      return;
    }
    setDeletingMulti(true);
    const ids = Array.from(multiSelected);
    let failed = 0;
    for (const id of ids) {
      try {
        if (IS_TAURI_RUNTIME) {
          if (accountId == null) throw new Error("当前账号尚未就绪");
          await deleteLocalItem(id, accountId);
        } else {
          await api.delete(`/api/library/${id}`);
        }
      } catch {
        failed++;
      }
    }
    setDeletingMulti(false);
    setDeleteMultiConfirm(false);
    setMultiSelected(new Set());
    await qc.invalidateQueries({ queryKey: [IS_TAURI_RUNTIME ? "local-library" : "items"] });
    if (failed === 0) {
      toast(`已删除 ${ids.length} 张图片`, "success");
    } else {
      toast(`删除完成，${failed} 张失败`, "error");
    }
  }

  async function restoreMulti() {
    if (multiSelected.size === 0 || !IS_TAURI_RUNTIME || !showTrash || accountId == null) return;
    setRestoringMulti(true);
    const ids = Array.from(multiSelected);
    let failed = 0;
    for (const id of ids) {
      try {
        await restoreLocalItem(id, accountId);
      } catch {
        failed++;
      }
    }
    setRestoringMulti(false);
    setMultiSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["local-library"] });
    if (failed === 0) {
      toast(`已恢复 ${ids.length} 张图片`, "success");
    } else {
      toast(`恢复完成，${failed} 张失败`, "error");
    }
  }

  async function purgeMulti() {
    if (multiSelected.size === 0 || !IS_TAURI_RUNTIME || !showTrash || accountId == null) return;
    setPurgingMulti(true);
    try {
      const result = await purgeLocalItems(Array.from(multiSelected), accountId);
      setMultiSelected(new Set());
      setDeleteMultiConfirm(false);
      await qc.invalidateQueries({ queryKey: ["local-library"] });
      toast(result.cleanupWarnings.length > 0
        ? `已永久清理 ${result.purgedIds.length} 张图片，但有 ${result.cleanupWarnings.length} 个文件待清理`
        : `已永久清理 ${result.purgedIds.length} 张图片`, result.cleanupWarnings.length > 0 ? "info" : "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setPurgingMulti(false);
    }
  }

  async function draftMulti() {
    if (multiSelected.size === 0) return;
    if (showTrash) {
      toast("回收站素材需先恢复后才能生成草稿", "info");
      return;
    }
    if (!createNoteFromLibrary.available) {
      explainCapability(createNoteFromLibrary);
      return;
    }
    if (IS_TAURI_RUNTIME) {
      if (accountId == null) {
        toast("当前账号尚未就绪，无法创建草稿", "error");
        return;
      }
      try {
        const localNote = await createLocalDraftFromItems(Array.from(multiSelected), accountId);
        navigate(`/notes/${localNote.id}`);
      } catch (e: unknown) {
        toast((e as Error).message, "error");
      }
      return;
    }
    setDraftingMulti(true);
    try {
      const res = await api.post("/api/content/draft/multi", {
        item_ids: Array.from(multiSelected),
      });
      navigate(`/notes/${res.note_id}`);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDraftingMulti(false);
    }
  }

  async function restoreItem() {
    if (!selected || !IS_TAURI_RUNTIME || accountId == null || !showTrash) return;
    setRepairing(true);
    try {
      await restoreLocalItem(selected.id, accountId);
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ["local-library"] });
      toast("素材已恢复到图库", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setRepairing(false);
    }
  }

  function handleCardClick(item: Item, e: React.MouseEvent) {
    // Ctrl/Cmd + 单击 → 切换多选
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      return;
    }
    // 普通单击 → 打开详情
    setSelected(item);
    setDeleteConfirm(false);
  }

  // 收集所有标签（仅当前页，做标签过滤）
  const allTags = Array.from(new Set(items.flatMap((i) => i.tags)));
  // 客户端二次筛选：未识别
  const visibleItems = filterUnanalyzed ? items.filter((i) => !i.analysis_raw) : items;
  const hasPrev = page > 0;
  const hasNext = items.length === PAGE_SIZE;

  function changeFilter(tag: string) {
    setFilterTag(tag);
    setFilterUnanalyzed(false);
    setPage(0);
  }

  function toggleUnanalyzed() {
    setFilterUnanalyzed((v) => !v);
    setFilterTag("");
    setPage(0);
  }

  function selectAll() {
    setMultiSelected(new Set(visibleItems.map((i) => i.id)));
  }

  function invertSelection() {
    setMultiSelected(
      new Set(visibleItems.filter((i) => !multiSelected.has(i.id)).map((i) => i.id))
    );
  }

  async function analyzeMulti() {
    if (!libraryAnalyze.available) {
      explainCapability(libraryAnalyze);
      return;
    }
    const ids = Array.from(multiSelected).filter(
      (id) => !items.find((i) => i.id === id)?.analysis_raw
    );
    if (ids.length === 0) {
      toast("所选图片均已识别", "success");
      return;
    }
    // 加入 analyzingIds，触发轮询
    setAnalyzingIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    toast(`开始识别 ${ids.length} 张图片...`, "success");
    // 逐个触发后端分析（后端是 background task，立即返回）
    for (const id of ids) {
      try {
        await api.post(`/api/library/${id}/analyze`, {});
      } catch {
        // 单张失败不中断整体
      }
    }
    setMultiSelected(new Set());
  }

  // 粘贴入库：监听全局 paste 事件，提取图片文件
  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      // 如果焦点在输入框内则跳过，不干扰文字粘贴
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const items = Array.from(e.clipboardData?.items ?? []);
      console.log("[Library] paste event, clipboardData items:", items.map(i => `${i.kind}/${i.type}`));

      const imageFiles = items
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);

      console.log("[Library] image files found:", imageFiles.length, imageFiles.map(f => f.name || f.type));

      if (imageFiles.length > 0) {
        e.preventDefault();
        handleUpload(imageFiles);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploading, accountId, libraryImport, qc, toast],
  );

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  // 空格预览：hover 中的图片
  const hoveredItemRef = useRef<Item | null>(null);
  hoveredItemRef.current = hoveredItem;
  const previewItemRef = useRef<Item | null>(null);
  previewItemRef.current = previewItem;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // 如果焦点在输入框内，不拦截空格
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.code === "Space") {
        e.preventDefault();
        if (previewItemRef.current) {
          // 已经在预览 → 关闭
          setPreviewItem(null);
        } else if (hoveredItemRef.current) {
          // 有 hover 的图片 → 打开预览
          setPreviewItem(hoveredItemRef.current);
        }
      }
      if (e.code === "Escape") {
        setPreviewItem(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <div className="flex h-full">
      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* 第一行：操作栏 */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-100 bg-white">
          <h1 className="text-lg font-semibold text-zinc-900">图库</h1>
          <div className="ml-auto flex items-center gap-3">
            {/* 尺寸调节 */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCols(3)}
                title="大图"
                className={`p-1.5 rounded-lg transition-colors ${cols <= 3 ? "bg-zinc-100 text-zinc-800" : "text-zinc-400 hover:bg-zinc-50"}`}
              >
                <Grid2x2 size={15} />
              </button>
              <button
                onClick={() => setCols(5)}
                title="中图"
                className={`p-1.5 rounded-lg transition-colors ${cols === 5 ? "bg-zinc-100 text-zinc-800" : "text-zinc-400 hover:bg-zinc-50"}`}
              >
                <Grid3x3 size={15} />
              </button>
              <button
                onClick={() => setCols(8)}
                title="小图"
                className={`p-1.5 rounded-lg transition-colors ${cols >= 8 ? "bg-zinc-100 text-zinc-800" : "text-zinc-400 hover:bg-zinc-50"}`}
              >
                <LayoutGrid size={15} />
              </button>
              <input
                type="range"
                min={2}
                max={8}
                step={1}
                value={cols}
                onChange={(e) => setCols(Number(e.target.value))}
                className="w-20 accent-[#ff2442] cursor-pointer"
                title={`${cols} 列`}
              />
              <span className="text-xs text-zinc-400 w-6 text-center">{cols}</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => { void handleUpload(e.target.files); e.currentTarget.value = ""; }}
            />
            <input
              ref={repairFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { void handleRepair(e.target.files); e.currentTarget.value = ""; }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading || !libraryImport.available}
              title={libraryImport.available ? "导入图片" : `${libraryImport.reason}；${libraryImport.nextStep}`}
              className="flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] transition-colors disabled:opacity-50"
            >
              {uploading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Plus size={15} />
              )}
              导入图片
            </button>
            {IS_TAURI_RUNTIME && (
              <button
                onClick={() => { setShowTrash((value) => !value); setSelected(null); setMultiSelected(new Set()); setDeleteMultiConfirm(false); }}
                className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${showTrash ? "border-amber-400 bg-amber-50 text-amber-700" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"}`}
                title={showTrash ? "返回当前账号图库" : `打开当前账号回收站（${localWorkspace?.trashItems?.length ?? 0}）`}
              >
                {showTrash ? "返回图库" : `回收站${localWorkspace?.trashItems?.length ? ` (${localWorkspace.trashItems.length})` : ""}`}
              </button>
            )}
            <span className="text-xs text-zinc-300 hidden lg:block">或 ⌘V 粘贴</span>
          </div>
        </div>

        {IS_TAURI_RUNTIME && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-selected)] px-6 py-2 text-xs text-[var(--color-text-secondary)]">
            当前显示{showTrash ? "本地素材回收站" : "本地图库"}；{libraryImport.available && !showTrash ? "可以导入素材。" : ""}{libraryRepair.available && !showTrash ? "缺失或需要替换的图片可用“修复/替换图片”。" : ""}{!showTrash && missingImageIds.size > 0 ? `当前发现 ${missingImageIds.size} 个素材文件缺失。` : ""}素材按当前账号隔离。
          </div>
        )}

        {/* 第二行：标签过滤 */}
        <div className="px-6 py-2 border-b border-zinc-100 bg-white">
          <div className={`flex gap-2 flex-wrap items-center ${tagsExpanded ? "" : "max-h-8 overflow-hidden"}`}>
            <button
              onClick={() => changeFilter("")}
              className={`text-xs px-3 py-1 rounded-full transition-colors shrink-0 ${
                filterTag === "" && !filterUnanalyzed ? "bg-[#ff2442] text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >全部</button>
            {/* 未识别快捷筛选 */}
            <button
              onClick={toggleUnanalyzed}
              className={`text-xs px-3 py-1 rounded-full transition-colors shrink-0 border ${
                filterUnanalyzed
                  ? "bg-amber-500 text-white border-amber-500"
                  : "border-amber-300 text-amber-600 hover:bg-amber-50"
              }`}
            >
              ✦ 未识别
            </button>
            {allTags.map((t) => (
              <button key={t}
                onClick={() => changeFilter(filterTag === t ? "" : t)}
                className={`text-xs px-3 py-1 rounded-full transition-colors shrink-0 ${
                  filterTag === t ? "bg-[#ff2442] text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                }`}
              >#{t}</button>
            ))}
            {/* 选择操作 */}
            {visibleItems.length > 0 && (
              <div className="flex items-center gap-1 ml-auto shrink-0">
                <button
                  onClick={selectAll}
                  className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500 hover:bg-zinc-200 transition-colors"
                  title="全选当前显示的图片"
                >
                  全选
                </button>
                <button
                  onClick={invertSelection}
                  className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500 hover:bg-zinc-200 transition-colors"
                  title="反选"
                >
                  反选
                </button>
                {multiSelected.size > 0 && (
                  <button
                    onClick={() => { setMultiSelected(new Set()); setDeleteMultiConfirm(false); }}
                    className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500 hover:bg-zinc-200 transition-colors"
                    title="取消所有选择"
                  >
                    全不选
                  </button>
                )}
              </div>
            )}
          </div>
          {allTags.length > 6 && (
            <button
              onClick={() => setTagsExpanded((v) => !v)}
              className="mt-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              {tagsExpanded ? "收起 ▲" : `展开全部 ${allTags.length} 个标签 ▼`}
            </button>
          )}
        </div>

        {/* Drop zone + Grid */}
        <div
          ref={libraryScrollRef}
          className="flex-1 overflow-y-auto p-6 relative"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          {isLoading ? <Spinner /> : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-zinc-200 rounded-2xl gap-3 text-zinc-400">
              <Upload size={32} />
              <p className="text-sm">拖拽图片到此处，或点击「导入图片」</p>
              <p className="text-xs text-zinc-300">也可直接 Ctrl+V / ⌘+V 粘贴截图</p>
            </div>
          ) : (
            <>
              <div className={`grid ${COLS_CLASS[cols] ?? "grid-cols-4"} gap-4`}>
                {visibleItems.map((item) => {
                  const isMulti = multiSelected.has(item.id);
                  const isSingle = selected?.id === item.id;
                  const isAnalyzing = analyzingIds.has(item.id);
                  const isMissing = missingImageIds.has(item.id);
                  return (
                    <div
                      key={item.id}
                      onClick={(e) => handleCardClick(item, e)}
                      onMouseEnter={() => setHoveredItem(item)}
                      onMouseLeave={() => setHoveredItem(null)}
                      className={`group cursor-pointer rounded-xl overflow-hidden border-2 transition-all relative ${
                        isSingle
                          ? "border-[#ff2442] shadow-md"
                          : isMulti
                          ? "border-transparent"
                          : "border-transparent hover:border-zinc-200"
                      } bg-white`}
                    >
                      {/* 多选遮罩 + 勾选 */}
                      {isMulti && (
                        <>
                          <div className="absolute inset-0 z-10 bg-zinc-900/30 rounded-xl pointer-events-none" />
                          <div className="absolute top-1.5 right-1.5 z-20 w-5 h-5 bg-[#ff2442] rounded-full flex items-center justify-center shadow">
                            <span className="text-white text-xs font-bold">✓</span>
                          </div>
                        </>
                      )}
                      <div className="aspect-square bg-zinc-100 overflow-hidden relative">
                        <LocalImage
                          itemId={item.id}
                          variant="thumbnail"
                          version={`${item.image_version ?? 1}:${item.content_hash ?? "unknown"}`}
                          src={`${API_BASE}/api/library/${item.id}/image`}
                          alt={item.title}
                          loading="lazy"
                          style={imgStyle()}
                          className="w-full h-full object-cover"
                        />
                        {/* AI 识别标识 / analyzing 遮罩 */}
                        {isMissing ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-amber-950/45 rounded-t-xl">
                            <span className="text-white text-[10px] font-medium bg-amber-600/90 px-2 py-1 rounded">文件缺失</span>
                          </div>
                        ) : isAnalyzing ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-t-xl">
                            <div className="flex flex-col items-center gap-1.5">
                              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                              <span className="text-white text-[10px] font-medium">识别中</span>
                            </div>
                          </div>
                        ) : (
                          <div className={`absolute bottom-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${
                            item.analysis_raw
                              ? "bg-black/50 text-white"
                              : "bg-zinc-800/60 text-zinc-300"
                          }`}>
                            {item.analysis_raw ? "AI ✓" : "未识别"}
                          </div>
                        )}
                      </div>
                      <div className="p-2">
                        <p className="text-xs font-medium text-zinc-800 truncate">{item.title}</p>
                        {item.style && (
                          <p className="text-xs text-zinc-400 truncate">{item.style}</p>
                        )}
                        {item.note_count > 0 && (
                          <p className="text-xs text-[#ff2442] mt-0.5">
                            <FileText size={10} className="inline mr-0.5" />
                            {item.note_count} 篇笔记
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 分页 */}
              {(hasPrev || hasNext) && (
                <div className="flex items-center justify-center gap-3 mt-6">
                  <button
                    onClick={() => setPage((p) => p - 1)}
                    disabled={!hasPrev}
                    className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 disabled:opacity-30 hover:bg-zinc-50"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="text-xs text-zinc-500">第 {page + 1} 页</span>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!hasNext}
                    className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 disabled:opacity-30 hover:bg-zinc-50"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
              {/* 多选提示 */}
              <p className="text-xs text-zinc-400 text-center mt-4">
                按住 <kbd className="px-1 py-0.5 bg-zinc-100 rounded text-zinc-500">⌘</kbd> / <kbd className="px-1 py-0.5 bg-zinc-100 rounded text-zinc-500">Ctrl</kbd> 单击可多选物品，合并生成一篇笔记
              </p>
            </>
          )}
        </div>

        {/* 多选底部浮出操作栏 */}
        {multiSelected.size > 0 && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
            {deleteMultiConfirm && (
              <div className="flex items-center gap-2 bg-red-600 text-white px-4 py-2.5 rounded-2xl shadow-2xl border border-red-500 text-sm">
                <span>{showTrash ? `确认永久清理 ${multiSelected.size} 张图片？关联笔记会阻止清理。` : `确认删除 ${multiSelected.size} 张图片？`}</span>
                <button
                  onClick={showTrash ? purgeMulti : deleteMulti}
                  disabled={showTrash ? purgingMulti : deletingMulti}
                  className="bg-white text-red-600 text-xs font-semibold px-3 py-1 rounded-xl hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  {showTrash ? (purgingMulti ? "清理中..." : "确认清理") : (deletingMulti ? "删除中..." : "确认")}
                </button>
                <button
                  onClick={() => setDeleteMultiConfirm(false)}
                  className="text-red-200 hover:text-white transition-colors"
                >
                  <X size={15} />
                </button>
              </div>
            )}
            <div className="flex items-center gap-3 bg-zinc-900 text-white px-5 py-3 rounded-2xl shadow-2xl border border-zinc-700">
              <span className="text-sm font-medium">已选 {multiSelected.size} 张</span>
              <div className="w-px h-4 bg-zinc-600" />
              {showTrash ? (
                <>
                  <button
                    onClick={restoreMulti}
                    disabled={restoringMulti}
                    className="flex items-center gap-1.5 text-sm bg-amber-500 text-white px-3.5 py-1.5 rounded-xl hover:bg-amber-600 transition-colors disabled:opacity-50 font-medium"
                    title="批量恢复到当前账号图库"
                  >
                    {restoringMulti ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <RotateCcw size={14} />}
                    批量恢复
                  </button>
                  <button
                    onClick={() => setDeleteMultiConfirm(true)}
                    disabled={purgingMulti}
                    className="flex items-center gap-1.5 text-sm text-red-300 hover:text-red-100 px-2 py-1.5 rounded-xl hover:bg-red-900 transition-colors disabled:opacity-50"
                    title="永久清理；仍被笔记引用的素材会整体拒绝"
                  >
                    <Trash2 size={14} />
                    永久清理
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={draftMulti}
                    disabled={draftingMulti || !createNoteFromLibrary.available}
                    title={createNoteFromLibrary.available ? "合并生成草稿" : `${createNoteFromLibrary.reason}；${createNoteFromLibrary.nextStep}`}
                    className="flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-3.5 py-1.5 rounded-xl hover:bg-[#e01f3a] transition-colors disabled:opacity-50 font-medium"
                  >
                    {draftingMulti ? (
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    合并生成草稿
                  </button>
                  <button
                    onClick={analyzeMulti}
                    disabled={!libraryAnalyze.available}
                    className="flex items-center gap-1.5 text-sm text-zinc-200 hover:text-white px-3 py-1.5 rounded-xl hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    title={libraryAnalyze.available ? "批量 AI 识别未识别的图片" : `${libraryAnalyze.reason}；${libraryAnalyze.nextStep}`}
                  >
                    <Sparkles size={14} className="text-amber-400" />
                    批量识别
                  </button>
                  <button
                    onClick={() => setDeleteMultiConfirm(true)}
                    disabled={deletingMulti || !libraryDelete.available}
                    className="flex items-center gap-1.5 text-sm text-zinc-300 hover:text-red-400 px-2 py-1.5 rounded-xl hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    title={libraryDelete.available ? "批量删除" : `${libraryDelete.reason}；${libraryDelete.nextStep}`}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                </>
              )}
              <button
                onClick={() => { setMultiSelected(new Set()); setDeleteMultiConfirm(false); }}
                className="text-zinc-400 hover:text-white transition-colors"
                title="取消多选"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="w-72 border-l border-zinc-100 bg-white flex flex-col overflow-y-auto">
          <div className="flex items-center justify-between p-4 border-b border-zinc-100">
            <span className="text-sm font-semibold">物品详情</span>
            <button onClick={() => setSelected(null)} className="text-zinc-400 hover:text-zinc-700">
              <X size={16} />
            </button>
          </div>

          <LocalImage
            itemId={selected.id}
            version={`${selected.image_version ?? 1}:${selected.content_hash ?? "unknown"}`}
            src={`${API_BASE}/api/library/${selected.id}/image`}
            alt={selected.title}
            style={imgStyle()}
            className="w-full aspect-square object-cover"
          />

          <div className="p-4 space-y-3 flex-1">
            {IS_TAURI_RUNTIME && missingImageIds.has(selected.id) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                素材记录仍在，但图片文件未找到。{showTrash ? "请先恢复素材，再选择“修复/替换图片”补回文件；" : "请选择“修复/替换图片”补回文件；"}修复成功后会清除旧的分析结果。
              </div>
            )}
            {editingMetadata && IS_TAURI_RUNTIME ? (
              <div className="space-y-2">
                <MetadataInput label="名称" value={metadataDraft.title} onChange={(value) => setMetadataDraft((draft) => ({ ...draft, title: value }))} />
                <MetadataInput label="标签（逗号分隔）" value={metadataDraft.tags} onChange={(value) => setMetadataDraft((draft) => ({ ...draft, tags: value }))} />
                <MetadataInput label="风格" value={metadataDraft.style} onChange={(value) => setMetadataDraft((draft) => ({ ...draft, style: value }))} />
                <MetadataInput label="场景" value={metadataDraft.scene} onChange={(value) => setMetadataDraft((draft) => ({ ...draft, scene: value }))} />
                <MetadataInput label="主色调" value={metadataDraft.color} onChange={(value) => setMetadataDraft((draft) => ({ ...draft, color: value }))} />
                <MetadataInput label="材质" value={metadataDraft.material} onChange={(value) => setMetadataDraft((draft) => ({ ...draft, material: value }))} />
              </div>
            ) : (
              <>
                <InfoRow label="名称" value={selected.title} bold />
                {selected.style && <InfoRow label="风格" value={selected.style} />}
                {selected.scene && <InfoRow label="场景" value={selected.scene} />}
                {selected.color && <InfoRow label="主色调" value={selected.color} />}
                {selected.material && <InfoRow label="材质" value={selected.material} />}
                {selected.tags.length > 0 && (
                  <div>
                    <p className="text-xs text-zinc-400 mb-1">标签</p>
                    <div className="flex flex-wrap gap-1">
                      {selected.tags.map((t) => <Tag key={t} label={t} />)}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 分析结果扩展字段 */}
            <AnalysisExtra raw={selected.analysis_raw} />
          </div>

          <div className="p-4 border-t border-zinc-100 space-y-2">
            {IS_TAURI_RUNTIME && !showTrash && libraryRepair.available && (
              <button
                onClick={() => repairFileRef.current?.click()}
                disabled={repairing}
                className="w-full flex items-center justify-center gap-1.5 text-sm text-zinc-500 py-2 rounded-xl border border-zinc-200 hover:bg-zinc-50 disabled:opacity-50"
                title="选择一张图片替换当前素材；图片版本递增并清除旧分析结果"
              >
                <Upload size={13} />
                {repairing ? "修复中…" : "修复/替换图片"}
              </button>
            )}
            {IS_TAURI_RUNTIME && !showTrash && libraryMetadataWrite.available && (
              editingMetadata ? (
                <div className="flex gap-2">
                  <button onClick={() => setEditingMetadata(false)} disabled={savingMetadata} className="flex-1 text-sm py-2 rounded-xl border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-50">取消</button>
                  <button onClick={saveMetadata} disabled={savingMetadata} className="flex-1 text-sm py-2 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50">{savingMetadata ? "保存中..." : "保存元数据"}</button>
                </div>
              ) : (
                <button onClick={() => setEditingMetadata(true)} className="w-full text-sm py-2 rounded-xl border border-zinc-200 text-zinc-600 hover:bg-zinc-50">编辑素材元数据</button>
              )
            )}
            <button
              onClick={draftNote}
              disabled={showTrash || !createNoteFromLibrary.available}
              title={showTrash ? "回收站素材需先恢复" : createNoteFromLibrary.available ? "生成笔记草稿" : `${createNoteFromLibrary.reason}；${createNoteFromLibrary.nextStep}`}
              className="w-full bg-[#ff2442] text-white text-sm py-2.5 rounded-xl hover:bg-[#e01f3a] transition-colors font-medium"
            >
              ✨ 生成笔记草稿
            </button>

            {/* 重新 AI 分析 */}
            <button
              onClick={async () => {
                if (!selected) return;
                try {
                  await api.post(`/api/library/${selected.id}/analyze`, {});
                  setAnalyzingIds((prev) => new Set(prev).add(selected.id));
                  toast("AI 识别已触发，稍后自动刷新", "success");
                } catch (e: unknown) {
                  toast((e as Error).message, "error");
                }
              }}
              disabled={showTrash || analyzingIds.has(selected.id) || !libraryAnalyze.available}
              title={showTrash ? "回收站素材需先恢复" : libraryAnalyze.available ? "触发图片识别" : `${libraryAnalyze.reason}；${libraryAnalyze.nextStep}`}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-zinc-400
                         py-2 rounded-xl hover:bg-zinc-50 hover:text-zinc-600 transition-colors disabled:opacity-50"
            >
              {analyzingIds.has(selected.id) ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin" />
                  AI 识别中...
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  {selected.analysis_raw ? "重新 AI 识别" : "触发 AI 识别"}
                </>
              )}
            </button>

            {showTrash ? (
              <div className="rounded-xl bg-amber-50 p-3 space-y-2">
                <p className="text-xs text-amber-700 text-center">该素材在回收站，磁盘文件仍保留。</p>
                {selected.note_count > 0 && (
                  <p className="text-xs text-amber-700 text-center">仍关联 {selected.note_count} 篇笔记，恢复后再继续编辑或发布。</p>
                )}
                <button
                  onClick={restoreItem}
                  disabled={repairing}
                  className="w-full text-xs py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {repairing ? "恢复中…" : "恢复到图库"}
                </button>
              </div>
            ) : !deleteConfirm ? (
              <div className="flex gap-2">
                <button
                  onClick={() => selected?.image_path && revealItemInDir(selected.image_path)}
                  className="flex-1 flex items-center justify-center gap-1.5 text-sm text-zinc-400
                             py-2 rounded-xl hover:bg-zinc-50 hover:text-zinc-600 transition-colors"
                >
                  <FolderOpen size={13} />
                  在文件夹中显示
                </button>
                <button
                  onClick={() => setDeleteConfirm(true)}
                  disabled={!libraryDelete.available}
                  title={libraryDelete.available ? "删除物品" : `${libraryDelete.reason}；${libraryDelete.nextStep}`}
                  className="flex-1 flex items-center justify-center gap-1.5 text-sm text-zinc-400
                             py-2 rounded-xl hover:bg-zinc-50 hover:text-red-500 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 size={13} />
                  删除物品
                </button>
              </div>
            ) : (
              <div className="bg-red-50 rounded-xl p-3 space-y-2">
                <p className="text-xs text-red-600 text-center">确认删除「{selected.title}」？</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDeleteConfirm(false)}
                    className="flex-1 text-xs py-1.5 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-white transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={deleteItem}
                    disabled={deleting}
                    className="flex-1 text-xs py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                  >
                    {deleting ? "删除中..." : "确认删除"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>

    {/* 空格预览 Lightbox */}
    {previewItem && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
        onClick={() => setPreviewItem(null)}
      >
        <LocalImage
          itemId={previewItem.id}
          version={`${previewItem.image_version ?? 1}:${previewItem.content_hash ?? "unknown"}`}
          src={`${API_BASE}/api/library/${previewItem.id}/image`}
          alt={previewItem.title}
          style={imgStyle()}
          className="max-h-[90vh] max-w-[90vw] rounded-2xl shadow-2xl object-contain"
          onClick={(e) => e.stopPropagation()}
        />
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-4 py-1.5 rounded-full backdrop-blur-sm">
          {previewItem.title}
          <span className="ml-3 text-white/50">按空格或 ESC 关闭</span>
        </div>
      </div>
    )}
    </>
  );
}

// ── 子组件 ─────────────────────────────────────────────────────────

function InfoRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-400">{label}</p>
      <p className={`text-sm text-zinc-700 ${bold ? "font-medium text-zinc-900" : ""}`}>{value}</p>
    </div>
  );
}

function MetadataInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-800 outline-none focus:border-[#ff2442]"
      />
    </label>
  );
}

function AnalysisExtra({ raw }: { raw?: string }) {
  const data = parseAnalysis(raw);

  // 健壮地将字段转为 string[]，避免字符串/null 等意外类型
  function toStringArray(val: unknown): string[] {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
    if (typeof val === "string") return val.split("\n").map((s) => s.trim()).filter(Boolean);
    return [];
  }

  const selling = toStringArray(data.xhs_selling_points);
  const pairing = toStringArray(data.pairing_suggestions);
  const desc = typeof data.description === "string" ? data.description : undefined;

  if (!selling.length && !pairing.length && !desc) return null;

  return (
    <>
      {desc && (
        <div>
          <p className="text-xs text-zinc-400 mb-1">物品描述</p>
          <p className="text-xs text-zinc-600 leading-relaxed">{desc}</p>
        </div>
      )}
      {selling.length > 0 && (
        <div>
          <p className="text-xs text-zinc-400 mb-1">小红书卖点</p>
          <ul className="space-y-1">
            {selling.map((s, i) => (
              <li key={i} className="text-xs text-zinc-700 flex gap-1.5">
                <span className="text-[#ff2442] shrink-0">✦</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pairing.length > 0 && (
        <div>
          <p className="text-xs text-zinc-400 mb-1">搭配建议</p>
          <ul className="space-y-1">
            {pairing.map((s, i) => (
              <li key={i} className="text-xs text-zinc-600 flex gap-1.5">
                <span className="text-zinc-300 shrink-0">•</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
