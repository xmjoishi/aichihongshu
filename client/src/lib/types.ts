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
  published_at?: string;
  note_url?: string;
  likes: number;
  comments: number;
  collects: number;
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
}

export interface ReferenceAccount {
  id: number;
  account_id: string;
  name?: string;
  followers: number;
  note_count: number;
  avg_likes: number;
  avg_comments: number;
  avg_collects: number;
  top_notes: Array<{ title: string; likes: number; url?: string }>;
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
  top_notes: Array<{ id: number; title: string; likes: number; item_title: string }>;
}
