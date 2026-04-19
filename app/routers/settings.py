# -*- coding: utf-8 -*-
"""系统配置 REST API — 读写 .env 文件和账号人设配置字段"""

import os
import re
from pathlib import Path
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings", tags=["settings"])

ENV_PATH = Path(__file__).parent.parent.parent / ".env"

ENV_KEYS = [
    "MINIMAX_API_KEY",
    "MINIMAX_BASE_URL",
    "MINIMAX_TEXT_MODEL",
    "MINIMAX_VISION_MODEL",
    "DB_PATH",
    "ASSETS_DIR",
]


def _read_env() -> dict:
    """读取 .env 文件，返回 key->value dict（不存在则返回空 dict）"""
    result: dict = {}
    if not ENV_PATH.exists():
        return result
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            result[k.strip()] = v.strip()
    return result


def _write_env(updates: dict) -> None:
    """将 updates 写回 .env，保留注释行，新增不存在的 key"""
    lines: list[str] = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()

    written = set()
    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            k = stripped.partition("=")[0].strip()
            if k in updates:
                new_lines.append(f"{k}={updates[k]}")
                written.add(k)
                continue
        new_lines.append(line)

    # 追加新增 key
    for k, v in updates.items():
        if k not in written:
            new_lines.append(f"{k}={v}")

    ENV_PATH.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


class EnvConfig(BaseModel):
    MINIMAX_API_KEY: Optional[str] = None
    MINIMAX_BASE_URL: Optional[str] = None
    MINIMAX_TEXT_MODEL: Optional[str] = None
    MINIMAX_VISION_MODEL: Optional[str] = None


@router.get("/env")
def get_env_config():
    """获取 .env 配置（API Key 做掩码处理）"""
    env = _read_env()
    result = {}
    for k in ENV_KEYS:
        v = env.get(k) or os.environ.get(k, "")
        if k == "MINIMAX_API_KEY" and v:
            # 只显示前 8 位 + ****
            result[k] = v[:8] + "****" if len(v) > 8 else "****"
        else:
            result[k] = v
    return result


@router.patch("/env")
def update_env_config(body: EnvConfig):
    """更新 .env 配置（API Key 为空字符串时不覆盖）"""
    updates = body.model_dump(exclude_none=True)
    # 如果 API Key 是掩码（含 ****）则跳过
    if "MINIMAX_API_KEY" in updates and "****" in updates["MINIMAX_API_KEY"]:
        del updates["MINIMAX_API_KEY"]
    if not updates:
        return {"ok": True}
    _write_env(updates)
    # 同步写入当前进程 environ（无需重启即生效）
    for k, v in updates.items():
        os.environ[k] = v
    return {"ok": True}


# ── 提示词配置 ─────────────────────────────────────────────────────

class PromptConfig(BaseModel):
    key: str
    label: str
    prompt: str
    sort_order: int = 0
    enabled: bool = True


class PromptUpdate(BaseModel):
    label: Optional[str] = None
    prompt: Optional[str] = None
    sort_order: Optional[int] = None
    enabled: Optional[bool] = None


@router.get("/prompts")
def get_prompts():
    """获取所有快捷操作 prompt 配置，按 sort_order 排序"""
    from app.db.connection import get_db
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT key, label, prompt, sort_order, enabled FROM prompt_configs ORDER BY sort_order"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.put("/prompts/{key}")
def update_prompt(key: str, body: PromptUpdate):
    """更新指定 prompt 配置"""
    from app.db.connection import get_db
    conn = get_db()
    try:
        row = conn.execute("SELECT key FROM prompt_configs WHERE key=?", (key,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="prompt not found")
        updates = body.model_dump(exclude_none=True)
        if not updates:
            return {"ok": True}
        set_clause = ", ".join(f"{k}=?" for k in updates)
        set_clause += ", updated_at=datetime('now','localtime')"
        conn.execute(
            f"UPDATE prompt_configs SET {set_clause} WHERE key=?",
            [*updates.values(), key],
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/prompts")
def add_prompt(body: PromptConfig):
    """新增自定义 prompt"""
    from app.db.connection import get_db
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO prompt_configs (key, label, prompt, sort_order, enabled)
               VALUES (?, ?, ?, ?, ?)""",
            (body.key, body.label, body.prompt, body.sort_order, 1 if body.enabled else 0),
        )
        conn.commit()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()


@router.delete("/prompts/{key}")
def delete_prompt(key: str):
    """删除自定义 prompt（内置的也可删，重置时重新 init_db 即可恢复）"""
    from app.db.connection import get_db
    conn = get_db()
    try:
        conn.execute("DELETE FROM prompt_configs WHERE key=?", (key,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
