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
    ]
    for sql in _MIGRATIONS:
        try:
            conn.execute(sql)
            conn.commit()
        except Exception:
            pass  # 列已存在，忽略

    conn.close()
    print(f"[db] 数据库已初始化：{_DB_PATH}")
