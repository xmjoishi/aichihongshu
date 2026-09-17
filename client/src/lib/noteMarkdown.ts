export interface NoteMarkdownInput {
  title?: string;
  body?: string;
  tags: string[];
  status: string;
  createdAt?: string;
  itemTitle?: string;
  coverDesc?: string;
}

/** Keeps the legacy export shape while allowing a local note to export without HTTP. */
export function noteToMarkdown(note: NoteMarkdownInput): string {
  const lines: string[] = [];
  if (note.title?.trim()) lines.push(`# ${note.title.trim()}`);
  if (note.itemTitle?.trim()) lines.push(`\n> 物品：${note.itemTitle.trim()}\n`);
  if (note.coverDesc?.trim()) lines.push(`**封面文案**：${note.coverDesc.trim()}\n`);
  if (note.body?.trim()) lines.push(note.body.trim());
  const tags = note.tags.map((tag) => tag.trim()).filter(Boolean).map((tag) => `#${tag.replace(/^#+/, "")}`);
  if (tags.length > 0) lines.push(`\n${tags.join(" ")}`);
  lines.push(`\n---\n*状态：${note.status} | 创建：${note.createdAt ?? "未知"}*`);
  return lines.join("\n");
}
