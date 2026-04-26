import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { RiskConfirmationRequiredError } from "../lib/api";

interface PendingConfirm {
  resolve: (confirmed: boolean) => void;
  message: string;
  action: string;
  role: string;
  alias: string;
}

/**
 * 风险二次确认弹窗 + 调用 hook。
 *
 * 用法：
 *   const { confirmAndRetry, dialog } = useRiskConfirm();
 *   await confirmAndRetry((ack) => api.post(url, body, riskAckHeader(ack)));
 *   // 在组件 return 中：{dialog}
 *
 * 行为：
 *   1. 第一次调用 fn(false) 不带 ack → 后端可能 428 → 弹窗
 *   2. 用户输入"我知道风险"并确认 → fn(true) 带 ack header 重试
 *   3. 取消 → 抛 cancelled 错误
 */
export function useRiskConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [input, setInput] = useState("");

  const KEYWORD = "我知道风险";

  const ask = (action: string, role: string, alias: string, message: string): Promise<boolean> =>
    new Promise((resolve) => {
      setInput("");
      setPending({ resolve, message, action, role, alias });
    });

  const close = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
    setInput("");
  };

  /**
   * 包装一个会被 protection guard 拦截的请求：
   * - 第一次不带 ack 调用
   * - 若抛 RiskConfirmationRequiredError，弹窗确认后带 ack 重试
   */
  const confirmAndRetry = async <T,>(fn: (ack: boolean) => Promise<T>): Promise<T> => {
    try {
      return await fn(false);
    } catch (e) {
      if (!(e instanceof RiskConfirmationRequiredError)) throw e;
      const ok = await ask(e.action, e.role, e.alias, e.message);
      if (!ok) throw new Error("用户取消了风险确认");
      return await fn(true);
    }
  };

  const dialog = pending ? (
    <div className="fixed inset-0 z-[120] bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl overflow-hidden">
        <div className="bg-amber-50 border-b border-amber-100 px-5 py-3 flex items-center gap-2">
          <AlertTriangle size={20} className="text-amber-500" />
          <h3 className="font-semibold text-zinc-800">高风险操作二次确认</h3>
        </div>
        <div className="p-5 space-y-3 text-sm text-zinc-700">
          <p>{pending.message}</p>
          <div className="bg-zinc-50 rounded-lg p-3 text-xs space-y-1">
            <div>动作：<b>{pending.action}</b></div>
            <div>当前账号：<b>{pending.alias}</b>（{pending.role}）</div>
          </div>
          <div className="text-amber-600 text-xs">
            提示：执行此操作可能触发小红书风控，请在文本框输入「<b>{KEYWORD}</b>」表示确认。
          </div>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`请输入「${KEYWORD}」`}
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 focus:border-amber-400 focus:outline-none text-sm"
            autoFocus
          />
        </div>
        <div className="px-5 py-3 bg-zinc-50 border-t border-zinc-100 flex justify-end gap-2">
          <button
            onClick={() => close(false)}
            className="px-4 py-1.5 rounded-lg text-sm text-zinc-600 hover:bg-zinc-100"
          >
            取消
          </button>
          <button
            onClick={() => close(true)}
            disabled={input.trim() !== KEYWORD}
            className="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            我已确认风险，继续执行
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirmAndRetry, dialog };
}
