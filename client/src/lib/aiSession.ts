import type { AIMessage, AIRunMetadata } from "../hooks/useAIStream";

/** Lightweight in-process event bus used by every AI host in the same WebView. */
export interface AISessionEvent {
  sessionKey: string;
  messages?: AIMessage[];
  streaming?: string;
  loading?: boolean;
  error?: string | null;
  run?: AIRunMetadata | null;
}
const listeners = new Set<(event: AISessionEvent) => void>();

export function publishAISession(event: AISessionEvent): void {
  listeners.forEach((listener) => listener(event));
}

export function subscribeAISession(listener: (event: AISessionEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
