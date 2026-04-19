/**
 * 小红书笔记类型体系
 *
 * 两层结构：
 *   图文（graphic）
 *     ├── image   图片     已实现
 *     └── text    文字配图  已实现
 *   视频（video）          待实现（置灰）
 *   长文（article）        待实现（置灰）
 */

export type NoteType = "image" | "text" | "video" | "article";

export interface NoteTypeMeta {
  key: NoteType;
  label: string;        // 显示名
  icon: string;         // emoji
  group: string;        // 所属分组
  available: boolean;   // false = 置灰（未来功能）
  description: string;  // 提示文案
}

export interface NoteTypeGroup {
  key: string;
  label: string;
  icon: string;
  types: NoteTypeMeta[];
}

export const NOTE_TYPE_META: Record<NoteType, NoteTypeMeta> = {
  image: {
    key: "image",
    label: "图片",
    icon: "🖼️",
    group: "graphic",
    available: true,
    description: "上传多张图片，按顺序展示",
  },
  text: {
    key: "text",
    label: "文字配图",
    icon: "📝",
    group: "graphic",
    available: true,
    description: "纯文字内容，小红书自动生成封面图",
  },
  video: {
    key: "video",
    label: "视频",
    icon: "🎬",
    group: "video",
    available: false,
    description: "上传视频文件（即将支持）",
  },
  article: {
    key: "article",
    label: "长文",
    icon: "📄",
    group: "article",
    available: false,
    description: "图文混排长文（即将支持）",
  },
};

export const NOTE_TYPE_GROUPS: NoteTypeGroup[] = [
  {
    key: "graphic",
    label: "图文",
    icon: "🖼️",
    types: [NOTE_TYPE_META.image, NOTE_TYPE_META.text],
  },
  {
    key: "video",
    label: "视频",
    icon: "🎬",
    types: [NOTE_TYPE_META.video],
  },
  {
    key: "article",
    label: "长文",
    icon: "📄",
    types: [NOTE_TYPE_META.article],
  },
];

/** 获取某 note_type 的显示标签 */
export function getNoteTypeLabel(type: NoteType | string): string {
  return NOTE_TYPE_META[type as NoteType]?.label ?? type;
}

/** 获取某 note_type 的 icon */
export function getNoteTypeIcon(type: NoteType | string): string {
  return NOTE_TYPE_META[type as NoteType]?.icon ?? "📝";
}

/** 获取列表卡片用的类型徽章样式 */
export function getNoteTypeBadge(type: NoteType | string): { label: string; className: string } | null {
  const meta = NOTE_TYPE_META[type as NoteType];
  if (!meta) return null;
  const styles: Record<string, string> = {
    image:   "bg-blue-50 text-blue-500",
    text:    "bg-zinc-100 text-zinc-500",
    video:   "bg-purple-50 text-purple-500",
    article: "bg-amber-50 text-amber-600",
  };
  return {
    label: `${meta.icon}${meta.label}`,
    className: styles[meta.key] ?? "bg-zinc-100 text-zinc-500",
  };
}
