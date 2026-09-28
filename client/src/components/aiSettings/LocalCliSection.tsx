import { useState } from "react";
import { RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useToast } from "../Toast";
import type { LocalAIProviderStatus } from "../../lib/localAi";
import type { AiAgentCliSettings } from "../../lib/aiRuntime";
import { listLocalCliModels, type CliModelCacheEntry } from "../../lib/aiRuntime";
import { cliDefaultModelValues, cliModelLabel } from "./cliModels";

interface Props {
  providers: LocalAIProviderStatus[];
  agentCli: AiAgentCliSettings;
  detecting: boolean;
  onDetect: () => void;
  onChange: (next: AiAgentCliSettings) => void;
}

const CLI_CATALOG = [
  { id: "claude", label: "Claude CLI", mark: "C" },
  { id: "codex", label: "Codex CLI", mark: "X" },
  { id: "opencode", label: "OpenCode CLI", mark: "O" },
] as const;

/** 本地 CLI 卡片：三态、启用模型清单管理、移除/重连。 */
export default function LocalCliSection({ providers, agentCli, detecting, onDetect, onChange }: Props) {
  const { toast } = useToast();
  const [manageId, setManageId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState("");
  const [modelsDraft, setModelsDraft] = useState<string[]>([]);
  const [pool, setPool] = useState<string[]>([]);
  const [scanned, setScanned] = useState<CliModelCacheEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const statusMap = new Map(providers.map((item) => [item.id, item]));

  function openManage(providerId: string) {
    setManageId(providerId);
    // 读持久化扫描缓存：下次进入仍在，只有点「刷新模型」才更新
    const cached = agentCli.modelPool[providerId] ?? [];
    setScanned(cached);
    const preset = cliDefaultModelValues(providerId);
    const enabled = agentCli.enabledModels[providerId] ?? [];
    const list = enabled.length > 0 ? enabled : preset;
    setModelsDraft(list);
    setPool(Array.from(new Set([...preset, ...cached.map((item) => item.value), ...list])));
    setScanMessage(null);
    setManualModel("");
  }

  async function scanModels() {
    if (!manageId) return;
    setScanning(true);
    setScanMessage(null);
    try {
      const models = await listLocalCliModels(manageId);
      setScanned(models);
      setPool((current) => Array.from(new Set([...current, ...models.map((item) => item.value)])));
      // 持久化扫描池，下次进入直接可见；刷新才会覆盖
      onChange({
        ...agentCli,
        modelPool: { ...agentCli.modelPool, [manageId]: models },
      });
      setScanMessage(`已更新 ${models.length} 个模型`);
      toast(`已刷新 ${models.length} 个模型`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScanMessage(message);
      toast(message, "error");
    } finally {
      setScanning(false);
    }
  }

  function saveManaged() {
    if (!manageId) return;
    onChange({
      ...agentCli,
      enabledModels: { ...agentCli.enabledModels, [manageId]: modelsDraft },
    });
    setManageId(null);
    toast("CLI 启用模型已保存", "success");
  }

  function removeCli(providerId: string) {
    setRemoved((current) => Array.from(new Set([...current, providerId])));
    if (agentCli.provider === providerId) {
      onChange({ ...agentCli, provider: "" });
    }
    toast("已移除该 CLI（可重新添加）", "success");
  }

  function addCli(providerId: string) {
    setRemoved((current) => current.filter((item) => item !== providerId));
    toast("已重新添加", "success");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          仅检测当前桌面进程 PATH 中的 CLI，不读取或写入 API Key、全局配置和登录凭据。安装状态不代表已登录；只有真实调用验证后才开放对应能力。
        </p>
        <button
          type="button"
          onClick={onDetect}
          disabled={detecting}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50"
        >
          <RefreshCw size={12} className={detecting ? "animate-spin" : ""} />
          重新检测
        </button>
      </div>

      <div className="space-y-2">
        {CLI_CATALOG.map((cli) => {
          const status = statusMap.get(cli.id);
          const isRemoved = removed.includes(cli.id);
          const available = status?.state === "present" && !isRemoved;
          const stateLabel = isRemoved ? "已移除" : status?.state === "present" ? "已添加" : status?.state === "missing" ? "未安装" : status ? "检测失败" : "未检测";
          const dotClass = isRemoved
            ? "bg-zinc-300"
            : status?.state === "present"
              ? "bg-emerald-500"
              : status?.state === "missing"
                ? "bg-zinc-300"
                : "bg-amber-500";
          return (
            <div key={cli.id} className="rounded-xl border border-[var(--color-border)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-selected)] text-xs font-semibold text-[var(--color-brand)]">
                    {cli.mark}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-[var(--color-text-primary)]">{cli.label}</p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
                        {stateLabel}
                      </span>
                      {agentCli.provider === cli.id ? (
                        <span className="rounded-full bg-[var(--color-selected)] px-2 py-0.5 text-[11px] text-[var(--color-brand)]">默认 CLI</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                      {status?.version ?? status?.reason ?? "尚未检测"}
                      {(agentCli.enabledModels[cli.id]?.length ?? 0) > 0 ? ` · 启用模型 ${agentCli.enabledModels[cli.id].length}` : ""}
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => openManage(cli.id)}
                  disabled={!available}
                  className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-brand)] px-2.5 py-1.5 text-xs text-white disabled:opacity-40"
                >
                  <Settings2 size={12} />
                  管理
                </button>
                {isRemoved ? (
                  <button type="button" onClick={() => addCli(cli.id)} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                    重新添加
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => removeCli(cli.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs text-red-600"
                  >
                    <Trash2 size={12} />
                    移除
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {manageId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setManageId(null)}>
          <div className="w-full max-w-md rounded-2xl bg-[var(--color-surface)] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">管理启用模型</h3>
                <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">勾选后出现在会话模型列表；取消勾选不会删除其他配置。</p>
              </div>
              <button
                type="button"
                onClick={() => void scanModels()}
                disabled={scanning}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] disabled:opacity-50"
              >
                <RefreshCw size={11} className={scanning ? "animate-spin" : ""} />
                {scanning ? "扫描中…" : "刷新模型"}
              </button>
            </div>
            {scanMessage ? (
              <p className={`mt-1 text-[11px] ${scanMessage.startsWith("已更新") ? "text-emerald-600" : "text-red-600"}`}>{scanMessage}</p>
            ) : null}
            <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-xl border border-[var(--color-border)] p-2">
              {pool.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-[var(--color-text-secondary)]">尚未启用模型；可点击「刷新模型」扫描或手动添加。</p>
              ) : null}
              {pool.map((item) => {
                const hit = scanned.find((model) => model.value === item);
                const checked = modelsDraft.includes(item);
                return (
                  <label key={item} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--color-surface-2)]">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setModelsDraft((current) =>
                          checked ? current.filter((value) => value !== item) : Array.from(new Set([...current, item])),
                        )
                      }
                      className="accent-[var(--color-brand)]"
                    />
                    <span className="min-w-0 flex-1 truncate">{hit?.label ?? cliModelLabel(manageId ?? "", item)}</span>
                    {hit && hit.source !== "default" ? (
                      <span className="shrink-0 rounded-full bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                        {hit.source === "discovered" ? "已扫描" : "配置"}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                className="h-8 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                placeholder="手动添加模型 ID"
              />
              <button
                type="button"
                onClick={() => {
                  const value = manualModel.trim();
                  if (!value) return;
                  setPool((current) => (current.includes(value) ? current : [...current, value]));
                  setModelsDraft((current) => (current.includes(value) ? current : [...current, value]));
                  setManualModel("");
                }}
                className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
              >
                添加
              </button>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setManageId(null)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)]">
                取消
              </button>
              <button type="button" onClick={saveManaged} className="rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-xs text-white">
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
