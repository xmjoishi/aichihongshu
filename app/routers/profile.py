# -*- coding: utf-8 -*-
"""账号人设 REST API"""

import json
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

from app.db.connection import get_db

router = APIRouter(prefix="/api/profile", tags=["profile"])

# 刷新任务状态（简单内存状态，进程重启后重置）
_refresh_status: dict = {"running": False, "last_error": None}


def _get_profile() -> Optional[dict]:
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM my_profile WHERE id=1").fetchone()
        if not row:
            return None
        d = dict(row)
        # 解析 JSON 字段
        for field in ("content_pillars", "persona_taboos", "preferred_styles",
                      "preferred_scenes", "hashtag_pool", "xhs_tags"):
            if isinstance(d.get(field), str):
                try:
                    d[field] = json.loads(d[field])
                except Exception:
                    d[field] = []
        return d
    finally:
        conn.close()


@router.get("/")
def api_get_profile():
    profile = _get_profile()
    if not profile:
        raise HTTPException(404, "尚未初始化账号人设，请先运行 profile init")
    return profile


class ProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    niche: Optional[str] = None
    target_audience: Optional[str] = None
    content_pillars: Optional[list[str]] = None
    persona_name: Optional[str] = None
    persona_bio: Optional[str] = None
    persona_tone: Optional[str] = None
    persona_taboos: Optional[list[str]] = None
    followers: Optional[int] = None
    preferred_styles: Optional[list[str]] = None
    preferred_scenes: Optional[list[str]] = None
    hashtag_pool: Optional[list[str]] = None
    posting_rhythm: Optional[str] = None
    # 小红书主页原始字段（爬虫写入，也允许手动覆盖）
    avatar_url: Optional[str] = None
    xhs_bio: Optional[str] = None
    xhs_follows: Optional[int] = None
    ip_location: Optional[str] = None
    xhs_tags: Optional[list[str]] = None


@router.patch("/")
def api_update_profile(body: ProfileUpdate):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "没有可更新的字段")

    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM my_profile WHERE id=1").fetchone()
        if not row:
            raise HTTPException(404, "尚未初始化账号人设")

        set_clauses = []
        params = []
        for key, val in updates.items():
            set_clauses.append(f"{key}=?")
            params.append(json.dumps(val, ensure_ascii=False) if isinstance(val, list) else val)

        set_clauses.append("updated_at=datetime('now','localtime')")
        params.append(1)

        conn.execute(
            f"UPDATE my_profile SET {', '.join(set_clauses)} WHERE id=?",
            params,
        )
        conn.commit()
    finally:
        conn.close()

    return _get_profile()


@router.get("/refresh-status")
def api_refresh_status():
    """查询账号主页数据刷新任务的状态"""
    return _refresh_status


@router.post("/refresh")
def api_refresh_profile(background_tasks: BackgroundTasks):
    """触发爬虫重新抓取账号主页数据（头像/粉丝数/bio/IP 等）。
    要求 my_profile 中已存有 account_id。
    任务异步执行，可通过 GET /api/profile/refresh-status 查询进度。
    """
    if _refresh_status["running"]:
        raise HTTPException(409, "已有刷新任务正在运行，请稍候")

    profile = _get_profile()
    if not profile:
        raise HTTPException(404, "尚未初始化账号人设")
    account_id = profile.get("account_id")
    if not account_id:
        raise HTTPException(400, "人设中未设置 account_id，无法触发爬虫刷新。"
                                 "请先运行 profile init --url 初始化账号。")

    background_tasks.add_task(_do_refresh, account_id)
    return {"message": "刷新任务已启动", "account_id": account_id}


def _do_refresh(account_id: str):
    """后台任务：调用爬虫刷新账号主页数据"""
    import sys
    import os
    from pathlib import Path

    _refresh_status["running"] = True
    _refresh_status["last_error"] = None

    try:
        project_root = Path(__file__).parent.parent.parent
        media_crawler_dir = project_root / "tools" / "MediaCrawler"

        # 构造账号 URL（只需 account_id，不需要 xsec_token 也能抓到公开信息）
        creator_url = f"https://www.xiaohongshu.com/user/profile/{account_id}"

        # 动态导入 crawler 模块（避免循环导入）
        import importlib.util
        crawler_path = project_root / "crawler" / "xhs_creator.py"
        spec = importlib.util.spec_from_file_location("xhs_creator", crawler_path)
        xhs_creator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(xhs_creator)

        notes, creator_info = asyncio.run(xhs_creator.run_crawl(creator_url))

        if creator_info:
            xhs_creator.save_my_profile_crawl_data(creator_info)
        else:
            _refresh_status["last_error"] = "爬虫未返回账号主页信息，可能需要重新扫码登录"

    except Exception as e:
        _refresh_status["last_error"] = str(e)
        print(f"[profile/refresh] 刷新失败：{e}")
    finally:
        _refresh_status["running"] = False

