# -*- coding: utf-8 -*-
"""笔记草稿 REST API"""

import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.db.connection import get_db
from app.models.item import Note
from app.modules.content.manager import (
    create_note, get_note, list_notes,
    update_note_content, update_note_status, delete_note, export_note_markdown,
)
from app.modules.library.manager import get_item
from app.services import account_pool
from app.services.protection import require_protection

router = APIRouter(prefix="/api/content", tags=["content"])

# 内存中存储自动发布任务状态（进程重启后清空，轻量实现）
_publish_jobs: dict = {}


def _active_pool_id() -> int:
    aid = account_pool.get_active_id()
    if aid is None:
        raise HTTPException(400, "尚未激活运营账号，请先在顶栏切换")
    return aid


class NoteCreate(BaseModel):
    item_id: Optional[int] = None
    account_ref: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[list[str]] = None
    cover_desc: Optional[str] = None
    prompt_used: Optional[str] = None


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[list[str]] = None
    cover_desc: Optional[str] = None
    item_ids: Optional[list[int]] = None
    note_type: Optional[str] = None   # text（文字配图）| image（图片）| video（视频）| article（长文）
    video_path: Optional[str] = None


class StatusUpdate(BaseModel):
    status: str
    note_url: Optional[str] = None


class StatsUpdate(BaseModel):
    likes: Optional[int] = None
    comments: Optional[int] = None
    collects: Optional[int] = None


class DraftRequest(BaseModel):
    item_id: int
    account_id: Optional[str] = None
    save: bool = False


@router.get("/", response_model=list[Note])
def api_list_notes(
    status: Optional[str] = Query(None),
    item_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    sort: Optional[str] = Query(None),
):
    return list_notes(
        status=status,
        item_id=item_id,
        search=search,
        sort=sort,
        account_pool_id=_active_pool_id(),
    )


@router.get("/xhs-login-status")
def api_xhs_login_status():
    """
    检测小红书登录态是否有效（headless 快速检测）。
    返回 {"logged_in": bool}
    """
    import subprocess, sys
    from pathlib import Path

    project_root = Path(__file__).parent.parent.parent
    publish_script = project_root / "crawler" / "xhs_publish.py"
    mc_python = project_root / "tools" / "MediaCrawler" / ".venv" / "bin" / "python"
    python_exe = str(mc_python) if mc_python.exists() else sys.executable

    try:
        result = subprocess.run(
            [python_exe, str(publish_script), "--check-login",
             "--user-data-dir", account_pool.get_active_user_data_dir()],
            capture_output=True, text=True, timeout=30,
            cwd=str(project_root),
        )
        logged_in = "LOGGED_IN:true" in result.stdout
        return {"logged_in": logged_in}
    except Exception as e:
        return {"logged_in": False, "error": str(e)}


@router.get("/{note_id}", response_model=Note)
def api_get_note(note_id: int):
    note = get_note(note_id, account_pool_id=_active_pool_id())
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    return note


@router.post("/", response_model=Note)
def api_create_note(body: NoteCreate):
    return create_note(**body.model_dump(), account_pool_id=_active_pool_id())


