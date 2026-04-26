# -*- coding: utf-8 -*-
"""v0.2 多账号 user_data_dir 解析与桥接工具

MediaCrawler 内部硬编码 user_data_dir 路径为 `cwd/browser_data/<platform>_user_data_dir`，
我们通过 symlink 把激活账号的 user_data_dir 桥接到该位置，避免改 submodule。
"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
MEDIA_CRAWLER_DIR = PROJECT_ROOT / "tools" / "MediaCrawler"


def resolve_active_user_data_dir() -> Path:
    """返回当前激活账号的 user_data_dir 绝对路径，无激活时回退 main 目录。"""
    db_path = PROJECT_ROOT / "data" / "app.db"
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            try:
                row = conn.execute(
                    "SELECT value FROM app_settings WHERE key='active_account_id'"
                ).fetchone()
                if row and row["value"]:
                    acc = conn.execute(
                        "SELECT user_data_dir FROM account_pool WHERE id=?",
                        (int(row["value"]),),
                    ).fetchone()
                    if acc and acc["user_data_dir"]:
                        return Path(acc["user_data_dir"])
            finally:
                conn.close()
        except Exception:
            pass
    return PROJECT_ROOT / "data" / "browser_profiles" / "main"


def link_to_media_crawler(active_dir: Path, platform: str = "xhs") -> Path:
    """把 active_dir symlink 到 MediaCrawler 期望的固定位置。"""
    target = MEDIA_CRAWLER_DIR / "browser_data" / f"{platform}_user_data_dir"
    target.parent.mkdir(parents=True, exist_ok=True)
    active_dir.mkdir(parents=True, exist_ok=True)

    # 已经是指向同一目标的 symlink → 直接返回
    if target.is_symlink():
        try:
            if target.resolve() == active_dir.resolve():
                return target
        except Exception:
            pass
        target.unlink()
    elif target.exists():
        # 是真实目录：判断是否为空（Phase 1 留下的占位目录）
        children = [p for p in target.iterdir() if p.name != ".legacy_migrated"]
        if not children:
            shutil.rmtree(target)
            print(f"[user_data_dir] 清理空占位目录：{target}")
        else:
            backup = target.with_suffix(".bak")
            if backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            target.rename(backup)
            print(f"[user_data_dir] 备份原登录态 → {backup}")

    target.symlink_to(active_dir, target_is_directory=True)
    print(f"[user_data_dir] symlink: {target} → {active_dir}")
    return target
