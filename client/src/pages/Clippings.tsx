import BrowserCollectionPanel from "../components/BrowserCollectionPanel";
import { useAccountContext } from "../lib/accountContext";

export default function Clippings() {
  const { accountAlias, ready } = useAccountContext();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--color-canvas)]">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-text-primary)]">剪藏</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">保存外部账号、笔记和图片素材，需要时再引用到创作流程。</p>
        </div>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
          保存到本地账号 <strong className="ml-1 font-semibold text-[var(--color-text-primary)]">{ready ? accountAlias || "当前账号" : "账号未就绪"}</strong>
        </div>
      </header>
      <BrowserCollectionPanel hideAccountLabel />
    </div>
  );
}
