# -*- coding: utf-8 -*-
"""AI 对话 SSE 接口"""

import os
import json
from typing import Optional, List, AsyncGenerator
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/ai", tags=["ai"])


class InspireRequest(BaseModel):
    topic: str = ""                        # 话题/热点关键词
    item_ids: List[int] = Field(default_factory=list)  # 选中的图库图片 ID 列表
    extra_image_desc: str = ""             # 补充"还需要什么图"的文字描述
    account_ids: List[str] = Field(default_factory=list)  # 选中的榜样账号 ID 列表
    extra_instruction: str = ""            # 额外自定义指令（可选）


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
    from app.services import account_pool as _ap

    pool_id = _ap.get_active_id()
    conn = get_db()
    try:
        profile_row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?", (pool_id,)
        ).fetchone() if pool_id else None
        profile = dict(profile_row) if profile_row else {}

        item_info = ""
        if item_id:
            item_row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
            if item_row:
                item = dict(item_row)
                analysis = (item.get('analysis_raw') or '').strip()
                item_info = (
                    f"\n\n当前操作的图库物品：{item.get('title', '')}"
                    f"，风格：{item.get('style', '')}"
                    f"，场景：{item.get('scene', '')}"
                    f"，标签：{item.get('tags', '')}"
                )
                if analysis:
                    item_info += f"\n图片 AI 分析：{analysis[:500]}"

        note_info = ""
        if note_id:
            note_row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
            if note_row:
                note = dict(note_row)
                body_preview = (note.get('body') or '')[:300]
                note_info = f"\n\n当前编辑的笔记草稿：\n标题：{note.get('title') or '（无）'}\n正文：{body_preview or '（无）'}"

                # 注入笔记关联的所有图片分析结果
                item_ids_raw = note.get('item_ids') or '[]'
                try:
                    item_ids = json.loads(item_ids_raw) if isinstance(item_ids_raw, str) else item_ids_raw
                except Exception:
                    item_ids = []

                if item_ids:
                    placeholders = ','.join('?' * len(item_ids))
                    rows = conn.execute(
                        f"SELECT title, style, scene, color, material, tags, analysis_raw FROM items WHERE id IN ({placeholders})",
                        item_ids,
                    ).fetchall()
                    items_desc_parts = []
                    for r in rows:
                        r = dict(r)
                        desc = f"- 【{r.get('title', '')}】风格：{r.get('style', '')}，场景：{r.get('scene', '')}，颜色：{r.get('color', '')}，材质：{r.get('material', '')}"
                        analysis = (r.get('analysis_raw') or '').strip()
                        if analysis:
                            desc += f"\n  AI分析：{analysis[:400]}"
                        items_desc_parts.append(desc)
                    if items_desc_parts:
                        note_info += f"\n\n笔记关联图片（{len(rows)} 张）：\n" + "\n".join(items_desc_parts)
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

    system = f"""你是「爱吃红薯」小红书家居运营助手，正在帮助账号「{persona_name}」创作内容。

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


def _build_inspire_prompt(body: "InspireRequest") -> tuple[str, str]:
    """
    构建灵感生成的 system prompt + user message。
    自动注入：人设 / 数据洞察 / 所选图库图片分析 / 所选榜样风格。
    返回 (system, user_message)。
    """
    from app.db.connection import get_db
    from app.services import account_pool as _ap

    pool_id = _ap.get_active_id()
    conn = get_db()
    try:
        # --- 人设 ---
        profile_row = conn.execute(
            "SELECT * FROM my_profile WHERE account_pool_id=?", (pool_id,)
        ).fetchone() if pool_id else None
        profile = dict(profile_row) if profile_row else {}
        persona_name = profile.get("persona_name") or "运营者"
        persona_tone = profile.get("persona_tone") or "接地气，短句，先吐槽再给结论"
        niche = profile.get("niche") or "家居软装"
        taboos_raw = profile.get("persona_taboos") or "[]"
        try:
            taboos = json.loads(taboos_raw) if isinstance(taboos_raw, str) else taboos_raw
            taboos_str = "、".join(taboos) if taboos else "无"
        except Exception:
            taboos_str = "无"

        # --- 数据洞察（自动注入）---
        insights_parts: list[str] = []
        try:
            # 最佳发布时段（均赞最高的时段）
            hour_rows = conn.execute(
                """SELECT strftime('%H', published_at) as hour,
                          AVG(likes) as avg_likes, COUNT(*) as cnt
                   FROM notes
                   WHERE status='published' AND published_at IS NOT NULL
                   GROUP BY hour ORDER BY avg_likes DESC LIMIT 3"""
            ).fetchall()
            if hour_rows:
                best_hours = "、".join([f"{int(r[0])}点" for r in hour_rows])
                insights_parts.append(f"历史数据显示，在 {best_hours} 发布的帖子平均互动最高")

            # 高赞标题字数规律
            title_rows = conn.execute(
                """SELECT title, likes FROM notes WHERE status='published' AND title IS NOT NULL AND likes > 0"""
            ).fetchall()
            if len(title_rows) >= 3:
                # 按赞数排名前1/3的标题
                sorted_titles = sorted(title_rows, key=lambda x: x[1] or 0, reverse=True)
                top_n = max(1, len(sorted_titles) // 3)
                avg_len = sum(len(r[0] or "") for r in sorted_titles[:top_n]) / top_n
                insights_parts.append(f"高赞笔记标题平均字数约 {avg_len:.0f} 字")

            # 高频高赞标签
            tag_rows = conn.execute(
                """SELECT tags, likes FROM notes WHERE status='published' AND tags IS NOT NULL"""
            ).fetchall()
            tag_likes: dict = {}
            for r in tag_rows:
                try:
                    tags = json.loads(r[0]) if isinstance(r[0], str) else (r[0] or [])
                except Exception:
                    tags = []
                for t in tags:
                    if t not in tag_likes:
                        tag_likes[t] = []
                    tag_likes[t].append(r[1] or 0)
            if tag_likes:
                sorted_tags = sorted(
                    tag_likes.items(),
                    key=lambda x: sum(x[1]) / len(x[1]),
                    reverse=True
                )[:5]
                top_tags = "、".join([f"#{t}" for t, _ in sorted_tags])
                insights_parts.append(f"历史高赞帖常用标签：{top_tags}")
        except Exception:
            pass

        insights_text = ""
        if insights_parts:
            insights_text = "\n\n【你的历史数据洞察（供参考）】\n" + "\n".join(f"• {p}" for p in insights_parts)

        # --- 所选图库图片 ---
        items_text = ""
        if body.item_ids:
            placeholders = ",".join("?" * len(body.item_ids))
            item_rows = conn.execute(
                f"SELECT id, title, style, scene, color, material, tags, analysis_raw FROM items WHERE id IN ({placeholders})",
                body.item_ids,
            ).fetchall()
            items_desc = []
            for r in item_rows:
                r = dict(r)
                desc = f"- 【{r.get('title', '未命名')}】风格：{r.get('style', '')}，场景：{r.get('scene', '')}，颜色：{r.get('color', '')}，材质：{r.get('material', '')}"
                analysis = (r.get("analysis_raw") or "").strip()
                if analysis:
                    desc += f"\n  AI图片分析：{analysis[:400]}"
                items_desc.append(desc)
            items_text = f"\n\n【已选图库素材（{len(item_rows)} 张）】\n" + "\n".join(items_desc)

        if body.extra_image_desc:
            items_text += f"\n\n【还需要的图片（暂无实物，请在正文中说明）】\n{body.extra_image_desc}"

        # --- 榜样账号风格（按当前激活账号过滤） ---
        accounts_text = ""
        if body.account_ids and pool_id:
            placeholders = ",".join("?" * len(body.account_ids))
            acc_rows = conn.execute(
                f"SELECT name, content_style, top_notes FROM reference_accounts "
                f"WHERE account_id IN ({placeholders}) AND account_pool_id=?",
                list(body.account_ids) + [pool_id],
            ).fetchall()
            acc_parts = []
            for r in acc_rows:
                r = dict(r)
                style_raw = r.get("content_style") or ""
                try:
                    style_data = json.loads(style_raw) if style_raw.strip().startswith("{") else {}
                    style_summary = "、".join(filter(None, [
                        style_data.get("tone", ""),
                        style_data.get("format", ""),
                        style_data.get("hook", ""),
                    ])) or style_raw[:200]
                except Exception:
                    style_summary = style_raw[:200]
                top_notes_raw = r.get("top_notes") or ""
                try:
                    top_notes = json.loads(top_notes_raw) if top_notes_raw.strip().startswith("[") else [top_notes_raw]
                    top_notes_str = "；".join(top_notes[:3])
                except Exception:
                    top_notes_str = top_notes_raw[:200]
                acc_parts.append(
                    f"- 【{r.get('name', '榜样')}】风格特点：{style_summary}"
                    + (f"\n  高赞标题参考：{top_notes_str}" if top_notes_str else "")
                )
            if acc_parts:
                accounts_text = "\n\n【参考榜样账号风格】\n" + "\n".join(acc_parts)

    finally:
        conn.close()

    system = f"""你是「爱吃红薯」小红书家居运营助手，正在帮助账号「{persona_name}」做创意灵感发散，生成一篇完整笔记草稿。

