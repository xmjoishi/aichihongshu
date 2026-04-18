import React from "react";

interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  State
> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-400 p-8">
          <span className="text-4xl">😵</span>
          <p className="text-sm font-medium text-zinc-600">页面出错了</p>
          <p className="text-xs text-center max-w-sm">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="text-xs bg-zinc-100 hover:bg-zinc-200 px-3 py-1.5 rounded-lg"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
