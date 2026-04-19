# -*- coding: utf-8 -*-
"""榜样账号 REST API"""

import json
import os
from typing import Optional, AsyncGenerator
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.db.connection import get_db
from app.models.item import ReferenceAccount

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _row_to_account(row) -> ReferenceAccount:
    return ReferenceAccount(**dict(row))


def _get_or_404(conn, account_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM reference_accounts WHERE account_id=?", (account_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, f"账号 {account_id} 不存在")
    return dict(row)


# ── 列表 ────────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[ReferenceAccount])
def api_list_accounts():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM reference_accounts ORDER BY avg_likes DESC"
        ).fetchall()
        return [_row_to_account(r) for r in rows]
    finally:
        conn.close()


# ── 单个账号详情 ─────────────────────────────────────────────────────────────

@router.get("/{account_id}", response_model=ReferenceAccount)
def api_get_account(account_id: str):
    conn = get_db()
    try:
        return ReferenceAccount(**_get_or_404(conn, account_id))
    finally:
        conn.close()


# ── 新增 / upsert ────────────────────────────────────────────────────────────

class AccountCreate(BaseModel):
    account_id: str
    name: Optional[str] = None
    followers: int = 0
    note_count: int = 0
    avg_likes: float = 0
    avg_comments: float = 0
    avg_collects: float = 0
    content_style: Optional[str] = None
    top_notes: Optional[list[dict]] = None


@router.post("/", response_model=ReferenceAccount)
def api_add_account(body: AccountCreate):
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO reference_accounts
               (account_id, name, followers, note_count, avg_likes, avg_comments,
                avg_collects, content_style, top_notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_id) DO UPDATE SET
                 name=excluded.name, followers=excluded.followers,
                 note_count=excluded.note_count, avg_likes=excluded.avg_likes,
                 avg_comments=excluded.avg_comments, avg_collects=excluded.avg_collects,
                 content_style=excluded.content_style, top_notes=excluded.top_notes,
                 crawled_at=datetime('now','localtime')""",
            (
                body.account_id, body.name, body.followers, body.note_count,
                body.avg_likes, body.avg_comments, body.avg_collects,
                body.content_style,
                json.dumps(body.top_notes or [], ensure_ascii=False),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return api_get_account(body.account_id)


# ── 编辑（PATCH） ────────────────────────────────────────────────────────────

class AccountPatch(BaseModel):
    name: Optional[str] = None
    content_style: Optional[str] = None
    followers: Optional[int] = None
    note_count: Optional[int] = None
    avg_likes: Optional[float] = None
    avg_comments: Optional[float] = None
    avg_collects: Optional[float] = None


@router.patch("/{account_id}", response_model=ReferenceAccount)
def api_patch_account(account_id: str, body: AccountPatch):
    conn = get_db()
    try:
        _get_or_404(conn, account_id)  # 确认存在
        updates = {k: v for k, v in body.model_dump().items() if v is not None}
        if not updates:
            return ReferenceAccount(**_get_or_404(conn, account_id))
        set_clause = ", ".join(f"{k}=?" for k in updates)
        values = list(updates.values()) + [account_id]
        conn.execute(
            f"UPDATE reference_accounts SET {set_clause} WHERE account_id=?", values
        )
        conn.commit()
        return ReferenceAccount(**_get_or_404(conn, account_id))
    finally:
        conn.close()


# ── 删除 ─────────────────────────────────────────────────────────────────────

@router.delete("/{account_id}")
def api_delete_account(account_id: str):
    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM reference_accounts WHERE account_id=?", (account_id,)
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── AI 工具：共用流式调用 ────────────────────────────────────────────────────

async def _stream_text(prompt: str, system: str) -> AsyncGenerator[str, None]:
    """调用 MiniMax Anthropic 兼容接口，流式 SSE"""
    import anthropic
    api_key = os.getenv("MINIMAX_API_KEY", "")
    base_url = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
    model = os.getenv("MINIMAX_TEXT_MODEL", "MiniMax-M2.7")
    client = anthropic.AsyncAnthropic(api_key=api_key, base_url=base_url)
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=2048,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            full = ""
            async for text in stream.text_stream:
                full += text
                yield f"data: {json.dumps({'text': text}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True, 'full': full}, ensure_ascii=False)}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"


async def _call_text(prompt: str, system: str, max_tokens: int = 1024) -> str:
    """非流式文本调用"""
    import anthropic
    api_key = os.getenv("MINIMAX_API_KEY", "")
    base_url = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
    model = os.getenv("MINIMAX_TEXT_MODEL", "MiniMax-M2.7")
    client = anthropic.Anthropic(api_key=api_key, base_url=base_url)
    resp = client.messages.create(
        model=model, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text


# ── AI 分析风格：POST /{account_id}/analyze ─────────────────────────────────

@router.post("/{account_id}/analyze")
async def api_analyze_account(account_id: str):
    """基于 top_notes + raw_data，AI 分析并写入 content_style（SSE 流式）"""
    conn = get_db()
    try:
        acc = _get_or_404(conn, account_id)
    finally:
        conn.close()

    top_notes = json.loads(acc.get("top_notes") or "[]")
    raw_data = acc.get("raw_data") or ""
    name = acc.get("name") or account_id

    notes_text = "\n".join(
        f"{i+1}. {n.get('title', '')}（❤{n.get('likes', 0)}）"
        for i, n in enumerate(top_notes[:20])
    ) or "（暂无高赞笔记数据）"

    raw_snippet = raw_data[:2000] if raw_data else "（无原始数据）"

    system = "你是一位小红书内容策略专家，擅长从账号数据中提炼内容风格特征。"
    prompt = f"""请分析小红书账号「{name}」的内容风格特征。

