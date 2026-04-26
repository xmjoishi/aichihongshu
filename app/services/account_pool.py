# -*- coding: utf-8 -*-
"""账号池业务逻辑（v0.2 多账号隔离）

每个账号对应独立的浏览器 user_data_dir，主号 / 发布小号 / 抓取小号互不污染。
"""

import re
from pathlib import Path
from typing import Optional

from app.db.connection import BROWSER_PROFILES_ROOT, get_db


VALID_ROLES = {"operation", "assistant"}
VALID_STATUS = {"active", "banned", "suspended", "retired"}

# 顶栏激活账号语义：仅 operation 账号可作为「当前操作主体」。
# assistant 仅在浏览器/爬虫场景按需选用，不会出现在顶栏 active 上下文。
ACTIVATABLE_ROLES = {"operation"}


def _safe_dirname(alias: str) -> str:
    """把别名转成可作目录名的安全字符串。"""
    s = re.sub(r"[^\w\u4e00-\u9fff\-]+", "_", alias.strip())
    return s or "account"


def list_accounts() -> list[dict]:
    """列出所有账号（按 created_at 升序）"""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM account_pool ORDER BY id ASC"
        ).fetchall()
        active_id = get_active_id(conn)
        out = []
        for r in rows:
            d = dict(r)
            d["is_active"] = (d["id"] == active_id)
            out.append(d)
        return out
    finally:
        conn.close()


def get_account(account_id: int) -> Optional[dict]:
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM account_pool WHERE id=?", (account_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_active_id(conn=None) -> Optional[int]:
    """读取当前激活账号 id（来自 app_settings）。"""
    own = False
    if conn is None:
        conn = get_db()
        own = True
    try:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key='active_account_id'"
        ).fetchone()
        if not row or not row["value"]:
            return None
        try:
            return int(row["value"])
        except ValueError:
            return None
    finally:
        if own:
            conn.close()


def get_active() -> Optional[dict]:
    """获取当前激活账号的完整记录"""
    aid = get_active_id()
    if not aid:
        return None
    return get_account(aid)


def get_active_user_data_dir() -> str:
    """获取当前激活账号的 user_data_dir（绝对路径字符串）。
    如果没有激活账号或目录不存在，回退到 data/browser_profiles/main/。
    """
    active = get_active()
    if active and active.get("user_data_dir"):
        p = Path(active["user_data_dir"])
        p.mkdir(parents=True, exist_ok=True)
        return str(p)
    # 回退
    fallback = BROWSER_PROFILES_ROOT / "main"
    fallback.mkdir(parents=True, exist_ok=True)
    return str(fallback)


def create_account(alias: str, role: str = "operation", notes: Optional[str] = None) -> dict:
    """创建新账号，自动建立独立 user_data_dir。
    若是 operation 账号，自动在 my_profile 中 insert 一行空人设记录。
    """
    if role not in VALID_ROLES:
        raise ValueError(f"role 必须是 {VALID_ROLES} 之一")
    alias = alias.strip()
    if not alias:
        raise ValueError("alias 不能为空")

    BROWSER_PROFILES_ROOT.mkdir(parents=True, exist_ok=True)
    base_name = _safe_dirname(alias)
    dir_path = BROWSER_PROFILES_ROOT / base_name
    # 重名时追加 -2/-3
    suffix = 2
    while dir_path.exists():
        dir_path = BROWSER_PROFILES_ROOT / f"{base_name}-{suffix}"
        suffix += 1
    dir_path.mkdir(parents=True, exist_ok=True)

    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO account_pool
               (alias, role, user_data_dir, status, notes)
               VALUES (?, ?, ?, 'active', ?)""",
            (alias, role, str(dir_path), notes),
        )
        new_id = cur.lastrowid
        # operation 账号：自动建空人设行
        if role == "operation":
            conn.execute(
                """INSERT INTO my_profile (account_pool_id, display_name)
                   VALUES (?, ?)""",
                (new_id, alias),
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM account_pool WHERE id=?", (new_id,)
        ).fetchone()
        return dict(row)
    finally:
        conn.close()


def update_account(account_id: int, **fields) -> Optional[dict]:
    """允许更新 alias / role / notes / status / xhs_user_id / display_name / followers"""
    allowed = {"alias", "role", "notes", "status", "xhs_user_id",
               "display_name", "followers"}
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if "role" in updates and updates["role"] not in VALID_ROLES:
        raise ValueError(f"role 必须是 {VALID_ROLES} 之一")
    if "status" in updates and updates["status"] not in VALID_STATUS:
        raise ValueError(f"status 必须是 {VALID_STATUS} 之一")
    if not updates:
        return get_account(account_id)

    set_clause = ", ".join(f"{k}=?" for k in updates)
    params = list(updates.values()) + [account_id]
    conn = get_db()
    try:
        conn.execute(
            f"UPDATE account_pool SET {set_clause} WHERE id=?", params
        )
        conn.commit()
    finally:
        conn.close()
    return get_account(account_id)


def delete_account(account_id: int) -> bool:
    """软删除：status=retired，保留 user_data_dir。
    若被删的是激活账号，自动切换到剩余的第一个。
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id FROM account_pool WHERE id=?", (account_id,)
        ).fetchone()
        if not row:
            return False
        conn.execute(
            "UPDATE account_pool SET status='retired' WHERE id=?",
            (account_id,),
        )
        # 若是激活账号，切到下一个 active operation
        if get_active_id(conn) == account_id:
            nxt = conn.execute(
                "SELECT id FROM account_pool WHERE status='active' "
                "AND role='operation' AND id<>? ORDER BY id ASC LIMIT 1",
                (account_id,),
            ).fetchone()
            new_active = str(nxt["id"]) if nxt else ""
            conn.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES ('active_account_id', ?, datetime('now','localtime'))
                   ON CONFLICT(key) DO UPDATE SET
                     value=excluded.value, updated_at=excluded.updated_at""",
                (new_active,),
            )
        conn.commit()
        return True
    finally:
        conn.close()


def switch_active(account_id: int) -> dict:
    """切换激活账号，返回新激活的账号记录。
    限制：只能激活 operation 账号；assistant 仅在浏览器/爬虫场景按需选用。
    """
    acc = get_account(account_id)
    if not acc:
        raise ValueError(f"账号 {account_id} 不存在")
    if acc["status"] != "active":
        raise ValueError(f"账号 {acc['alias']} 已 {acc['status']}，不能激活")
    if acc["role"] not in ACTIVATABLE_ROLES:
        raise ValueError(
            f"账号 {acc['alias']} 是「辅助账号」，不能作为顶栏激活账号；"
            f"请在浏览器/爬虫场景中按需选择。"
        )

    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO app_settings (key, value, updated_at)
               VALUES ('active_account_id', ?, datetime('now','localtime'))
               ON CONFLICT(key) DO UPDATE SET
                 value=excluded.value, updated_at=excluded.updated_at""",
            (str(account_id),),
        )
        conn.execute(
            "UPDATE account_pool SET last_used_at=datetime('now','localtime') WHERE id=?",
            (account_id,),
        )
        conn.commit()
    finally:
        conn.close()
    acc["is_active"] = True
    return acc


def mark_banned(account_id: int) -> Optional[dict]:
    """标记账号为封号状态，ban_count + 1"""
    conn = get_db()
    try:
        conn.execute(
            "UPDATE account_pool SET status='banned', ban_count=ban_count+1 WHERE id=?",
            (account_id,),
        )
        conn.commit()
    finally:
        conn.close()
    return get_account(account_id)