@router.patch("/{note_id}", response_model=Note)
def api_update_note(note_id: int, body: NoteUpdate):
    pool_id = _active_pool_id()
    note = get_note(note_id, account_pool_id=pool_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    return update_note_content(note_id, **body.model_dump(exclude_none=True))


@router.patch("/{note_id}/status", response_model=Note)
def api_update_status(note_id: int, body: StatusUpdate):
    pool_id = _active_pool_id()
    note = get_note(note_id, account_pool_id=pool_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    if body.status not in ("draft", "ready", "published"):
        raise HTTPException(400, "status 必须是 draft / ready / published")
    return update_note_status(note_id, body.status, note_url=body.note_url)


@router.patch("/{note_id}/stats", response_model=Note)
def api_update_stats(note_id: int, body: StatsUpdate):
    """更新笔记互动数据（likes / comments / collects）"""
    pool_id = _active_pool_id()
    note = get_note(note_id, account_pool_id=pool_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    conn = get_db()
    try:
        fields = {}
        if body.likes is not None:
            fields["likes"] = body.likes
        if body.comments is not None:
            fields["comments"] = body.comments
        if body.collects is not None:
            fields["collects"] = body.collects
        if fields:
            set_clause = ", ".join(f"{k}=?" for k in fields)
            conn.execute(
                f"UPDATE notes SET {set_clause}, updated_at=datetime('now') WHERE id=? AND account_pool_id=?",
                (*fields.values(), note_id, pool_id),
            )
            conn.commit()
    finally:
        conn.close()
    return get_note(note_id, account_pool_id=pool_id)


@router.delete("/{note_id}")
def api_delete_note(note_id: int):
    note = get_note(note_id, account_pool_id=_active_pool_id())
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    ok = delete_note(note_id)
    return {"ok": True}


@router.get("/{note_id}/export")
def api_export_note(note_id: int):
    pool_id = _active_pool_id()
    note = get_note(note_id, account_pool_id=pool_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    item_title = ""
    if note.item_id:
        item = get_item(note.item_id, account_pool_id=pool_id)
        item_title = item.title if item else ""
    md = export_note_markdown(note, item_title=item_title)
    return {"markdown": md}


# ── 半自动发布：暂存图片 ───────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).parent.parent.parent
STAGING_DIR = PROJECT_ROOT / "data" / "publish_staging"


def _stage_dir(note_id: int) -> Path:
    return STAGING_DIR / str(note_id)


@router.post("/{note_id}/stage-images")
def api_stage_images(note_id: int):
    """把笔记关联的图库图片复制到 data/publish_staging/{note_id}/，方便手动上传到小红书。
    返回暂存目录路径和文件列表。
    """
    pool_id = _active_pool_id()
    note = get_note(note_id, account_pool_id=pool_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")

    assets_dir = PROJECT_ROOT / "assets"
    stage = _stage_dir(note_id)
    stage.mkdir(parents=True, exist_ok=True)

    # 解析关联图片
    import json as _json
    item_ids: list[int] = []
    if note.item_ids:
        try:
            item_ids = _json.loads(note.item_ids) if isinstance(note.item_ids, str) else list(note.item_ids)
        except Exception:
            pass
    elif note.item_id:
        item_ids = [note.item_id]

    files: list[dict] = []
    for idx, iid in enumerate(item_ids, 1):
        item = get_item(iid, account_pool_id=pool_id)
        if not item or not item.image_path:
            continue
        src = assets_dir / item.image_path
        if not src.exists():
            src = PROJECT_ROOT / item.image_path
        if not src.exists():
            continue
        # 保持顺序，以序号+原始扩展名命名，便于用户按顺序上传
        dest_name = f"{idx:02d}_{src.name}"
        dest = stage / dest_name
        shutil.copy2(src, dest)
        files.append({
            "index": idx,
            "filename": dest_name,
            "item_id": iid,
            "title": item.title or "",
            "url": f"/api/content/{note_id}/stage-images/{dest_name}",
        })

    return {
        "note_id": note_id,
        "stage_dir": str(stage),
        "count": len(files),
        "files": files,
    }


@router.get("/{note_id}/stage-images/{filename}")
def api_serve_stage_image(note_id: int, filename: str):
    """提供暂存图片的文件服务"""
    # 防止路径穿越
    safe_name = Path(filename).name
    img = _stage_dir(note_id) / safe_name
    if not img.exists():
        raise HTTPException(404, "图片不存在，请先调用 POST stage-images")
    return FileResponse(str(img))


@router.delete("/{note_id}/stage-images")
def api_clear_stage_images(note_id: int):
    """确认发布后清理暂存目录"""
    stage = _stage_dir(note_id)
    if stage.exists():
        shutil.rmtree(stage)
    return {"ok": True, "note_id": note_id}


@router.post("/{note_id}/open-stage-dir")
def api_open_stage_dir(note_id: int):
    """在 Finder（macOS）中打开暂存目录，方便用户拖拽上传图片"""
    stage = _stage_dir(note_id)
    if not stage.exists():
        raise HTTPException(404, "暂存目录不存在，请先调用 POST stage-images")
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(stage)])
    elif sys.platform.startswith("linux"):
        subprocess.Popen(["xdg-open", str(stage)])
    else:
        subprocess.Popen(["explorer", str(stage)])
    return {"ok": True, "path": str(stage)}


@router.post("/draft")
def api_draft(body: DraftRequest):
    """生成笔记创作 Prompt（供 AI 使用）"""
    from app.modules.content.prompt_builder import build_draft_prompt
    from app.routers.knowledge import build_knowledge_ctx
    from app.db.connection import get_db

    pool_id = _active_pool_id()
    item = get_item(body.item_id, account_pool_id=pool_id)
    if not item:
        raise HTTPException(404, f"物品 {body.item_id} 不存在")

    conn = get_db()
    try:
        profile_row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?",
            (pool_id,),
        ).fetchone()
        profile = dict(profile_row) if profile_row else {}
        account_row = None
        if body.account_id:
            account_row = conn.execute(
                "SELECT * FROM reference_accounts WHERE account_id=? AND account_pool_id=?",
                (body.account_id, pool_id),
            ).fetchone()
            account = dict(account_row) if account_row else None
        else:
            account = None
        # 构建经验库上下文
        knowledge_ctx = build_knowledge_ctx(conn, account_pool_id=pool_id)
    finally:
        conn.close()

    prompt = build_draft_prompt(
        item, my_profile=profile, reference=account, knowledge_ctx=knowledge_ctx
    )

    # 生成注入摘要供前端展示
    knowledge_summary = _build_knowledge_summary(knowledge_ctx)

    note_id = None
    if body.save:
        note = create_note(
            item_id=body.item_id,
            item_ids=[body.item_id] if body.item_id else [],
            account_ref=body.account_id,
            prompt_used=prompt,
            account_pool_id=pool_id,
        )
        note_id = note.id

    return {"prompt": prompt, "note_id": note_id, "knowledge_summary": knowledge_summary}


class MultiDraftRequest(BaseModel):
    item_ids: list[int]
    account_id: Optional[str] = None


@router.post("/draft/multi")
def api_draft_multi(body: MultiDraftRequest):
    """将多个图库物品合并生成一个笔记草稿，返回 note_id"""
    from app.modules.content.prompt_builder import build_multi_draft_prompt
    from app.routers.knowledge import build_knowledge_ctx

    if not body.item_ids:
        raise HTTPException(400, "item_ids 不能为空")

    pool_id = _active_pool_id()

    items = []
    for item_id in body.item_ids:
        item = get_item(item_id, account_pool_id=pool_id)
        if not item:
            raise HTTPException(404, f"物品 {item_id} 不存在")
        items.append(item)

    conn = get_db()
    try:
        profile_row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?",
            (pool_id,),
        ).fetchone()
        profile = dict(profile_row) if profile_row else {}
        account = None
        if body.account_id:
            row = conn.execute(
                "SELECT * FROM reference_accounts WHERE account_id=? AND account_pool_id=?",
                (body.account_id, pool_id)
            ).fetchone()
            account = dict(row) if row else None
        knowledge_ctx = build_knowledge_ctx(conn, account_pool_id=pool_id)
    finally:
        conn.close()

    prompt = build_multi_draft_prompt(
        items, my_profile=profile, reference=account, knowledge_ctx=knowledge_ctx
    )
    note = create_note(
        item_ids=[item.id for item in items],
        account_ref=body.account_id,
        prompt_used=prompt,
        account_pool_id=pool_id,
    )
    return {
        "note_id": note.id,
        "item_count": len(items),
        "knowledge_summary": _build_knowledge_summary(knowledge_ctx),
    }


# ── 解析 AI 输出 ──────────────────────────────────────────────────────────────

def _parse_ai_draft(text: str) -> dict:
    """
    解析 AI 按结构化格式输出的草稿内容，提取：
    - title: 第一个标题候选（情绪型优先）
    - body: 正文三段合并（纯文本）
    - tags: 话题标签列表
    """
    import re

    title = ""
    body = ""
    tags: list[str] = []

    # ── 标题：取第一个非空候选 ──
    title_block = re.search(r"---标题候选.*?---\s*(.*?)(?=---|$)", text, re.S)
    if title_block:
        for line in title_block.group(1).strip().splitlines():
            line = line.strip()
            # 去掉「情绪型：」「问题型：」前缀
            candidate = re.sub(r"^(情绪型|问题型|场景型)[：:]\s*", "", line).strip()
            if candidate:
                title = candidate
                break

    # ── 正文：合并三段 ──
    body_block = re.search(r"---正文---\s*(.*?)(?=---互动引导---|---话题标签---|---创作备注---|$)", text, re.S)
    if body_block:
        raw = body_block.group(1).strip()
        # 去掉段落注释行（如「（第 1 段·钩子）」）
        raw = re.sub(r"（[^）]*）", "", raw)
        # 合并空行，修剪
        paragraphs = [p.strip() for p in re.split(r"\n{2,}", raw) if p.strip()]
        body = "\n\n".join(paragraphs)

    # ── 互动引导：追加到正文末尾 ──
    cta_block = re.search(r"---互动引导---\s*(.*?)(?=---话题标签---|---创作备注---|$)", text, re.S)
    if cta_block:
        cta = cta_block.group(1).strip()
        cta = re.sub(r"（[^）]*）", "", cta).strip()
        if cta and body:
            body = body + "\n\n" + cta
        elif cta:
            body = cta

    # ── 话题标签 ──
    tags_block = re.search(r"---话题标签---\s*(.*?)(?=---创作备注---|$)", text, re.S)
    if tags_block:
        raw_tags = tags_block.group(1).strip()
        found = re.findall(r"#([\w\u4e00-\u9fff\-_]+)", raw_tags)
        tags = found

    return {"title": title, "body": body, "tags": tags}


def _call_ai_sync(prompt: str) -> str:
    """同步调用 MiniMax 生成内容，返回纯文本。"""
    import os
    import anthropic

    api_key = os.getenv("MINIMAX_API_KEY", "")
    base_url = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
    model = os.getenv("MINIMAX_TEXT_MODEL", "MiniMax-M2.7")

    client = anthropic.Anthropic(api_key=api_key, base_url=base_url)
    resp = client.messages.create(
        model=model,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text


class GenerateDraftRequest(BaseModel):
    item_id: Optional[int] = None
    item_ids: Optional[list[int]] = None
    account_id: Optional[str] = None


@router.post("/draft/generate")
def api_draft_generate(body: GenerateDraftRequest):
    """
    调用 AI 直接生成笔记内容，解析后填入草稿（title / body / tags）。
    支持单图（item_id）和多图（item_ids）。
    """
    from app.modules.content.prompt_builder import build_draft_prompt, build_multi_draft_prompt

    # 收集 item_ids
    ids: list[int] = []
    if body.item_ids:
        ids = body.item_ids
    elif body.item_id:
        ids = [body.item_id]
    if not ids:
        raise HTTPException(400, "item_id 或 item_ids 不能为空")

    pool_id = _active_pool_id()
    items = []
    for iid in ids:
        item = get_item(iid, account_pool_id=pool_id)
        if not item:
            raise HTTPException(404, f"物品 {iid} 不存在")
        items.append(item)

    conn = get_db()
    try:
        profile_row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?",
            (pool_id,),
        ).fetchone()
        profile = dict(profile_row) if profile_row else {}
        account = None
        if body.account_id:
            row = conn.execute(
                "SELECT * FROM reference_accounts WHERE account_id=? AND account_pool_id=?",
                (body.account_id, pool_id),
            ).fetchone()
            account = dict(row) if row else None
    finally:
        conn.close()

    # 构建 prompt
    if len(items) == 1:
        prompt = build_draft_prompt(items[0], my_profile=profile, reference=account)
    else:
        prompt = build_multi_draft_prompt(items, my_profile=profile, reference=account)

    # 调 AI
    try:
        ai_text = _call_ai_sync(prompt)
    except Exception as e:
        raise HTTPException(500, f"AI 生成失败：{e}")

    # 解析
    parsed = _parse_ai_draft(ai_text)

    # 创建草稿并填入内容
    note = create_note(
        item_id=ids[0],
        item_ids=ids,
        account_ref=body.account_id,
        prompt_used=prompt,
        account_pool_id=pool_id,
    )
    update_note_content(
        note.id,
        title=parsed["title"] or None,
        body=parsed["body"] or None,
        tags=parsed["tags"] if parsed["tags"] else None,
    )

    return {
        "note_id": note.id,
        "title": parsed["title"],
        "body": parsed["body"],
        "tags": parsed["tags"],
    }


@router.post("/{note_id}/publish-auto",
             dependencies=[Depends(require_protection("publish_auto"))])
def api_publish_auto(note_id: int):
    """
    在后台启动 Playwright 脚本将笔记自动发布到小红书。
    立即返回 {"job_id": str, "status": "running"}，通过 GET /{note_id}/publish-status/{job_id} 轮询结果。
    """
    import subprocess, sys, threading
    from pathlib import Path
    import uuid, time

    note = get_note(note_id, account_pool_id=_active_pool_id())
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    if not note.title:
        raise HTTPException(400, "笔记标题为空，请先完善内容")

    project_root = Path(__file__).parent.parent.parent
    publish_script = project_root / "crawler" / "xhs_publish.py"
    mc_python = project_root / "tools" / "MediaCrawler" / ".venv" / "bin" / "python"
    python_exe = str(mc_python) if mc_python.exists() else sys.executable

    job_id = str(uuid.uuid4())[:8]
    _publish_jobs[job_id] = {"status": "running", "note_id": note_id, "started_at": time.time()}

    # v0.2: 透传当前激活账号的 user_data_dir
    user_data_dir = account_pool.get_active_user_data_dir()

    def _run():
        try:
            result = subprocess.run(
                [python_exe, str(publish_script), "--note-id", str(note_id),
                 "--user-data-dir", user_data_dir],
                capture_output=True,
                text=True,
                timeout=300,
                cwd=str(project_root),
            )
            stdout = result.stdout or ""
            stderr = result.stderr or ""
            note_url = None
            for line in stdout.splitlines():
                if "笔记链接：" in line:
                    url_part = line.split("笔记链接：", 1)[-1].strip()
                    if url_part and url_part != "（未获取到链接）":
                        note_url = url_part
            if result.returncode == 0:
                _publish_jobs[job_id] = {
                    "status": "done", "success": True,
                    "note_id": note_id, "note_url": note_url,
                    "log": stdout, "error": None,
                }
            else:
                _publish_jobs[job_id] = {
                    "status": "done", "success": False,
                    "note_id": note_id, "note_url": None,
                    "log": stdout + stderr,
                    "error": (stderr or stdout or "发布脚本返回非零退出码")[-500:],
                }
        except subprocess.TimeoutExpired:
            _publish_jobs[job_id] = {
                "status": "done", "success": False,
                "note_id": note_id, "note_url": None,
                "log": "", "error": "发布超时（>5分钟）",
            }
        except Exception as e:
            _publish_jobs[job_id] = {
                "status": "done", "success": False,
                "note_id": note_id, "note_url": None,
                "log": "", "error": str(e),
            }

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return {"job_id": job_id, "status": "running"}


@router.get("/{note_id}/publish-status/{job_id}")
def api_publish_status(note_id: int, job_id: str):
    """轮询自动发布任务状态"""
    job = _publish_jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"任务 {job_id} 不存在")
    return job


def _build_knowledge_summary(knowledge_ctx: dict) -> str:
    """生成简短的经验库注入摘要，供前端 AI 面板展示。"""
    if not knowledge_ctx:
        return ""
    parts = []
    n_rules = len(knowledge_ctx.get("rules") or [])
    n_my = len(knowledge_ctx.get("my_samples") or [])
    n_ref = len(knowledge_ctx.get("ref_samples") or [])
    n_insp = len(knowledge_ctx.get("inspirations") or [])
    if n_rules:
        parts.append(f"{n_rules} 条互动规律")
    if n_my:
        parts.append(f"{n_my} 篇高赞样本")
    if n_ref:
        parts.append(f"{n_ref} 篇榜样参考")
    if n_insp:
        parts.append(f"{n_insp} 条选题灵感")
    if not parts:
        return ""
    return "已注入：" + " · ".join(parts)