【账号定位】{niche}
【语气风格】{persona_tone}
【禁忌词】{taboos_str}（这些词绝对不能出现）
{insights_text}

输出格式（严格按以下四段，每段用对应分隔符，直接输出内容，不要有多余说明）：
---标题候选---
（悬念型标题示例：出租屋住了两年，我才发现这件事）
（数字型标题示例：3个动作让客厅从乱到净，房东都夸）
（痛点型标题示例：餐桌永远堆东西？我用这招治好了）
---正文---
（完整正文，短句换行，emoji 点缀，先钩子/痛点，再展开，最后互动引导）
---互动引导---
（1-2 句结尾互动语，如「你们家是什么风格？」）
---话题标签---
#标签1 #标签2 #标签3 #标签4 #标签5

规则：
- 标题每个不超过 20 字，三个候选各有差异（悬念型/数字型/痛点型）
- 正文 150-300 字，不堆砌感叹号，不使用禁忌词
- 如有"还需要什么图"的素材说明，在正文合适位置注明「📷 需配图：xxx」"""

    user_message = f"话题/热点关键词：{body.topic or '（未指定，请根据素材自由发挥）'}"
    user_message += items_text + accounts_text
    if body.extra_instruction:
        user_message += f"\n\n【额外要求】{body.extra_instruction}"

    return system, user_message


@router.post("/inspire")
async def api_inspire(body: InspireRequest):
    """灵感梦工厂：基于话题、图库、榜样风格、数据洞察，流式生成一篇完整笔记草稿"""
    system, user_message = _build_inspire_prompt(body)

    return StreamingResponse(
        _stream_minimax([{"role": "user", "content": user_message}], system),
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
