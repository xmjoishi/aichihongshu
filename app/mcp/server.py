# -*- coding: utf-8 -*-
"""
MCP Server — 爱吃红薯（AI吃红书）
供 OpenCode / ClaudeCode 通过 MCP 协议直接调用项目核心功能

启动方式（stdio 模式，配置到 opencode/claude 的 mcp servers）：
    uv run python -m app.mcp.server
"""

import json
import asyncio
from pathlib import Path
from typing import Optional, List

from mcp.server.fastmcp import FastMCP

from app.db.connection import init_db

init_db()

mcp = FastMCP(
    "rednote-home",
    instructions=(
        "小红书家居/软装/出租屋改造垂类运营助手。"
        "可操作图库、笔记草稿、账号人设、榜样账号，生成内容创作 Prompt。"
        "所有写操作请先 get_profile 了解账号人设，再进行创作。"
        "v0.3 多账号隔离：所有操作针对当前激活的运营账号；切换需在 GUI 顶栏完成。"
    ),
)


def _active_pool_id() -> int:
    """获取当前激活账号 id；未激活则抛出 RuntimeError。"""
    from app.services import account_pool as _ap

    aid = _ap.get_active_id()
    if aid is None:
        raise RuntimeError("尚未激活运营账号；请先在 GUI 顶栏激活一个账号")
    return aid

# ─────────────────────────────────────────────
# Profile Tools
# ─────────────────────────────────────────────

@mcp.tool()
def get_profile() -> dict:
    """获取我的账号人设（垂类/语气/禁忌词/标签池等）— 当前激活账号"""
    from app.db.connection import get_db
    pool_id = _active_pool_id()
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?", (pool_id,)
        ).fetchone()
        if not row:
            return {"error": "当前账号尚未初始化人设，请先在 GUI「我的账号」页填写"}
        d = dict(row)
        for field in ("content_pillars", "persona_taboos", "preferred_styles",
                      "preferred_scenes", "hashtag_pool"):
            if isinstance(d.get(field), str):
                try:
                    d[field] = json.loads(d[field])
                except Exception:
                    pass
        return d
    finally:
        conn.close()


@mcp.tool()
def update_profile(
    persona_tone: str = None,
    persona_taboos: Optional[List[str]] = None,
    posting_rhythm: str = None,
    hashtag_pool: Optional[List[str]] = None,
) -> dict:
    """更新账号人设字段（语气/禁忌词/发帖节奏/标签池）"""
    from app.db.connection import get_db
    updates = {k: v for k, v in {
        "persona_tone": persona_tone,
        "persona_taboos": persona_taboos,
        "posting_rhythm": posting_rhythm,
        "hashtag_pool": hashtag_pool,
    }.items() if v is not None}

    if not updates:
        return {"error": "没有可更新的字段"}

    conn = get_db()
    try:
        set_clauses, params = [], []
        for key, val in updates.items():
            set_clauses.append(f"{key}=?")
            params.append(json.dumps(val, ensure_ascii=False) if isinstance(val, list) else val)
        set_clauses.append("updated_at=datetime('now','localtime')")
        params.append(_active_pool_id())
        conn.execute(
            f"UPDATE my_profile SET {', '.join(set_clauses)} WHERE account_pool_id=?", params
        )
        conn.commit()
    finally:
        conn.close()
    return get_profile()


# ─────────────────────────────────────────────
# Library Tools
# ─────────────────────────────────────────────

@mcp.tool()
def list_items(tag: str = None, style: str = None) -> list[dict]:
    """列出图库物品。可按 tag（标签）或 style（风格）过滤 — 当前激活账号"""
    from app.modules.library.manager import list_items as _list
    items = _list(tag=tag, style=style, account_pool_id=_active_pool_id())
    return [i.model_dump() for i in items]


@mcp.tool()
def get_item(item_id: int) -> dict:
    """获取图库物品详情，包含 MiniMax 图片分析结果 — 当前激活账号"""
    from app.modules.library.manager import get_item as _get
    item = _get(item_id, account_pool_id=_active_pool_id())
    if not item:
        return {"error": f"物品 {item_id} 不存在"}
    d = item.model_dump()
    if d.get("analysis_raw"):
        try:
            d["analysis"] = json.loads(d["analysis_raw"])
        except Exception:
            pass
    return d


@mcp.tool()
def add_item_from_path(image_path: str, title: str = None, analyze: bool = True) -> dict:
    """从本地路径导入图片到图库，analyze=True 时自动触发 MiniMax 图片分析 — 当前激活账号"""
    from app.modules.library.manager import add_item as _add
    from app.modules.library.analyzer import analyze_image

    analysis = None
    if analyze:
        analysis = analyze_image(image_path)
    item = _add(image_path, title=title, analysis=analysis, account_pool_id=_active_pool_id())
    return item.model_dump()


@mcp.tool()
def tag_item(item_id: int, tag: str, action: str = "add") -> dict:
    """给图库物品添加或删除标签。action: 'add' 或 'remove' — 当前激活账号"""
    from app.modules.library.manager import add_tag, remove_tag
    pool_id = _active_pool_id()
    if action == "add":
        item = add_tag(item_id, tag, account_pool_id=pool_id)
    else:
        item = remove_tag(item_id, tag, account_pool_id=pool_id)
    return item.model_dump()


