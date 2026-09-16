import { useEffect, useId, useRef, type ReactNode } from "react";

export const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-action-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-50";

export function Dialog({
  title,
  description,
  children,
  onClose,
  footer,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
            {description && <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{description}</p>}
          </div>
          <button ref={closeRef} type="button" aria-label="关闭" onClick={onClose} className="rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]">×</button>
        </div>
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </section>
    </div>
  );
}

// 状态 Badge
const STATUS_MAP = {
  draft: { label: "草稿", cls: "bg-zinc-100 text-zinc-500" },
  ready: { label: "待发", cls: "bg-amber-100 text-amber-600" },
  published: { label: "已发", cls: "bg-green-100 text-green-600" },
};

export function StatusBadge({ status }: { status: string }) {
  const normalized = status === "ready" ? "待发布" : status === "published" ? "已发布" : status === "draft" ? "草稿" : status;
  const s = STATUS_MAP[status as keyof typeof STATUS_MAP] ?? STATUS_MAP.draft;
  return (
    <span aria-label={`状态：${normalized}`} className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.cls}`}>
      {normalized}
    </span>
  );
}

// 标签 Chip
export function Tag({ label }: { label: string }) {
  return (
    <span className="text-xs bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">
      #{label}
    </span>
  );
}

// 空状态
export function Empty({ message = "暂无数据" }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-zinc-400 gap-2">
      <span className="text-3xl">📭</span>
      <p className="text-sm">{message}</p>
    </div>
  );
}

// 加载中
export function Spinner() {
  return (
    <div className="flex items-center justify-center h-48">
      <div className="w-6 h-6 border-2 border-[#ff2442] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// 数字卡片
export function StatCard({
  label, value, sub,
}: {
  label: string; value: string | number; sub?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="mb-1 text-xs text-[var(--color-text-secondary)]">{label}</p>
      <p className="text-2xl font-semibold text-[var(--color-text-primary)]">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{sub}</p>}
    </div>
  );
}
