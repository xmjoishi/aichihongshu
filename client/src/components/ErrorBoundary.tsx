import React from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string;
  copied: boolean;
  copyError: boolean;
}

export function buildErrorReport(error: unknown, componentStack = ""): string {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : "";
  const route = typeof window !== "undefined" ? window.location.href : "";
  return [
    "aichihongshu render error",
    route ? `route: ${route}` : "",
    `message: ${message}`,
    stack ? `stack:\n${stack}` : "",
    componentStack ? `componentStack:\n${componentStack.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: "",
    copied: false,
    copyError: false,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error, copied: false, copyError: false };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const componentStack = errorInfo.componentStack ?? "";
    const report = buildErrorReport(error, componentStack);
    this.setState({ componentStack });
    try {
      window.localStorage.setItem("aichihongshu:last-render-error", report);
    } catch {
      // localStorage can be unavailable in restricted WebView states.
    }
    console.error("[aichihongshu] render error", error, errorInfo);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null, componentStack: "", copied: false, copyError: false });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleCopy = async (): Promise<void> => {
    const { error, componentStack } = this.state;
    if (!error) return;
    try {
      await copyText(buildErrorReport(error, componentStack));
      this.setState({ copied: true, copyError: false });
    } catch (copyCause) {
      console.error("[aichihongshu] copy render error report failed", copyCause);
      this.setState({ copied: false, copyError: true });
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const { error, componentStack, copied, copyError } = this.state;
    const report = buildErrorReport(error, componentStack);

    return (
      <div className="flex min-h-full items-center justify-center overflow-auto bg-[var(--color-canvas)] p-6">
        <section className="w-full max-w-3xl rounded-2xl border border-red-200 bg-[var(--color-surface)] p-8 shadow-xl">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-2xl">😵</div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">页面出错了</h1>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                当前页面已停止渲染。请复制错误报告发给我，报告包含错误信息和组件位置，便于继续分析。
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-red-100 bg-red-50 px-4 py-3" role="alert">
            <p className="text-xs font-medium text-red-700">错误信息</p>
            <p className="mt-1 break-words text-sm text-red-800">{error?.message || "未知渲染错误"}</p>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={this.handleReload} className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white hover:opacity-90">重新加载</button>
            <button type="button" onClick={this.handleRetry} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]">重试渲染</button>
            <button type="button" onClick={() => void this.handleCopy()} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]">{copied ? "已复制错误报告" : "复制错误报告"}</button>
          </div>
          {copyError && <p className="mt-2 text-xs text-red-600">复制失败，请展开下方详情后手动选择复制。</p>}

          <details className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
            <summary className="cursor-pointer select-none text-sm font-medium text-[var(--color-text-primary)]">展开错误详情（包含组件堆栈）</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs leading-relaxed text-[var(--color-text-secondary)] select-text">{report}</pre>
          </details>
        </section>
      </div>
    );
  }
}