# ─────────────────────────────────────────────
# Content Tools
# ─────────────────────────────────────────────

@mcp.tool()
def draft_note_prompt(item_id: int, account_id: str = None, save: bool = True) -> dict:
    """
    为图库物品生成笔记创作 Prompt。
    返回 prompt 文本供 AI 直接使用，save=True 时同时创建草稿记录。
    account_id: 可选的榜样账号 ID，用于风格参考
    """
    from app.modules.content.prompt_builder import build_draft_prompt
    from app.modules.library.manager import get_item as _get_item
    from app.modules.content.manager import create_note
    from app.db.connection import get_db

    item = _get_item(item_id, account_pool_id=_active_pool_id())
    if not item:
        return {"error": f"物品 {item_id} 不存在"}

    pool_id = _active_pool_id()
    conn = get_db()
    try:
        profile_row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?", (pool_id,)
        ).fetchone()
        profile = dict(profile_row) if profile_row else {}
        account = None
        if account_id:
            acc_row = conn.execute(
                "SELECT * FROM reference_accounts WHERE account_id=?", (account_id,)
            ).fetchone()
            account = dict(acc_row) if acc_row else None
    finally:
        conn.close()

    prompt = build_draft_prompt(item, profile=profile, reference_account=account)

    note_id = None
    if save:
        note = create_note(
            item_id=item_id, account_ref=account_id, prompt_used=prompt,
            account_pool_id=pool_id,
        )
        note_id = note.id

    return {"prompt": prompt, "note_id": note_id, "item_title": item.title}


@mcp.tool()
def list_notes(status: str = None, item_id: int = None) -> list[dict]:
    """列出笔记草稿。status: draft/ready/published；item_id: 按物品过滤 — 当前激活账号"""
    from app.modules.content.manager import list_notes as _list
    notes = _list(status=status, item_id=item_id, account_pool_id=_active_pool_id())
    return [n.model_dump() for n in notes]


@mcp.tool()
def get_note(note_id: int) -> dict:
    """获取笔记草稿详情 — 当前激活账号"""
    from app.modules.content.manager import get_note as _get
    note = _get(note_id, account_pool_id=_active_pool_id())
    if not note:
        return {"error": f"笔记 {note_id} 不存在"}
    return note.model_dump()


@mcp.tool()
def save_note(
    note_id: int,
    title: str = None,
    body: str = None,
    tags: Optional[List[str]] = None,
    cover_desc: str = None,
) -> dict:
    """保存笔记内容（标题/正文/标签/封面文案）"""
    from app.modules.content.manager import update_note_content
    kwargs = {k: v for k, v in {
        "title": title, "body": body, "tags": tags, "cover_desc": cover_desc
    }.items() if v is not None}
    note = update_note_content(note_id, **kwargs)
    return note.model_dump()


@mcp.tool()
def publish_note(note_id: int, note_url: str = None) -> dict:
    """将笔记标记为已发布，可同时记录发布链接"""
    from app.modules.content.manager import update_note_status
    note = update_note_status(note_id, "published", note_url=note_url)
    return note.model_dump()


@mcp.tool()
def export_note(note_id: int) -> dict:
    """导出笔记为 Markdown 格式（可直接粘贴到小红书）"""
    from app.modules.content.manager import get_note as _get, export_note_markdown
    from app.modules.library.manager import get_item as _get_item
    note = _get(note_id, account_pool_id=_active_pool_id())
    if not note:
        return {"error": f"笔记 {note_id} 不存在"}
    item_title = ""
    if note.item_id:
        item = _get_item(note.item_id, account_pool_id=_active_pool_id())
        item_title = item.title if item else ""
    return {"markdown": export_note_markdown(note, item_title=item_title)}


# ─────────────────────────────────────────────
# Accounts Tools
# ─────────────────────────────────────────────

@mcp.tool()
def list_accounts() -> list[dict]:
    """列出所有榜样账号（按均赞降序）"""
    from app.db.connection import get_db
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT account_id, name, followers, note_count, avg_likes, avg_comments, "
            "avg_collects, top_notes FROM reference_accounts ORDER BY avg_likes DESC"
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("top_notes"), str):
                try:
                    d["top_notes"] = json.loads(d["top_notes"])
                except Exception:
                    pass
            result.append(d)
        return result
    finally:
        conn.close()


@mcp.tool()
def get_analytics() -> dict:
    """获取运营数据汇总（图库数量/笔记状态/均赞评藏）"""
    from app.db.connection import get_db
    conn = get_db()
    try:
        items_count = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        notes_total = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        notes_by_status = {
            r[0]: r[1]
            for r in conn.execute(
                "SELECT status, COUNT(*) FROM notes GROUP BY status"
            ).fetchall()
        }
        return {
            "items": items_count,
            "notes": {"total": notes_total, "by_status": notes_by_status},
        }
    finally:
        conn.close()


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

def run():
    """以 stdio 模式运行 MCP Server（供 OpenCode/ClaudeCode 调用）"""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    run()
