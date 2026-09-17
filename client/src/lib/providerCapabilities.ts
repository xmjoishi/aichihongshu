/**
 * Static provider and local CLI capability declarations.
 *
 * A capability is false until this repository has evidence for the exact
 * adapter contract. A CLI being installed, or an API provider being named,
 * does not prove text, image, tools, or cancellation support.
 */
export type ProviderKind = "api" | "cli";
export type ProviderCapabilityName = "text" | "image" | "tools" | "cancel";
export type ProviderCapabilityStatus = "unknown" | "verified" | "unsupported";

export interface ProviderCapabilitySet {
  text: boolean;
  image: boolean;
  tools: boolean;
  cancel: boolean;
}

export interface ProviderCapabilityDescriptor {
  id: string;
  label: string;
  kind: ProviderKind;
  status: ProviderCapabilityStatus;
  capabilities: ProviderCapabilitySet;
  reason: string;
}

const UNKNOWN_CAPABILITIES: ProviderCapabilitySet = Object.freeze({
  text: false,
  image: false,
  tools: false,
  cancel: false,
});

function unknownProvider(id: string, label: string, kind: ProviderKind): ProviderCapabilityDescriptor {
  return Object.freeze({
    id,
    label,
    kind,
    status: "unknown",
    capabilities: UNKNOWN_CAPABILITIES,
    reason: "尚未完成该适配器的真实连接、输出和取消验证",
  });
}

export const STATIC_PROVIDER_CAPABILITIES = Object.freeze({
  minimax: unknownProvider("minimax", "MiniMax API", "api"),
  claude: unknownProvider("claude", "Claude CLI", "cli"),
  codex: unknownProvider("codex", "Codex CLI", "cli"),
  opencode: unknownProvider("opencode", "OpenCode CLI", "cli"),
});

export type StaticProviderId = keyof typeof STATIC_PROVIDER_CAPABILITIES;

export function getStaticProviderCapability(id: StaticProviderId): ProviderCapabilityDescriptor {
  return STATIC_PROVIDER_CAPABILITIES[id];
}
