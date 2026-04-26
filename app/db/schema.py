# -*- coding: utf-8 -*-
"""数据库 Schema 定义"""

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 图库物品表
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    image_path  TEXT NOT NULL,           -- 相对 assets/ 的路径
    style       TEXT,                    -- 风格标签：现代/北欧/中式/...
    material    TEXT,                    -- 材质描述
    scene       TEXT,                    -- 使用场景
    color       TEXT,                    -- 主色调
    tags        TEXT DEFAULT '[]',       -- JSON 数组，多维度标签
    analysis_raw TEXT,                   -- MiniMax 原始返回（JSON）
    note_count  INTEGER DEFAULT 0,       -- 已生成笔记数
    -- v0.3 多账号隔离：归属的运营账号
    account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE SET NULL,
    created_at  TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT DEFAULT (datetime('now', 'localtime')),
    deleted_at  TEXT                     -- 软删除时间，NULL 表示正常
);

-- 榜样账号表
CREATE TABLE IF NOT EXISTS reference_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT UNIQUE NOT NULL,  -- 小红书账号 ID
    name            TEXT,
    followers       INTEGER DEFAULT 0,
    total_likes     INTEGER DEFAULT 0,
    note_count      INTEGER DEFAULT 0,
    avg_likes       REAL DEFAULT 0,
    avg_comments    REAL DEFAULT 0,
    avg_collects    REAL DEFAULT 0,
    content_style   TEXT,                  -- 内容风格描述（JSON）
    top_notes       TEXT DEFAULT '[]',     -- TOP 笔记摘要（JSON 数组）
    raw_data        TEXT,                  -- 原始爬取数据（JSON）
    crawled_at      TEXT DEFAULT (datetime('now', 'localtime')),
    analyzed_at     TEXT,
    insights        TEXT DEFAULT NULL,     -- AI 生成的学习要点（Markdown，缓存）
    insights_at     TEXT DEFAULT NULL      -- 学习要点生成时间
);

-- 笔记草稿表
CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER REFERENCES items(id),
    account_ref TEXT,                      -- 参考的榜样账号 account_id
    title       TEXT,
    body        TEXT,
    tags        TEXT DEFAULT '[]',         -- 话题标签（JSON 数组）
    cover_desc  TEXT,                      -- 封面文案建议
    prompt_used TEXT,                      -- 生成时用的 prompt（可复盘）
    status      TEXT DEFAULT 'draft',      -- draft | ready | published
    item_ids    TEXT DEFAULT '[]',          -- 关联的图库物品 ID 列表（JSON 数组，多图笔记）
    -- v0.3 多账号隔离：归属的运营账号
    account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE SET NULL,
    published_at TEXT,
    note_url    TEXT,                      -- 发布后的链接
    likes       INTEGER DEFAULT 0,
    comments    INTEGER DEFAULT 0,
    collects    INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 搜索抓取记录表
CREATE TABLE IF NOT EXISTS crawl_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    keywords    TEXT NOT NULL,
    count       INTEGER DEFAULT 0,
    source_file TEXT,                      -- 原始 JSON 文件路径
    created_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 我的账号人设表（v0.3 多行：每个运营账号一行，account_pool_id 唯一）
CREATE TABLE IF NOT EXISTS my_profile (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_pool_id INTEGER UNIQUE REFERENCES account_pool(id) ON DELETE CASCADE,
    -- 基本信息
    account_id      TEXT,                  -- 小红书账号 ID（可选）
    display_name    TEXT,                  -- 账号显示名
    -- 账号定位 / 容局
    niche           TEXT,                  -- 垂类定位（如：家居软装/租房改造）
    target_audience TEXT,                  -- 目标受众描述
    content_pillars TEXT DEFAULT '[]',     -- 内容支柱/方向（JSON 数组）
    -- 虹薇人设
    persona_name    TEXT,                  -- 人设名称/昵称
    persona_bio     TEXT,                  -- 人设简介（50字以内）
    persona_tone    TEXT,                  -- 语气风格描述
    persona_taboos  TEXT DEFAULT '[]',     -- 禁忌词/禁忌风格（JSON 数组）
    -- 账号现有数据
    followers       INTEGER DEFAULT 0,
    total_notes     INTEGER DEFAULT 0,
    total_likes     INTEGER DEFAULT 0,     -- 总获赞（爬虫缓存）
    total_collects  INTEGER DEFAULT 0,     -- 总收藏（爬虫缓存）
    avg_likes       REAL DEFAULT 0,
    avg_comments    REAL DEFAULT 0,
    avg_collects    REAL DEFAULT 0,
    -- 创作偏好
    preferred_styles TEXT DEFAULT '[]',   -- 偏好家居风格（JSON 数组）
    preferred_scenes TEXT DEFAULT '[]',   -- 偏好场景（JSON 数组）
    hashtag_pool    TEXT DEFAULT '[]',    -- 常用话题标签池（JSON 数组）
    posting_rhythm  TEXT,                 -- 发帖节奏（如：每周3篇，周二四六）
    -- 小红书主页原始数据（爬虫抓取）
    avatar_url      TEXT,                  -- 头像图片 URL
    xhs_bio         TEXT,                  -- 小红书账号简介（原始）
    xhs_follows     INTEGER DEFAULT 0,     -- 关注数
    ip_location     TEXT,                  -- IP 归属地（如"上海"）
    xhs_tags        TEXT DEFAULT '[]',     -- 账号标签（JSON 数组，如["家居博主","软装达人"]）
    crawled_at      TEXT,                  -- 最近一次爬取时间
    -- v0.2 风险免责声明确认（全局共享，不绑定具体账号）
    risk_warning_ack    INTEGER DEFAULT 0,
    risk_warning_ack_at TEXT,
    -- 元信息
    created_at      TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 提示词配置表（快捷操作 prompt，可在设置中编辑）
CREATE TABLE IF NOT EXISTS prompt_configs (
    key         TEXT PRIMARY KEY,   -- 唯一标识，如 "quick_title"
    label       TEXT NOT NULL,      -- 按钮显示名，如 "生成标题"
    prompt      TEXT NOT NULL,      -- prompt 文本
    sort_order  INTEGER DEFAULT 0,  -- 排列顺序
    enabled     INTEGER DEFAULT 1,  -- 1=启用, 0=禁用
    updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- ── v0.3 重构后：账号池 ──
-- 角色精简为 operation（运营账号）/ assistant（辅助账号）
-- operation：发布笔记、维护主号；可绑定独立的人设/笔记/图库
-- assistant：仅作为浏览器容器，用于搜索/抓取，不关联人设和笔记
CREATE TABLE IF NOT EXISTS account_pool (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alias           TEXT UNIQUE NOT NULL,
    role            TEXT NOT NULL DEFAULT 'operation'
                    CHECK(role IN ('operation','assistant')),
    user_data_dir   TEXT UNIQUE NOT NULL,
    xhs_user_id     TEXT,
    display_name    TEXT,
    followers       INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'active'
                    CHECK(status IN ('active','banned','suspended','retired')),
    ban_count       INTEGER DEFAULT 0,
    last_used_at    TEXT,
    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 全局应用配置表
CREATE TABLE IF NOT EXISTS app_settings (
    key             TEXT PRIMARY KEY,
    value           TEXT,
    updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
"""
