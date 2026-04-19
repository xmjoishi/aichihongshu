# -*- coding: utf-8 -*-
"""SQLite 连接管理（单例）"""

import sqlite3
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

_PROJECT_ROOT = Path(__file__).parent.parent.parent
_DB_PATH = _PROJECT_ROOT / os.getenv("DB_PATH", "data/app.db")


def get_db() -> sqlite3.Connection:
    """获取数据库连接，自动建库建表"""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """初始化数据库，执行建表 SQL，并自动补充新列（迁移）"""
    from app.db.schema import SCHEMA_SQL
    conn = get_db()
    conn.executescript(SCHEMA_SQL)
    conn.commit()

    # 迁移：为 my_profile 补充新列（已存在时忽略）
    _MIGRATIONS = [
        "ALTER TABLE my_profile ADD COLUMN avatar_url TEXT",
        "ALTER TABLE my_profile ADD COLUMN xhs_bio TEXT",
        "ALTER TABLE my_profile ADD COLUMN xhs_follows INTEGER DEFAULT 0",
        "ALTER TABLE my_profile ADD COLUMN ip_location TEXT",
        "ALTER TABLE my_profile ADD COLUMN xhs_tags TEXT DEFAULT '[]'",
        "ALTER TABLE my_profile ADD COLUMN crawled_at TEXT",
        "ALTER TABLE items ADD COLUMN deleted_at TEXT",
        "ALTER TABLE notes ADD COLUMN item_ids TEXT DEFAULT '[]'",
        # 经验库：高赞样本标记
        "ALTER TABLE notes ADD COLUMN use_as_reference INTEGER DEFAULT 0",
        # 经验库：榜样笔记样本（含正文）
        "ALTER TABLE reference_accounts ADD COLUMN ref_notes TEXT DEFAULT '[]'",
        # 笔记类型：text（文字配图）| image（图文多图）| video（视频）
        "ALTER TABLE notes ADD COLUMN note_type TEXT DEFAULT 'text'",
        # 视频路径（video 类型时使用）
        "ALTER TABLE notes ADD COLUMN video_path TEXT",
    ]

    # 经验库：选题灵感表（CREATE TABLE IF NOT EXISTS 幂等）
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS inspirations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            keyword     TEXT,
            source      TEXT DEFAULT 'ai',
            likes_ref   INTEGER DEFAULT 0,
            note_ref    TEXT,
            saved       INTEGER DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now', 'localtime'))
        );
    """)
    for sql in _MIGRATIONS:
        try:
            conn.execute(sql)
            conn.commit()
        except Exception:
            pass  # 列已存在，忽略

    # 初始化默认快捷操作 prompt（首次启动时写入）
    _DEFAULT_PROMPTS = [
        ("quick_title",   "生成标题",   "请为这篇笔记生成 5 个吸引人的标题，每行一个，格式：\n1. 标题一\n2. 标题二\n…\n不超过 20 字，带情绪词或反问，避免营销腔。", 0),
        ("quick_body",    "优化正文",   "请帮我优化这篇笔记的正文，保持口语化，短句换行，突出卖点，控制在 300 字以内。", 1),
        ("quick_tags",    "生成标签",   "请为这篇笔记生成 8 个小红书话题标签，格式：\n#标签1 #标签2 …\n贴合内容垂类，覆盖主话题/场景/风格/情绪四类。", 2),
        ("quick_cover",   "写封面文案", "请为这篇笔记写一段封面图文字，不超过 15 字，大字报风格，有视觉冲击力。", 3),
    ]
    for key, label, prompt, order in _DEFAULT_PROMPTS:
        conn.execute(
            """INSERT OR IGNORE INTO prompt_configs (key, label, prompt, sort_order)
               VALUES (?, ?, ?, ?)""",
            (key, label, prompt, order),
        )
    conn.commit()

    conn.close()
    print(f"[db] 数据库已初始化：{_DB_PATH}")
