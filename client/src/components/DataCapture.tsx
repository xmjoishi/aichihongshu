import { CloudDownload } from "lucide-react";
import { openInSystemBrowser } from "../lib/api";
import { useToast } from "./Toast";

/**
 * 统一「数据抓取」入口：只在浏览器打开目标链接，由用户点扩展按钮完成当前页解析。
 * 覆盖笔记 / 主页 / 榜样等一切需要抓取的 URL；禁止在此做批量或定时。
 * 必须用系统浏览器 opener（openInBrowser 走旧爬虫接口，Rust 本地态下会静默失败）。
 */
export function DataCaptureButton({
  url,
  title,
  size = "sm",
  className = "",
  label = "数据抓取",
}: {
  url: string | undefined | null;
  title?: string;
  size?: "sm" | "xs";
  className?: string;
  label?: string;
}) {
  const { toast } = useToast();
  if (!url) return null;
  const iconSize = size === "xs" ? 10 : 12;
  return (
    <button
      type="button"
      title={title ?? "数据抓取（浏览器打开后点扩展按钮）"}
      className={
        className
        || `flex items-center gap-1 text-xs text-zinc-600 border border-zinc-200 bg-white px-2.5 py-1 rounded-lg hover:bg-zinc-50 transition-colors ${
          size === "xs" ? "text-[10px] px-1.5 py-0.5" : ""
        }`
      }
      onClick={(e) => {
        e.stopPropagation();
        void openInSystemBrowser(url)
          .then(() => toast("已在浏览器打开本条链接；点扩展按钮保存快照", "info"))
          .catch((error) => toast(`打开浏览器失败：${(error as Error).message}`, "error"));
      }}
    >
      <CloudDownload size={iconSize} />
      {label}
    </button>
  );
}

/** 无按钮样式变体（图标条/行内） */
export function DataCaptureIconAction({
  url,
  title,
}: {
  url: string | undefined | null;
  title?: string;
}) {
  return (
    <DataCaptureButton
      url={url}
      title={title}
      size="xs"
      label="数据抓取"
      className="flex items-center gap-1 text-[10px] text-zinc-600 border border-zinc-200 bg-white px-1.5 py-0.5 rounded-md hover:bg-zinc-50 transition-colors"
    />
  );
}