高赞笔记标题列表：
{notes_text}

原始账号数据摘要：
{raw_snippet}

请从以下维度输出风格分析（JSON 格式）：
{{
  "keywords": ["关键词1", "关键词2", ...],   // 3-6个核心风格关键词（用于展示标签）
  "tone": "语气特征描述",                     // 一句话描述语气
  "format": "内容格式特征",                   // 图文排版、封面风格等
  "hook": "开头/标题钩子套路",               // 标题/开头的套路
  "audience": "目标受众描述",
  "summary": "综合风格概述（100字内）"
}}

只输出 JSON，不要其他解释。"""

    async def generate():
        full_text = ""
        async for chunk in _stream_text(prompt, system):
            # 解析 done 信号，保存结果到 DB
            if chunk.startswith("data: "):
                try:
                    data = json.loads(chunk[6:].strip())
                    if data.get("done"):
                        full_text = data.get("full", "")
                        # 剥离 AI 可能返回的 markdown fence
                        import re as _re
                        clean = _re.sub(r"^```(?:json)?\s*", "", full_text, flags=_re.I)
                        clean = _re.sub(r"\s*```\s*$", "", clean).strip()
                        # 写入 DB
                        db = get_db()
                        try:
                            db.execute(
                                "UPDATE reference_accounts SET content_style=?, analyzed_at=datetime('now','localtime') WHERE account_id=?",
                                (clean, account_id)
                            )
                            db.commit()
                        finally:
                            db.close()
                except Exception:
                    pass
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── AI 学习要点：GET /{account_id}/insights ──────────────────────────────────

@router.get("/{account_id}/insights")
async def api_get_insights(account_id: str, refresh: bool = False):
    """
    获取/生成「值得学习的地方」摘要（SSE 流式）。
    有缓存时直接返回；refresh=true 强制重新生成。
    """
    conn = get_db()
    try:
        acc = _get_or_404(conn, account_id)
    finally:
        conn.close()

    # 有缓存且不强制刷新，直接返回
    if acc.get("insights") and not refresh:
        cached = acc["insights"]
        async def cached_stream():
            yield f"data: {json.dumps({'text': cached, 'cached': True}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"
        return StreamingResponse(
            cached_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    top_notes = json.loads(acc.get("top_notes") or "[]")
    content_style_raw = acc.get("content_style") or ""
    name = acc.get("name") or account_id
    avg_likes = acc.get("avg_likes", 0)
    followers = acc.get("followers", 0)

    # 尝试解析 content_style JSON
    style_text = content_style_raw
    if content_style_raw:
        try:
            cs = json.loads(content_style_raw)
            if isinstance(cs, dict):
                style_text = cs.get("summary", "") or content_style_raw
        except Exception:
            pass

    notes_text = "\n".join(
        f"{i+1}. {n.get('title', '')}（❤{n.get('likes', 0)}）"
        for i, n in enumerate(top_notes[:15])
    ) or "（暂无高赞笔记）"

    system = "你是小红书内容运营专家，帮助内容创作者从竞品账号中提炼可学习的创作方法论。"
    prompt = f"""账号「{name}」数据：
