# -*- coding: utf-8 -*-
"""
从爬虫抓取的笔记数据中分析账号人设。
调用 MiniMax Anthropic 兼容接口（文本，不需要图片），
基于笔记标题+摘要推断账号定位、语气风格、话题标签等人设字段。
"""

import os
import json
import urllib.request
import urllib.error
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


_INFER_PROMPT_TMPL = """你是一位小红书家居垂类运营专家。下面是一个小红书账号的笔记数据，
请根据这些数据推断账号的人设定位，用 JSON 格式返回。

笔记数据（标题 + 描述摘要）：
{notes_text}

账号统计数据：
- 笔记总数：{note_count}
- 平均点赞：{avg_likes}
- 平均评论：{avg_comments}
- 平均收藏：{avg_collects}

请推断并返回以下 JSON（所有字段都要填，不确定的给合理推测值）：
{{
  "niche": "账号垂类定位，10-20字，如：出租屋软装改造/平价家居好物分享",
  "target_audience": "目标受众描述，如：20-30岁租房女性，追求生活质感但预算有限",
  "content_pillars": ["内容支柱1", "内容支柱2", "内容支柱3"],
  "persona_tone": "语气风格描述，10-20字，如：嘴硬傲娇，短句换行，先吐槽再给结论",
  "preferred_styles": ["家居风格1", "家居风格2"],
  "preferred_scenes": ["场景1", "场景2", "场景3"],
  "hashtag_pool": ["标签1", "标签2", "标签3", "标签4", "标签5", "标签6", "标签7", "标签8"],
  "posting_rhythm": "发帖节奏推断，如：每周2-3篇",
  "taboos": ["不适合这个账号的词汇或风格1", "不适合的2"],
  "analysis_summary": "账号整体特点总结，50字以内"
}}

hashtag_pool 只返回标签文字，不含 # 号。
taboos 是与账号气质不符、不应在文案中出现的词（如：精致/高级感/奢华 等过于调性高的词，
或与账号风格相悖的词）。
只返回 JSON，不要其他说明。"""


def _call_minimax_text(prompt: str) -> str:
    """调用 MiniMax Anthropic 兼容接口做文本生成"""
    api_key = os.getenv("MINIMAX_API_KEY")
    if not api_key:
        raise ValueError("缺少环境变量 MINIMAX_API_KEY")

    base_url = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/anthropic")
    model = os.getenv("MINIMAX_TEXT_MODEL", "MiniMax-M2.7")

    # Anthropic 兼容接口格式
    url = f"{base_url.rstrip('/')}/v1/messages"

    payload = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    }, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {error_body}") from e

    # 取文本内容（MiniMax M2.7 是 thinking 模型，content 中第一个可能是 thinking block）
    content_blocks = body.get("content", [])
    text = ""
    for block in content_blocks:
        if block.get("type") == "text":
            text = block.get("text", "")
            break

    if not text:
        raise RuntimeError(f"API 未返回文本内容，响应：{json.dumps(body, ensure_ascii=False)[:300]}")

    return text


def infer_profile_from_notes(notes: list, stats: dict) -> dict:
    """
    根据笔记列表和统计数据推断账号人设字段。

    Args:
        notes: 笔记列表，每项含 title / desc / liked_count 等字段
        stats: calc_stats 输出的统计数据

    Returns:
        推断出的人设字段 dict，key 与 my_profile 表字段对应
    """
    # 构建笔记摘要文本（最多 40 条，避免 prompt 过长）
    note_lines = []
    for i, n in enumerate(notes[:40]):
        title = (n.get("title") or n.get("desc") or "").strip()[:60]
        if title:
            note_lines.append(f"{i+1}. {title}")

    if not note_lines:
        raise ValueError("笔记列表为空，无法推断人设")

    notes_text = "\n".join(note_lines)
    prompt = _INFER_PROMPT_TMPL.format(
        notes_text=notes_text,
        note_count=stats.get("note_count", len(notes)),
        avg_likes=stats.get("avg_likes", 0),
        avg_comments=stats.get("avg_comments", 0),
        avg_collects=stats.get("avg_collects", 0),
    )

    raw = _call_minimax_text(prompt)

    # 清理 markdown 代码块
    raw = raw.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        result = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"API 返回的 JSON 解析失败：{e}\n原始内容：{raw[:300]}") from e

    return result
