/**
 * 小红书纯文本处理 — 小红书编辑器不识别 Markdown，生成/保存正文时要清掉。
 * 同时去掉 AI 的会话式废话，只留可直接发布的正文。
 */

export function stripMarkdownForXhs(text: string): string {
  if (!text) return '';
  let t = text.replace(/\r\n/g, '\n');

  // 围栏代码块：保留内容，去掉 ```
  t = t.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, '$1');
  t = t.replace(/```/g, '');

  // 行内代码
  t = t.replace(/`([^`]+)`/g, '$1');

  // 粗体 / 斜体 / 删除线
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/___([^_]+)___/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/_([^_]+)_/g, '$1');
  t = t.replace(/~~([^~]+)~~/g, '$1');

  // 链接 / 图片：只留文字
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 标题 #
  t = t.replace(/^#{1,6}\s+/gm, '');

  // 引用
  t = t.replace(/^\s*>\s?/gm, '');

  // 无序 / 有序列表
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');

  // 分隔线 / 省略号行
  t = t.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
  t = t.replace(/^\s*\.{3,}\s*$/gm, '');

  // 表格行：去掉竖线，保留单元格文字
  t = t.replace(/^\|(.+)\|\s*$/gm, (line) =>
    line.replace(/^\||\|$/g, '').replace(/\|/g, ' ').trim()
  );
  t = t.replace(/^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+$/gm, '');

  // 去掉残留的加粗/标题标记符号
  t = t.replace(/^[#*>\-\s]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** 标题只保留一行纯文本（去掉 emoji/「标题：」前缀、#、加粗、引号） */
export function stripMarkdownForXhsTitle(text: string): string {
  const oneLine = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  return oneLine
    .replace(/^[^\p{L}\p{N}]+/u, '') // 去掉行首 emoji/符号
    .replace(/^(标题|title)\s*[:：]\s*/i, '')
    .replace(/^["「『]|["」』]$/g, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*|__|~~|`/g, '')
    .trim();
}

/** 会话式开头/结尾废话（不是发帖内容） */
const FILLER_LINE_RE =
  /^(谁懂啊[!!！]*|救命[!!！]*|啊啊啊[!!！]*|今天(给大家)?(分享|推荐)|下面(是|分享)|希望(对)?(你|大家)(有)?(帮助|参考)|如果(你)?(喜欢|觉得有用)|快去试试(吧)?|赶紧收藏|码住[!!！]*|点赞收藏|记得(点赞|收藏|关注)|写在前面|正文如下|以下是(正文|内容)|综上(所述)?|总结一下[：:]?|好了[，,](今天)?(就|先)(到这|分享)|让我们(一起)?(开始|看看)|废话不多说[，,]?|话不多说[，,]?|ok[，,]|好的[，,]|首先[，,]?我们|接下来[，,]?我们|下面是正文|附上正文|草稿如下|内容如下|output[:：]?|title[:：]?|body[:：]?|正文[:：])\s*$/i;

function dropFillerLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (FILLER_LINE_RE.test(t)) return false;
      // 纯标题行混进正文（如「📌 标题：xxx」）
      if (/^(📌\s*)?(标题|title)\s*[:：]/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

/**
 * 把 AI 输出拆成可直接发小红书的标题 + 正文。
 * - 去掉 Markdown、标题混入、会话式废话
 * - 正文不再重复标题
 */
export function extractTitleAndBody(raw: string): { title: string; body: string } {
  const plain = stripMarkdownForXhs(raw ?? '');
  const lines = plain.split('\n');
  let title = '';
  const bodyLines: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (bodyLines.length > 0) bodyLines.push('');
      continue;
    }
    if (!title) {
      const cand = stripMarkdownForXhsTitle(t);
      if (cand) {
        title = cand.slice(0, 20);
        continue;
      }
    }
    bodyLines.push(line);
  }

  let body = dropFillerLines(bodyLines.join('\n'));
  body = stripMarkdownForXhs(body);

  // 正文若又复读了标题，去掉那一行
  if (title) {
    body = body
      .split('\n')
      .filter((l) => stripMarkdownForXhsTitle(l) !== title)
      .join('\n');
    body = body.replace(/\n{3,}/g, '\n\n').trim();
  }

  return { title, body };
}