- 粉丝数：{followers:,}
- 均赞：{avg_likes}
- 风格分析：{style_text or '（未分析）'}

高赞笔记：
{notes_text}

请输出 4-6 条「值得学习的地方」，每条格式：
**[要点名称]**：具体说明（30字内，结合上面的数据给出可操作的结论）

要求：
- 聚焦可复制、可操作的方法，避免泛泛而谈
- 结合具体标题案例佐证
- 语气简洁直接"""

    async def generate():
        full_text = ""
        async for chunk in _stream_text(prompt, system):
            if chunk.startswith("data: "):
                try:
                    data = json.loads(chunk[6:].strip())
                    if data.get("done"):
                        full_text = data.get("full", "")
                        db = get_db()
                        try:
                            db.execute(
                                "UPDATE reference_accounts SET insights=?, insights_at=datetime('now','localtime') WHERE account_id=?",
                                (full_text, account_id)
                            )
                            db.commit()
                        finally:
                            db.close()
                except Exception:
                    pass
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── AI 仿写 Prompt：POST /{account_id}/imitate ───────────────────────────────

class ImitateRequest(BaseModel):
    note_title: str
    note_likes: int = 0
    item_title: Optional[str] = None   # 要写的物品名（可选）


@router.post("/{account_id}/imitate")
async def api_imitate(account_id: str, body: ImitateRequest):
    """针对榜样账号的某条高赞笔记，生成仿写 Prompt（非流式）"""
    conn = get_db()
    try:
        acc = _get_or_404(conn, account_id)
    finally:
        conn.close()

    name = acc.get("name") or account_id
    content_style_raw = acc.get("content_style") or ""
    style_text = content_style_raw
    if content_style_raw:
        try:
            cs = json.loads(content_style_raw)
            if isinstance(cs, dict):
                keywords = "、".join(cs.get("keywords", []))
                tone = cs.get("tone", "")
                hook = cs.get("hook", "")
                style_text = f"关键词：{keywords}；语气：{tone}；标题套路：{hook}"
        except Exception:
            pass

    item_info = f"，要写的物品/主题是「{body.item_title}」" if body.item_title else ""

    system = "你是小红书内容创作专家，帮助创作者基于竞品分析生成具体的创作指导 Prompt。"
    prompt = f"""请为以下情况生成一个完整的小红书笔记创作 Prompt：

参考账号：「{name}」
参考文章：「{body.note_title}」（❤{body.note_likes:,}）
该账号风格：{style_text or '（未分析）'}
创作任务：模仿该账号风格{item_info}，写一篇小红书笔记

请输出一个给 AI 的完整创作 Prompt，包含：
1. 风格要求（语气、格式、开头方式）
2. 标题要求（模仿上面标题的套路，但内容不同）
3. 正文结构要求
4. 话题标签建议

直接输出 Prompt 文本，不要解释。"""

    try:
        result = await _call_text(prompt, system, max_tokens=800)
        return {"prompt": result, "account_name": name, "reference_title": body.note_title}
    except Exception as e:
        raise HTTPException(500, str(e))
