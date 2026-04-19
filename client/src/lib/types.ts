// 共享类型定义

export interface Item {
  id: number;
  title: string;
  image_path: string;
  style?: string;
  material?: string;
  scene?: string;
  color?: string;
  tags: string[];
  analysis_raw?: string;
  note_count: number;
  created_at?: string;
  deleted_at?: string;
}

export interface Note {
  id: number;
  item_id?: number;
  item_ids: number[];
  account_ref?: string;
  title?: string;
  body?: string;
  tags: string[];
  cover_desc?: string;
  prompt_used?: string;
  status: "draft" | "ready" | "published";
  note_type: "text" | "image" | "video" | "article";  // 发布类型
  video_path?: string;
  published_at?: string;
  note_url?: string;
  likes: number;
  comments: number;
  collects: number;
  use_as_reference?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Profile {
  id: number;
  account_id?: string;
  display_name?: string;
  niche?: string;
  target_audience?: string;
  content_pillars: string[];
  persona_name?: string;
  persona_bio?: string;
  persona_tone?: string;
  persona_taboos: string[];
  followers: number;
  total_notes: number;
  avg_likes: number;
  avg_comments: number;
  avg_collects: number;
  preferred_styles: string[];
  preferred_scenes: string[];
  hashtag_pool: string[];
  posting_rhythm?: string;
  // 小红书主页原始数据（爬虫抓取）
  avatar_url?: string;
  xhs_bio?: string;
  xhs_follows?: number;
  ip_location?: string;
  xhs_tags: string[];
  crawled_at?: string;
  updated_at?: string;
  // 动态计算（来自已发布 notes）
  total_likes?: number;
  total_collects?: number;
}

export interface ReferenceAccount {
  id: number;
  account_id: string;
  name?: string;
  followers: number;
  total_likes?: number;
  note_count: number;
  avg_likes: number;
  avg_comments: number;
  avg_collects: number;
  content_style?: string;   // JSON 字符串，包含 keywords/tone/format/hook/summary
  top_notes: Array<{ title: string; likes: number; url?: string }>;
  raw_data?: string;
  crawled_at?: string;
  analyzed_at?: string;
  insights?: string;        // AI 生成的学习要点（Markdown）
  insights_at?: string;
}

export interface Analytics {
  library: { total_items: number };
  notes: {
    total: number;
    by_status: Record<string, number>;
    published_avg: { likes: number; comments: number; collects: number };
  };
  accounts: { total: number };
  my_profile: Partial<Profile>;
  top_notes: Array<{ id: number; title: string; likes: number; item_title: string; note_url?: string }>;
  suggestions?: {
    items_without_notes: number;
    days_since_publish: number | null;
    draft_count: number;
  };
}

export interface AnalyticsNote {
  id: number;
  title?: string;
  likes: number;
  comments: number;
  collects: number;
  published_at?: string;
  note_url?: string;
  cover_desc?: string;
  cover_image?: string;
  engagement_rate: number;
}

export interface TitleLengthBucket {
  range: string;
  avg_likes: number;
  count: number;
}

export interface HourDist {
  hour: number;
  avg_likes: number;
  count: number;
}

export interface TagFreq {
  tag: string;
  count: number;
  avg_likes: number;
}

export interface Insights {
  title_length_dist: TitleLengthBucket[];
  hour_dist: HourDist[];
  tag_freq: TagFreq[];
  comparison: {
    mine: { avg_likes: number; avg_comments: number; avg_collects: number };
    reference: { avg_likes: number; avg_comments: number; avg_collects: number };
  };
}

// ── 经验库 ────────────────────────────────────────────────────────────────────

export interface KnowledgeRule {
  key: string;
  label: string;
  desc: string;
  value: string;
  enabled: boolean;
}

export interface KnowledgeMySample {
  id: number;
  title?: string;
  body?: string;
  body_preview: string;
  tags: string[];
  likes: number;
  comments: number;
  collects: number;
  published_at?: string;
  note_url?: string;
  use_as_reference: boolean;
}

export interface KnowledgeRefNote {
  title: string;
  body: string;
  likes: number;
  note_url?: string;
}

export interface KnowledgeRefGroup {
  account_id: string;
  name: string;
  notes: KnowledgeRefNote[];
}

export interface KnowledgeInspiration {
  id: number;
  title: string;
  keyword?: string;
  source: "ai" | "crawl" | "manual";
  likes_ref: number;
  note_ref?: string;
  saved: number;
  created_at: string;
}
