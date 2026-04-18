# -*- coding: utf-8 -*-
"""MiniMax 图片分析（Token Plan 专属 /v1/coding_plan/vlm 接口）

使用与 MiniMax MCP `understand_image` 工具相同的底层接口。
"""

import os
import base64
import json
import urllib.request
import urllib.error
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

_PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
_ASSETS_DIR = _PROJECT_ROOT / os.getenv("ASSETS_DIR", "assets")

ANALYSIS_PROMPT = """你是一位专业的家居设计顾问。请分析这张家居物品图片，用 JSON 格式返回以下字段：

{
  "title": "物品名称（简洁，10字以内）",
  "style": "设计风格（如：现代简约/北欧/中式/工业/法式/日式/混搭，选最符合的1-2个）",
  "material": "主要材质（如：实木/大理石/藤编/金属/布艺/玻璃等）",
  "color": "主色调（如：米白/原木色/深灰/莫兰迪绿等）",
  "scene": "适用场景（如：客厅/卧室/书房/餐厅/玄关/阳台等）",
  "tags": ["标签1", "标签2", "标签3", "标签4", "标签5"],
  "pairing_suggestions": "搭配建议（2-3句话，说明如何与其他家居搭配）",
  "xhs_selling_points": ["小红书卖点1", "小红书卖点2", "小红书卖点3"]
}

tags 要包含：风格词、材质词、场景词、情绪词（如治愈/高级感/温暖），共5个左右。
xhs_selling_points 是最适合在小红书内容中突出的卖点，口语化，有情绪价值。
只返回 JSON，不要其他说明文字。"""


def _to_data_url(image_path: Path) -> str:
    """图片转 base64 data URL"""
    suffix = image_path.suffix.lower()
    mime_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
    }
    media_type = mime_map.get(suffix, "image/jpeg")
    b64 = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")
    return f"data:{media_type};base64,{b64}"


def analyze_image(image_path: str | Path) -> dict:
    """
    调用 MiniMax Token Plan /v1/coding_plan/vlm 接口分析图片。
    image_path 可以是绝对路径或相对 CWD 的路径。
    """
    path = Path(image_path)
    if not path.is_absolute():
        resolved = path.resolve()
        if resolved.exists():
            path = resolved
        else:
            path = _ASSETS_DIR / path.name
    if not path.exists():
        raise FileNotFoundError(f"图片不存在：{path}")

    api_key = os.getenv("MINIMAX_API_KEY")
    if not api_key:
        raise ValueError("缺少环境变量 MINIMAX_API_KEY，请复制 .env.example 为 .env 并填写")

    # Token Plan 的图片理解接口（与 MCP understand_image 相同）
    api_host = "https://api.minimaxi.com"
    url = f"{api_host}/v1/coding_plan/vlm"

    data_url = _to_data_url(path)

    payload = json.dumps({
        "prompt": ANALYSIS_PROMPT,
        "image_url": data_url,
    }, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "MM-API-Source": "rn-home-app",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {error_body}") from e

    # 检查 API 错误码
    base_resp = body.get("base_resp", {})
    if base_resp.get("status_code", 0) != 0:
        raise RuntimeError(
            f"API 错误 {base_resp.get('status_code')}: {base_resp.get('status_msg')}"
        )

    raw = body.get("content", "").strip()
    if not raw:
        raise RuntimeError("API 未返回内容")

    # 清理 markdown 代码块
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        result = {"raw_text": raw, "parse_error": True}

    result["_raw_response"] = raw
    return result
