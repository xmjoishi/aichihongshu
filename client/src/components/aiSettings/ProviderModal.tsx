import { useEffect, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { useToast } from "../Toast";
import { listModelApiModels } from "../../lib/aiRuntime";
import {
  testModelApiProvider,
  upsertModelApiProvider,
  type ModelApiProviderInput,
  type ModelApiProviderKind,
  type ModelApiProviderView,
  type ModelApiSettingsView,
} from "../../lib/modelApi";

const inputCls =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]/30 focus:border-[var(--color-brand)]";

interface Props {
  provider: ModelApiProviderView | null;
  onClose: () => void;
  onSaved: (view: ModelApiSettingsView) => void;
}

/** Provider 管理弹窗：连接信息 + 启用模型清单（勾选/全选/刷新/手动添加），保存即落盘。 */
export default function ProviderModal({ provider, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<ModelApiProviderKind>("openai-compatible");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [touchKey, setTouchKey] = useState(false);
  const [model, setModel] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [pool, setPool] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    setLabel(provider.label);
    setKind(provider.kind);
    setEndpoint(provider.endpoint);
    setApiKey(provider.apiKeyMasked);
    setTouchKey(false);
    setModel(provider.model);
    setVisionModel(provider.visionModel);
    setEnabledModels(provider.enabledModels);
    setPool(provider.enabledModels);
    setManual("");
  }, [provider]);

  if (!provider) return null;

  const displayModels = Array.from(new Set([...pool, ...enabledModels]));
  const selectedInList = displayModels.filter((item) => enabledModels.includes(item)).length;

  function toggleModel(value: string) {
    setEnabledModels((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  }

  function toggleAll() {
    const allSelected = displayModels.every((item) => enabledModels.includes(item));
    if (allSelected) {
      // 保留列表外手动启用值，只清除当前可见集合。
      const visible = new Set(displayModels);
      setEnabledModels((current) => current.filter((item) => !visible.has(item)));
    } else {
      setEnabledModels((current) => Array.from(new Set([...current, ...displayModels])));
    }
  }

  async function refreshModels() {
    if (!provider?.id) {
      toast("新建 Provider 请先保存，保存后可刷新模型；也可手动添加模型 ID", "error");
      return;
    }
    setScanning(true);
    try {
      const view = await listModelApiModels(provider.id);
      setPool(view);
      setEnabledModels((current) => Array.from(new Set([...current, ...view.filter((item: string) => item === model)])));
      toast(`已加载 ${view.length} 个模型`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setScanning(false);
    }
  }

  function addManual() {
    const value = manual.trim();
    if (!value) return;
    setPool((current) => (current.includes(value) ? current : [...current, value]));
    setEnabledModels((current) => (current.includes(value) ? current : [...current, value]));
    setManual("");
  }

  async function testConnection() {
    if (!provider?.id || !provider.configured) {
      toast("请先保存配置后再测试连接", "error");
      return;
    }
    setTesting(true);
    setTestMessage(null);
    try {
      const message = await testModelApiProvider(provider.id);
      setTestMessage(message);
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!label.trim() || !endpoint.trim()) {
      toast("请填写名称与 Endpoint", "error");
      return;
    }
    setBusy(true);
    try {
      const input: ModelApiProviderInput = {
        id: provider!.id,
        kind,
        label: label.trim(),
        endpoint: endpoint.trim(),
        apiKey: touchKey ? apiKey : null,
        model: model.trim(),
        visionModel: visionModel.trim(),
        enabledModels: enabledModels.length > 0 ? enabledModels : (model.trim() ? [model.trim()] : []),
      };
      const view = await upsertModelApiProvider(input);
      onSaved(view);
      toast("Provider 已保存", "success");
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{provider.builtin ? `管理 ${label || provider.label}` : "编辑 Provider"}</h3>
            <p className="text-[11px] text-[var(--color-text-secondary)]">配置与密钥保存在本机，保存后立即生效</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded-lg p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-[var(--color-text-secondary)]">名称</span>
              <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-[var(--color-text-secondary)]">协议</span>
              <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as ModelApiProviderKind)}>
                <option value="openai-compatible">OpenAI 兼容</option>
                <option value="anthropic-compatible">Anthropic 兼容</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-[var(--color-text-secondary)]">Endpoint</span>
            <input className={inputCls} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-[var(--color-text-secondary)]">API Key {provider.configured && !touchKey ? "（已保存，聚焦后可覆盖）" : ""}</span>
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              value={apiKey}
              onFocus={() => {
                if (!touchKey) {
                  setApiKey("");
                  setTouchKey(true);
                }
              }}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTouchKey(true);
              }}
              placeholder="sk-…"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-[var(--color-text-secondary)]">默认模型</span>
              <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-[var(--color-text-secondary)]">视觉模型（可选）</span>
              <input className={inputCls} value={visionModel} onChange={(e) => setVisionModel(e.target.value)} />
            </label>
          </div>

          <div className="rounded-xl border border-[var(--color-border)]">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-[var(--color-text-primary)]">启用模型</span>
                <span className="text-[11px] text-[var(--color-text-secondary)]">已启用 {selectedInList}/{displayModels.length}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]"
                >
                  全选
                </button>
                <button
                  type="button"
                  onClick={() => void refreshModels()}
                  disabled={scanning}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] disabled:opacity-50"
                >
                  <RefreshCw size={11} className={scanning ? "animate-spin" : ""} />
                  {scanning ? "加载中…" : "刷新模型"}
                </button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto p-2">
              {displayModels.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-[var(--color-text-secondary)]">
                  未扫描到模型；可点击「刷新模型」或手动添加。
                </p>
              ) : null}
              {displayModels.map((item) => (
                <label key={item} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-[var(--color-surface-2)]">
                  <input type="checkbox" checked={enabledModels.includes(item)} onChange={() => toggleModel(item)} className="accent-[var(--color-brand)]" />
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{item}</span>
                  {item === model ? <span className="shrink-0 text-[10px] text-[var(--color-brand)]">默认</span> : null}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-2">
              <input
                className={inputCls}
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addManual();
                  }
                }}
                placeholder="手动添加模型 ID"
              />
              <button type="button" onClick={addManual} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                <Plus size={12} />
                添加
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={testing || !provider.configured}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50"
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            {testMessage ? (
              <p className={`mt-1 truncate text-[11px] ${testMessage.startsWith("连接成功") ? "text-emerald-600" : "text-red-600"}`} title={testMessage}>
                {testMessage}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)]">
              取消
            </button>
            <button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg bg-[var(--color-brand)] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
