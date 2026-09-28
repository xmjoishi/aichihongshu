export type AIIntent =
  | "edit-note"
  | "create-note"
  | "conversation"
  | "data-analysis"
  | "persona-query"
  | "persona-update"
  | "other";

export type AIResponseBlock =
  | { type: "markdown"; content: string }
  | { type: "note-draft"; title?: string; body?: string; tags: string[] }
  | { type: "metrics"; items: Array<{ label: string; value: string; detail?: string }> }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "persona-fields"; fields: Array<{ label: string; value: string }> }
  | { type: "diff"; items: Array<{ label: string; before?: string; after?: string }> }
  | { type: "checklist"; items: Array<{ label: string; done?: boolean }> };

export interface AIResponseReference {
  type: "note" | "asset" | "inspiration" | "account";
  id: string;
  title: string;
}

export interface AIResponseSuggestion {
  label: string;
  text: string;
}

export interface AIResponseAction {
  id: string;
  params?: Record<string, unknown>;
}

export interface AIResponseEnvelope {
  intent: AIIntent;
  confidence?: number;
  blocks: AIResponseBlock[];
  references: AIResponseReference[];
  suggestions: AIResponseSuggestion[];
  actions: AIResponseAction[];
}

function asText(value: unknown, maxLength = 12_000): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function textList(value: unknown, limit = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => {
    if (typeof item === "string" || typeof item === "number") return String(item).slice(0, 1_000);
    return "";
  }).filter(Boolean);
}

function normalizeBlock(value: unknown): AIResponseBlock | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case "markdown": {
      const content = asText(block.content);
      return content ? { type: "markdown", content } : null;
    }
    case "note-draft": {
      const title = asText(block.title, 500);
      const body = asText(block.body);
      const tags = textList(block.tags, 50).map((tag) => tag.replace(/^#+/, "")).filter(Boolean);
      return title || body || tags.length ? { type: "note-draft", title, body, tags } : null;
    }
    case "metrics": {
      const items = Array.isArray(block.items) ? block.items.slice(0, 24).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const label = asText(row.label, 160);
        const value = asText(String(row.value ?? ""), 300);
        return label && value ? [{ label, value, ...(asText(row.detail, 500) ? { detail: asText(row.detail, 500) } : {}) }] : [];
      }) : [];
      return items.length ? { type: "metrics", items } : null;
    }
    case "table": {
      const columns = textList(block.columns, 12);
      const rows = Array.isArray(block.rows) ? block.rows.slice(0, 100).map((row) => textList(row, 12)) : [];
      return columns.length ? { type: "table", columns, rows: rows.map((row) => row.slice(0, columns.length)) } : null;
    }
    case "persona-fields": {
      const fields = Array.isArray(block.fields) ? block.fields.slice(0, 40).flatMap((field) => {
        if (!field || typeof field !== "object") return [];
        const row = field as Record<string, unknown>;
        const label = asText(row.label, 160);
        const fieldValue = asText(String(row.value ?? ""), 2_000);
        return label && fieldValue ? [{ label, value: fieldValue }] : [];
      }) : [];
      return fields.length ? { type: "persona-fields", fields } : null;
    }
    case "diff": {
      const items = Array.isArray(block.items) ? block.items.slice(0, 40).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const label = asText(row.label, 160);
        if (!label) return [];
        return [{ label, ...(asText(row.before, 2_000) ? { before: asText(row.before, 2_000) } : {}), ...(asText(row.after, 2_000) ? { after: asText(row.after, 2_000) } : {}) }];
      }) : [];
      return items.length ? { type: "diff", items } : null;
    }
    case "checklist": {
      const items = Array.isArray(block.items) ? block.items.slice(0, 60).flatMap((item) => {
        if (typeof item === "string") return item.trim() ? [{ label: item.slice(0, 1_000) }] : [];
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const label = asText(row.label, 1_000);
        return label ? [{ label, ...(typeof row.done === "boolean" ? { done: row.done } : {}) }] : [];
      }) : [];
      return items.length ? { type: "checklist", items } : null;
    }
    default:
      return null;
  }
}

function parseJsonEnvelope(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some providers wrap the JSON in a short preamble. Accept only the first
    // complete object so ordinary prose remains a safe Markdown fallback.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  }
}

export function parseAIResponse(content: string): AIResponseEnvelope | null {
  const value = parseJsonEnvelope(content);
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.blocks)) return null;
  const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : undefined;
  if (confidence != null && confidence < 0.45) return null;
  const intents: AIIntent[] = ["edit-note", "create-note", "conversation", "data-analysis", "persona-query", "persona-update", "other"];
  const intent = intents.includes(raw.intent as AIIntent) ? raw.intent as AIIntent : "other";
  const blocks = raw.blocks.slice(0, 40).map(normalizeBlock).filter((block): block is AIResponseBlock => block !== null);
  if (blocks.length === 0) return null;
  const references: AIResponseReference[] = Array.isArray(raw.references) ? raw.references.slice(0, 30).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const reference = item as Record<string, unknown>;
    const type = reference.type;
    const id = reference.id;
    const title = asText(reference.title, 300);
    if (!(type === "note" || type === "asset" || type === "inspiration" || type === "account") || (typeof id !== "string" && typeof id !== "number") || !title) return [];
    return [{ type, id: String(id).slice(0, 100), title }];
  }) : [];
  const suggestions: AIResponseSuggestion[] = Array.isArray(raw.suggestions) ? raw.suggestions.slice(0, 6).flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [{ label: item.slice(0, 80), text: item.slice(0, 1_000) }] : [];
    if (!item || typeof item !== "object") return [];
    const suggestion = item as Record<string, unknown>;
    const text = asText(suggestion.text, 1_000)?.trim();
    return text ? [{ label: asText(suggestion.label, 80)?.trim() || text.slice(0, 36), text }] : [];
  }) : [];
  const actions: AIResponseAction[] = Array.isArray(raw.actions) ? raw.actions.slice(0, 20).flatMap((item) => {
    const action = typeof item === "string" ? { id: item } : item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!action || typeof action.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(action.id)) return [];
    const params = action.params && typeof action.params === "object" && !Array.isArray(action.params)
      ? action.params as Record<string, unknown>
      : undefined;
    return [{ id: action.id, ...(params ? { params } : {}) }];
  }) : [];
  return { intent, ...(confidence != null ? { confidence } : {}), blocks, references, suggestions, actions };
}
