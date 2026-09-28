import { useWorkspaceQuery as useQuery } from "../../lib/workspaceActivity";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useToast } from "../Toast";
import { IS_TAURI_RUNTIME } from "../../lib/local";
import { probeLocalAIProviders, type LocalAIProviderStatus } from "../../lib/localAi";
import {
  readAiRuntimeSettings,
  saveAiRuntimeSettings,
  type AiDefaultTargetKind,
  type AiRuntimeSettings,
} from "../../lib/aiRuntime";
import {
  deleteModelApiProvider,
  readModelApiSettings,
  upsertModelApiProvider,
  type ModelApiProviderView,
  type ModelApiSettingsView,
} from "../../lib/modelApi";
import DefaultModelPicker, { type DefaultPickerGroup } from "./DefaultModelPicker";
import ProviderModal from "./ProviderModal";
import LocalCliSection from "./LocalCliSection";
import { cliDefaultModelValues, cliModelLabel } from "./cliModels";

type SubTab = "providers" | "cli";

function SectionCard({ title, desc, children, action }: { title: string; desc?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h2>
          {desc ? <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">{desc}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function ModelApiSection({
  settings,
  onEdit,
  onCreate,
  onDelete,
}: {
  settings: ModelApiSettingsView | undefined;
  onEdit: (provider: ModelApiProviderView) => void;
  onCreate: () => void;
  onDelete: (provider: ModelApiProviderView) => void;
}) {
  const configured = (settings?.providers ?? []).filter((item) => item.configured);
  const unconfigured = (settings?.providers ?? []).filter((item) => !item.configured);

  function renderConfigured(provider: ModelApiProviderView) {
    const isDefault = settings?.defaultProviderId === provider.id;
    return (
      <div key={provider.id} className="rounded-xl border border-[var(--color-border)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">{provider.label}</p>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">已连接</span>
              {isDefault ? <span className="rounded-full bg-[var(--color-selected)] px-2 py-0.5 text-[11px] text-[var(--color-brand)]">默认</span> : null}
              <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                {provider.kind === "openai-compatible" ? "OpenAI 兼容" : "Anthropic 兼容"}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-[var(--color-text-secondary)]" title={provider.endpoint}>{provider.endpoint}</p>
            <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
              模型：{provider.model || "—"}
              {provider.enabledModels.length > 1 ? `（启用 ${provider.enabledModels.length}）` : ""}
              {` · Key ${provider.apiKeyMasked}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => onEdit(provider)} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
              管理
            </button>
            {!provider.builtin ? (
              <button
                type="button"
                onClick={() => onDelete(provider)}
                aria-label={`删除 ${provider.label}`}
                className="rounded-lg border border-red-200 p-1.5 text-red-600"
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function renderUnconfigured(provider: ModelApiProviderView) {
    return (
      <div key={provider.id} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-medium text-[var(--color-text-primary)]">{provider.label}</p>
            <span className="rounded-full bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
              {provider.kind === "openai-compatible" ? "OpenAI 兼容" : "Anthropic 兼容"}
            </span>
            <span className="truncate text-[11px] text-[var(--color-text-secondary)]" title={provider.endpoint}>
              {provider.model || provider.endpoint}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onEdit(provider)}
          className="shrink-0 rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-brand)]/50 hover:text-[var(--color-brand)]"
        >
          连接
        </button>
      </div>
    );
  }

  return (
    <SectionCard
      title="云端模型服务"
      desc="密钥只存在本机，读取视图脱敏。"
      action={
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-brand)]/50 hover:text-[var(--color-brand)]"
        >
          <Plus size={13} />
          添加自定义
        </button>
      }
    >
      {configured.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-[var(--color-text-secondary)]">已连接 · {configured.length}</p>
          {configured.map(renderConfigured)}
        </div>
      ) : null}
      {unconfigured.length > 0 ? (
        <div className={configured.length > 0 ? "mt-3 space-y-1.5" : "space-y-1.5"}>
          <p className="text-[11px] font-medium text-[var(--color-text-secondary)]">未添加</p>
          {unconfigured.map(renderUnconfigured)}
        </div>
      ) : null}
    </SectionCard>
  );
}

/**
 * AI 设置页：置顶「新会话默认使用」+ CLI/API 子 tab + 即时保存。
 */
export default function AiSettingsSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [subTab, setSubTab] = useState<SubTab>("providers");
  const [modalProvider, setModalProvider] = useState<ModelApiProviderView | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const { data: runtime, isLoading: runtimeLoading } = useQuery<AiRuntimeSettings>({
    queryKey: ["ai-runtime-settings"],
    queryFn: readAiRuntimeSettings,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 30_000,
  });
  const { data: modelApi, isLoading: modelApiLoading } = useQuery<ModelApiSettingsView>({
    queryKey: ["model-api-settings"],
    queryFn: readModelApiSettings,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 10_000,
  });
  const { data: localProviders = [], refetch: refetchProviders, isFetching: probing } = useQuery<LocalAIProviderStatus[]>({
    queryKey: ["local-ai-providers"],
    queryFn: probeLocalAIProviders,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 30_000,
  });

  const connectedModelProviders = (modelApi?.providers ?? []).filter((item) => item.configured);

  const pickerGroups = useMemo<DefaultPickerGroup[]>(() => {
    const groups: DefaultPickerGroup[] = [];
    // 下拉只展示启用清单（管理里勾选的模型）；扫描/新增先在管理弹窗勾选。
    for (const provider of connectedModelProviders) {
      const models = provider.enabledModels.length > 0 ? provider.enabledModels : (provider.model ? [provider.model] : []);
      if (models.length === 0) continue;
      groups.push({
        kind: "model-api",
        provider: provider.id,
        label: provider.label,
        entries: models.map((model) => ({
          key: `${provider.id}:${model}`,
          kind: "model-api" as AiDefaultTargetKind,
          provider: provider.id,
          providerLabel: provider.label,
          model,
          modelLabel: model,
          detail: provider.model === model ? "默认" : undefined,
        })),
      });
    }
    for (const provider of localProviders.filter((item) => item.state === "present")) {
      const enabled = runtime?.agentCli.enabledModels[provider.id] ?? [];
      const values = enabled.length > 0 ? enabled : cliDefaultModelValues(provider.id);
      groups.push({
        kind: "agent-cli",
        provider: provider.id,
        label: provider.label,
        entries: values.map((model) => ({
          key: `cli:${provider.id}:${model}`,
          kind: "agent-cli" as AiDefaultTargetKind,
          provider: provider.id,
          providerLabel: provider.label,
          model,
          modelLabel: cliModelLabel(provider.id, model),
          detail: provider.version,
        })),
      });
    }
    return groups;
  }, [connectedModelProviders, localProviders, runtime?.agentCli.enabledModels]);

  async function persistRuntime(next: AiRuntimeSettings, success: string) {
    try {
      const saved = await saveAiRuntimeSettings(next);
      qc.setQueryData(["ai-runtime-settings"], saved);
      toast(success, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  function applyDefault(kind: AiDefaultTargetKind, provider: string, model: string) {
    if (!runtime) {
      toast("AI 配置尚未加载完成，请稍后再试", "error");
      return;
    }
    // 选中即成为默认，并自动纳入启用清单：扫描到的新模型不必先去管理弹窗勾选。
    if (kind === "agent-cli") {
      const enabled = runtime.agentCli.enabledModels[provider] ?? [];
      const nextEnabled = model && !enabled.includes(model) ? [...enabled, model] : enabled;
      void persistRuntime(
        {
          ...runtime,
          defaultTarget: { kind, provider, model },
          agentCli: {
            ...runtime.agentCli,
            enabledModels: { ...runtime.agentCli.enabledModels, [provider]: nextEnabled },
          },
        },
        `新会话默认已设为 ${provider}${model ? ` · ${cliModelLabel(provider, model)}` : ""}`,
      );
      return;
    }
    const target = modelApi?.providers.find((item) => item.id === provider);
    if (target && model && !target.enabledModels.includes(model)) {
      void upsertModelApiProvider({
        id: target.id,
        kind: target.kind,
        label: target.label,
        endpoint: target.endpoint,
        apiKey: null,
        model: target.model || model,
        visionModel: target.visionModel,
        enabledModels: [...target.enabledModels, model],
      })
        .then((view) => qc.setQueryData(["model-api-settings"], view))
        .catch(() => undefined);
    }
    void persistRuntime(
      { ...runtime, defaultTarget: { kind, provider, model } },
      `新会话默认已设为 ${provider}${model ? ` · ${model}` : ""}`,
    );
  }

  async function onDeleteProvider(provider: ModelApiProviderView) {
    try {
      const view = await deleteModelApiProvider(provider.id);
      qc.setQueryData(["model-api-settings"], view);
      toast(`已删除 ${provider.label}`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  if (!IS_TAURI_RUNTIME) {
    return (
      <SectionCard title="AI 与 Agent" desc="浏览器预览仅作布局预览。桌面端（Tauri）提供完整多 Provider、默认模型与本地 CLI 管理。">
        <p className="text-xs text-[var(--color-text-secondary)]">请在桌面端配置 AI 接入。</p>
      </SectionCard>
    );
  }

  if (runtimeLoading || modelApiLoading) {
    return <p className="text-xs text-[var(--color-text-secondary)]">正在读取 AI 配置…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Noomd 式左右结构：左文案 / 右紧凑选择器 */}
      <div className="flex items-center justify-between gap-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-sm">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">新会话默认使用</p>
          <p className="text-xs text-[var(--color-text-secondary)]">只影响之后新建的会话；进行中的会话保持各自目标。</p>
        </div>
        <div className="w-full max-w-[min(260px,45%)] shrink-0">
          <DefaultModelPicker
            groups={pickerGroups}
            current={runtime ? runtime.defaultTarget : null}
            onApply={applyDefault}
          />
        </div>
      </div>

      <div className="flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        {([["providers", "API Provider", "OpenAI、Anthropic、兼容端点"], ["cli", "本地 CLI", "Claude Code、Codex、OpenCode"]] as [SubTab, string, string][]).map(([key, label, hint]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSubTab(key)}
            className={`flex-1 rounded-lg px-3 py-2 text-left transition ${subTab === key ? "bg-[var(--color-selected)]" : "hover:bg-[var(--color-surface-2)]"}`}
          >
            <span className={`block text-xs font-medium ${subTab === key ? "text-[var(--color-brand)]" : "text-[var(--color-text-primary)]"}`}>{label}</span>
            <span className="block text-[10px] text-[var(--color-text-secondary)]">{hint}</span>
          </button>
        ))}
      </div>

      {subTab === "providers" ? (
        <ModelApiSection
          settings={modelApi}
          onEdit={(provider) => {
            setModalProvider(provider);
            setModalOpen(true);
          }}
          onCreate={() => {
            const template: ModelApiProviderView = {
              id: "",
              kind: "openai-compatible",
              label: "",
              endpoint: "",
              configured: false,
              apiKeyMasked: "",
              model: "",
              visionModel: "",
              enabledModels: [],
              builtin: false,
              preset: null,
            };
            setModalProvider(template);
            setModalOpen(true);
          }}
          onDelete={(provider) => void onDeleteProvider(provider)}
        />
      ) : (
        <SectionCard title="本地 CLI" desc="引擎层。与 API Provider（通道）分层管理。">
          <LocalCliSection
            providers={localProviders}
            agentCli={runtime?.agentCli ?? { enabled: true, provider: "", workingDirectory: "", enabledModels: {}, modelPool: {} }}
            detecting={detecting || probing}
            onDetect={() => {
              setDetecting(true);
              void refetchProviders().finally(() => setDetecting(false));
            }}
            onChange={(next) => {
              if (!runtime) return;
              void persistRuntime({ ...runtime, agentCli: next }, "已保存");
            }}
          />
        </SectionCard>
      )}

      {modalOpen && modalProvider ? (
        <ProviderModal
          provider={modalProvider.id ? modalProvider : { ...modalProvider, id: modalProvider.id || "" }}
          onClose={() => {
            setModalOpen(false);
            setModalProvider(null);
          }}
          onSaved={(view) => qc.setQueryData(["model-api-settings"], view)}
        />
      ) : null}
    </div>
  );
}
