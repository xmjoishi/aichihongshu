/** 本地 CLI 预置模型清单（对齐 Noomd）。 */

export const CLI_DEFAULT_MODELS: Record<string, Array<{ value: string; label: string }>> = {
  claude: [
    { value: "default", label: "默认模型" },
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [{ value: "default", label: "默认模型" }],
  opencode: [{ value: "default", label: "默认模型" }],
};

export function cliModelLabel(provider: string, value: string): string {
  const hit = CLI_DEFAULT_MODELS[provider]?.find((item) => item.value === value);
  return hit?.label ?? (value === "default" ? "默认模型" : value);
}

export function cliDefaultModelValues(provider: string): string[] {
  return (CLI_DEFAULT_MODELS[provider] ?? [{ value: "default", label: "默认模型" }]).map((item) => item.value);
}
