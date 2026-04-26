# -*- coding: utf-8 -*-
"""账号人设 REST API（v0.3 多账号隔离）

每个 operation 账号有一行独立的 my_profile，按 account_pool_id 关联。
所有读/写都基于「当前激活账号」自动定位到对应人设行。
assistant 账号不会成为激活账号（service 层已限制）。
"""

import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel

from app.db.connection import get_db
from app.services import account_pool
from app.services.protection import require_protection

router = APIRouter(prefix="/api/profile", tags=["profile"])

# 刷新任务状态（按 account_pool_id 维度记录）
_refresh_status: dict[int, dict] = {}


def _active_pool_id() -> int:
    """获取当前激活的 operation 账号 id；未激活则报错。"""
    aid = account_pool.get_active_id()
    if aid is None:
        raise HTTPException(400, "尚未激活任何账号，请先在顶栏切换运营账号")
    return aid


def _ensure_profile_row(pool_id: int) -> None:
    """保证该 account_pool_id 对应的 my_profile 行存在；不存在则建空行。"""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id FROM my_profile WHERE account_pool_id=?", (pool_id,)
        ).fetchone()
        if row:
            return
        # 取账号 alias 作为兜底 display_name
        acc = conn.execute(
            "SELECT alias FROM account_pool WHERE id=?", (pool_id,)
        ).fetchone()
        display_name = acc["alias"] if acc else None
        conn.execute(
            "INSERT INTO my_profile (account_pool_id, display_name) VALUES (?, ?)",
            (pool_id, display_name),
        )
        conn.commit()
    finally:
        conn.close()


def _get_profile(pool_id: int) -> Optional[dict]:
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?", (pool_id,)
        ).fetchone()
        if not row:
            return None
        d = dict(row)
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


@router.get("")
def api_get_profile():
    pool_id = _active_pool_id()
    _ensure_profile_row(pool_id)
    return _get_profile(pool_id)


class ProfileUpdate(BaseModel):
    account_id: Optional[str] = None
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
    avatar_url: Optional[str] = None
    xhs_bio: Optional[str] = None
    xhs_follows: Optional[int] = None
    ip_location: Optional[str] = None
    xhs_tags: Optional[list[str]] = None
    # v0.2 全局风险免责声明（不绑定具体账号，但仍存于 my_profile）
    risk_warning_ack: Optional[int] = None


@router.patch("")
def api_update_profile(body: ProfileUpdate):
    pool_id = _active_pool_id()
    _ensure_profile_row(pool_id)

    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "没有可更新的字段")

    set_clauses = []
    params = []
    for key, val in updates.items():
        set_clauses.append(f"{key}=?")
        params.append(json.dumps(val, ensure_ascii=False) if isinstance(val, list) else val)

    if updates.get("risk_warning_ack") == 1:
        set_clauses.append("risk_warning_ack_at=datetime('now','localtime')")

    set_clauses.append("updated_at=datetime('now','localtime')")
    params.append(pool_id)

    conn = get_db()
    try:
        conn.execute(
            f"UPDATE my_profile SET {', '.join(set_clauses)} WHERE account_pool_id=?",
            params,
        )
        conn.commit()
    finally:
        conn.close()

    return _get_profile(pool_id)


@router.get("/refresh-status")
def api_refresh_status():
    """查询当前激活账号的主页刷新任务状态"""
    pool_id = _active_pool_id()
    return _refresh_status.get(pool_id, {"running": False, "last_error": None})


@router.post("/refresh", dependencies=[Depends(require_protection("profile_refresh"))])
def api_refresh_profile(background_tasks: BackgroundTasks):
    """触发爬虫重新抓取当前激活账号的主页数据。"""
    pool_id = _active_pool_id()
    _ensure_profile_row(pool_id)

    status = _refresh_status.setdefault(pool_id, {"running": False, "last_error": None})
    if status["running"]:
        raise HTTPException(409, "已有刷新任务正在运行，请稍候")

    profile = _get_profile(pool_id)
    if not profile:
        raise HTTPException(404, "尚未初始化账号人设")
    account_id = profile.get("account_id")
    if not account_id:
        raise HTTPException(400, "人设中未设置 account_id，无法触发爬虫刷新。"
                                 "请先在 profile 页填入小红书账号 ID。")

    background_tasks.add_task(_do_refresh, pool_id, account_id)
    return {"message": "刷新任务已启动", "account_id": account_id}


def _do_refresh(pool_id: int, account_id: str):
    """后台任务：subprocess 调爬虫刷新主页（用 MediaCrawler 独立 venv）"""
    import subprocess
    from pathlib import Path

    status = _refresh_status.setdefault(pool_id, {"running": False, "last_error": None})
    status["running"] = True
    status["last_error"] = None

    try:
        project_root = Path(__file__).parent.parent.parent
        media_crawler_dir = project_root / "tools" / "MediaCrawler"
        creator_url = f"https://www.xiaohongshu.com/user/profile/{account_id}"

        cmd = [
            "uv", "run",
            "--project", str(media_crawler_dir),
            "python",
            str(project_root / "crawler" / "xhs_creator.py"),
            "--url", creator_url,
            "--my-profile",
            "--account-pool-id", str(pool_id),
            "--user-data-dir", account_pool.get_active_user_data_dir(),
        ]

        print(f"[profile/refresh pool={pool_id}] 运行爬虫：{' '.join(cmd)}")
        result = subprocess.run(
            cmd,
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.stdout:
            for line in result.stdout.splitlines():
                print(f"[xhs_creator] {line}")
        if result.stderr:
            for line in result.stderr.splitlines():
                print(f"[xhs_creator:err] {line}")

        if result.returncode != 0:
            status["last_error"] = f"爬虫进程退出码 {result.returncode}"
            return

        creator_info = None
        for line in result.stdout.splitlines():
            if line.startswith("RESULT_JSON:"):
                payload = line[len("RESULT_JSON:"):]
                if payload.strip() != "null":
                    creator_info = json.loads(payload)
                break

        if not creator_info:
            status["last_error"] = "爬虫未返回账号主页信息，可能需要重新扫码登录"

    except subprocess.TimeoutExpired:
        status["last_error"] = "爬虫超时（120s），请检查网络或重新扫码"
    except Exception as e:
        status["last_error"] = str(e)
        print(f"[profile/refresh pool={pool_id}] 刷新失败：{e}")
    finally:
        status["running"] = False
