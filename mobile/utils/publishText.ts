import { stripMarkdownForXhs } from './xhsText';

/** 分享接收端未必使用 title 字段，标题必须同时包含在 message 内。 */
export function withShareTitle(title: string, message: string): string {
  const cleanTitle = stripMarkdownForXhs(title).replace(/\n+/g, ' ').trim();
  const body = message.trim();
  if (!cleanTitle) return body;
  if (body === cleanTitle || body.startsWith(`${cleanTitle}\n`)) return body;
  return [cleanTitle, body].filter(Boolean).join('\n\n');
}

export function buildPublishText(title: string, body: string, tags: string[]) {
  const cleanTitle = stripMarkdownForXhs(title).replace(/\n+/g, ' ').trim();
  let cleanBody = stripMarkdownForXhs(body);
  // 旧草稿可能把标题同时保存在正文首行，仅去掉完全相同的首行。
  if (cleanTitle && (cleanBody === cleanTitle || cleanBody.startsWith(`${cleanTitle}\n`))) {
    cleanBody = cleanBody.slice(cleanTitle.length).trim();
  }
  const presentTags = new Set(cleanBody.match(/#[^\s#]+/gu) ?? []);
  const uniqueTags = [...new Set(tags.map((tag) => tag.replace(/^#+/, '').trim()).filter(Boolean))];
  const missingTags = uniqueTags.filter((tag) => !presentTags.has(`#${tag}`));
  const bodyWithTags = [cleanBody, missingTags.map((tag) => `#${tag} `).join('')].filter(Boolean).join('\n\n');
  return { title: cleanTitle, bodyWithTags, fullText: withShareTitle(cleanTitle, bodyWithTags) };
}
