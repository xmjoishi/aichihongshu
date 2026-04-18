# -*- coding: utf-8 -*-
"""AI 对话 SSE 接口"""

import os
import json
from typing import Optional, List, AsyncGenerator
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/ai", tags=["ai"])


class Message(BaseModel):
    role: str   # user | assistant
    content: str


class ChatRequest(BaseModel):
    messages: List[Message]
    # 上下文注入（可选）
    note_id: Optional[int] = None
    item_id: Optional[int] = None
    system_extra: Optional[str] = None  # 额外注入的系统提示


def _build_system(note_id: Optional[int], item_id: Optional[int], extra: Optional[str]) -> str:
    """构建注入了账号人设和当前内容上下文的系统 Prompt"""
    from app.db.connection import get_db

    conn = get_db()
    try:
        profile_row = conn.execute("SELECT * FROM my_profile WHERE id=1").fetchone()
        profile = dict(profile_row) if profile_row else {}

        item_info = ""
        if item_id:
            item_row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
            if item_row:
                item = dict(item_row)
                item_info = f"\n\n当前操作的图库物品：{item.get('title', '')}，风格：{item.get('style', '')}，场景：{item.get('scene', '')}，标签：{item.get('tags', '')}"

        note_info = ""
        if note_id:
            note_row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
            if note_row:
                note = dict(note_row)
                body_preview = (note.get('body') or '')[:300]
                note_info = f"\n\n当前编辑的笔记草稿：\n标题：{note.get('title') or '（无）'}\n正文：{body_preview or '（无）'}"
    finally:
        conn.close()

    persona_name = profile.get("persona_name") or "运营者"
    persona_tone = profile.get("persona_tone") or "接地气，短句，先吐槽再给结论"
    niche = profile.get("niche") or "家居软装"
    taboos_raw = profile.get("persona_taboos") or "[]"
    try:
        taboos = json.loads(taboos_raw) if isinstance(taboos_raw, str) else taboos_raw
        taboos_str = "、".join(taboos) if taboos else "无"
    except Exception:
        taboos_str = "无"

    system = f"""你是小红书家居运营助手，正在帮助账号「{persona_name}」创作内容。

【账号定位】{niche}
【语气风格】{persona_tone}
【禁忌词】{taboos_str}（这些词绝对不能出现在正文或标题中）
{item_info}{note_info}

创作规则：
- 标题：不超过 20 字，有钩子，避免感叹号堆砌
- 正文：短句换行，口语化，先抛问题再给解决方案
- 标签：5-8 个，以 # 开头，贴合内容垂类
- 禁止使用禁忌词列表中的任何词汇"""

    if extra:
        system += f"\n\n{extra}"

    return system


async def _stream_minimax(messages: list, system: str) -> AsyncGenerator[str, None]:
    """调用 MiniMax Anthropic 兼容接口，流式返回 SSE 数据（异步客户端）"""
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
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
        ) as stream:
            async for text in stream.text_stream:
                yield f"data: {json.dumps({'text': text}, ensure_ascii=False)}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
    finally:
        yield "data: [DONE]\n\n"


@router.post("/chat")
async def api_chat(body: ChatRequest):
    """AI 对话，流式 SSE 返回"""
    system = _build_system(body.note_id, body.item_id, body.system_extra)
    messages = [m.model_dump() for m in body.messages]

    return StreamingResponse(
        _stream_minimax(messages, system),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/quick")
async def api_quick(body: ChatRequest):
    """非流式 AI 快捷操作（返回完整 JSON，适合标题改写等）"""
    import anthropic

    api_key = os.getenv("MINIMAX_API_KEY", "")
    base_url = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
    model = os.getenv("MINIMAX_TEXT_MODEL", "MiniMax-M2.7")

    system = _build_system(body.note_id, body.item_id, body.system_extra)
    messages = [m.model_dump() for m in body.messages]

    client = anthropic.Anthropic(api_key=api_key, base_url=base_url)
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=1024,
            system=system,
            messages=messages,
        )
        return {"text": resp.content[0].text}
    except Exception as e:
        return {"error": str(e)}
