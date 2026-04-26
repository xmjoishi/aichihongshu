# -*- coding: utf-8 -*-
"""图库物品 CRUD 操作"""

import json
import os
import shutil
from pathlib import Path
from typing import Optional, List

from dotenv import load_dotenv

from app.db.connection import get_db
from app.models.item import Item

load_dotenv()

_PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
_ASSETS_DIR = _PROJECT_ROOT / os.getenv("ASSETS_DIR", "assets")


def _row_to_item(row) -> Item:
    return Item(**dict(row))


def update_analysis(item_id: int, analysis: dict) -> Optional[Item]:
    """将 MiniMax 分析结果写回 items 表，同时更新 title（仅当当前 title 仍是原始文件名时）"""
    a = analysis or {}
    item = get_item(item_id)
    if not item:
        return None

    ai_title = a.get("title")
    # 判断当前 title 是否是原始文件名（tmp 开头或无空格的纯 ASCII）
    # 规则：如果 title 看起来像临时文件名（无中文、无空格），则用 AI 结果覆盖
    current = item.title or ""
    is_default_name = (
        ai_title
        and (
            current.startswith("tmp")
            or (current.isascii() and " " not in current and len(current) < 20)
        )
    )

    conn = get_db()
    try:
        if is_default_name:
            conn.execute(
                """UPDATE items SET
                   title=?, style=?, material=?, scene=?, color=?,
                   tags=?, analysis_raw=?,
                   updated_at=datetime('now','localtime')
                   WHERE id=?""",
                (
                    ai_title,
                    a.get("style"),
                    a.get("material"),
                    a.get("scene"),
                    a.get("color"),
                    json.dumps(a.get("tags", []), ensure_ascii=False),
                    json.dumps(a, ensure_ascii=False),
                    item_id,
                ),
            )
        else:
            conn.execute(
                """UPDATE items SET
                   style=?, material=?, scene=?, color=?,
                   tags=?, analysis_raw=?,
                   updated_at=datetime('now','localtime')
                   WHERE id=?""",
                (
                    a.get("style"),
                    a.get("material"),
                    a.get("scene"),
                    a.get("color"),
                    json.dumps(a.get("tags", []), ensure_ascii=False),
                    json.dumps(a, ensure_ascii=False),
                    item_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return get_item(item_id)


def add_item(
    image_path: str | Path,
    title: Optional[str] = None,
    analysis: Optional[dict] = None,
    copy_to_assets: bool = True,
    account_pool_id: Optional[int] = None,
) -> Item:
    """
    添加物品到图库。
    - image_path：原始图片路径（绝对路径或相对 CWD）
    - title：物品名称；若 None 则尝试从 analysis 中读取
    - analysis：MiniMax 分析结果 dict；None 表示未分析
    - copy_to_assets：是否将图片复制到 assets/ 目录统一管理
    """
    src = Path(image_path).resolve()
    if not src.exists():
        raise FileNotFoundError(f"图片不存在：{src}")

    # 复制到 assets/
    if copy_to_assets:
        _ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        dest = _ASSETS_DIR / src.name
        if src.resolve() == dest.resolve():
            # 源文件已在 assets/ 目录内，无需复制
            stored_path = src.name
        else:
            # 文件名冲突时加数字后缀
            counter = 1
            while dest.exists():
                dest = _ASSETS_DIR / f"{src.stem}_{counter}{src.suffix}"
                counter += 1
            shutil.copy2(src, dest)
            stored_path = dest.name  # 只存文件名，相对 assets/
    else:
        stored_path = str(src)

    # 从 analysis 提取字段
    a = analysis or {}
    item_title = title or a.get("title") or src.stem

    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO items
               (title, image_path, style, material, scene, color, tags, analysis_raw, account_pool_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                item_title,
                stored_path,
                a.get("style"),
                a.get("material"),
                a.get("scene"),
                a.get("color"),
                json.dumps(a.get("tags", []), ensure_ascii=False),
                json.dumps(a, ensure_ascii=False) if a else None,
                account_pool_id,
            ),
        )
        conn.commit()
        item_id = cur.lastrowid
    finally:
        conn.close()

    return get_item(item_id)


def get_item(item_id: int, account_pool_id: Optional[int] = None) -> Optional[Item]:
    conn = get_db()
    try:
        if account_pool_id is None:
            row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM items WHERE id=? AND account_pool_id=?",
                (item_id, account_pool_id),
            ).fetchone()
        return _row_to_item(row) if row else None
    finally:
        conn.close()


def list_items(tag: Optional[str] = None, style: Optional[str] = None,
               offset: int = 0, limit: int = 50,
               account_pool_id: Optional[int] = None) -> List[Item]:
    conn = get_db()
    try:
        sql = "SELECT * FROM items WHERE deleted_at IS NULL"
        params: list = []
        if tag:
            sql += " AND tags LIKE ?"
            params.append(f'%"{tag}"%')
        if style:
            sql += " AND style LIKE ?"
            params.append(f"%{style}%")
        if account_pool_id is not None:
            sql += " AND account_pool_id=?"
            params.append(account_pool_id)
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = conn.execute(sql, params).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def add_tag(item_id: int, tag: str, account_pool_id: Optional[int] = None) -> Item:
    item = get_item(item_id, account_pool_id=account_pool_id)
    if not item:
        raise ValueError(f"物品 ID {item_id} 不存在")
    if tag not in item.tags:
        item.tags.append(tag)
    conn = get_db()
    try:
        conn.execute(
            "UPDATE items SET tags=?, updated_at=datetime('now','localtime') WHERE id=?",
            (json.dumps(item.tags, ensure_ascii=False), item_id),
        )
        conn.commit()
    finally:
        conn.close()
    return get_item(item_id, account_pool_id=account_pool_id)


def remove_tag(item_id: int, tag: str, account_pool_id: Optional[int] = None) -> Item:
    item = get_item(item_id, account_pool_id=account_pool_id)
    if not item:
        raise ValueError(f"物品 ID {item_id} 不存在")
    item.tags = [t for t in item.tags if t != tag]
    conn = get_db()
    try:
        conn.execute(
            "UPDATE items SET tags=?, updated_at=datetime('now','localtime') WHERE id=?",
            (json.dumps(item.tags, ensure_ascii=False), item_id),
        )
        conn.commit()
    finally:
        conn.close()
    return get_item(item_id, account_pool_id=account_pool_id)


def delete_item(item_id: int, delete_file: bool = False, account_pool_id: Optional[int] = None) -> bool:
    """软删除：设置 deleted_at，不删除数据库记录和磁盘文件"""
    item = get_item(item_id, account_pool_id=account_pool_id)
    if not item:
        return False
    conn = get_db()
    try:
        conn.execute(
            "UPDATE items SET deleted_at=datetime('now','localtime') WHERE id=?",
            (item_id,),
        )
        conn.commit()
    finally:
        conn.close()
    return True


def list_trash(account_pool_id: Optional[int] = None) -> List[Item]:
    """查询回收站中的物品（已软删除）"""
    conn = get_db()
    try:
        if account_pool_id is None:
            rows = conn.execute(
                "SELECT * FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM items WHERE deleted_at IS NOT NULL AND account_pool_id=? ORDER BY deleted_at DESC",
                (account_pool_id,),
            ).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def restore_item(item_id: int, account_pool_id: Optional[int] = None) -> bool:
    """从回收站恢复物品"""
    conn = get_db()
    try:
        if account_pool_id is None:
            cur = conn.execute(
                "UPDATE items SET deleted_at=NULL, updated_at=datetime('now','localtime') WHERE id=? AND deleted_at IS NOT NULL",
                (item_id,),
            )
        else:
            cur = conn.execute(
                "UPDATE items SET deleted_at=NULL, updated_at=datetime('now','localtime') WHERE id=? AND account_pool_id=? AND deleted_at IS NOT NULL",
                (item_id, account_pool_id),
            )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def purge_item(item_id: int, account_pool_id: Optional[int] = None) -> bool:
    """物理删除单个回收站物品（删除文件 + 删除DB记录）"""
    conn = get_db()
    try:
        if account_pool_id is None:
            row = conn.execute(
                "SELECT * FROM items WHERE id=? AND deleted_at IS NOT NULL", (item_id,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM items WHERE id=? AND account_pool_id=? AND deleted_at IS NOT NULL",
                (item_id, account_pool_id),
            ).fetchone()
        if not row:
            return False
        item = _row_to_item(row)
        img = image_abs_path(item)
        if img.exists():
            img.unlink()
        conn.execute("DELETE FROM items WHERE id=?", (item_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def purge_all_trash(account_pool_id: Optional[int] = None) -> int:
    """清空回收站：物理删除所有已软删除的物品，返回删除数量"""
    conn = get_db()
    try:
        if account_pool_id is None:
            rows = conn.execute(
                "SELECT * FROM items WHERE deleted_at IS NOT NULL"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM items WHERE deleted_at IS NOT NULL AND account_pool_id=?",
                (account_pool_id,),
            ).fetchall()
        count = 0
        for row in rows:
            item = _row_to_item(row)
            img = image_abs_path(item)
            if img.exists():
                img.unlink()
            conn.execute("DELETE FROM items WHERE id=?", (item.id,))
            count += 1
        conn.commit()
        return count
    finally:
        conn.close()


def image_abs_path(item: Item) -> Path:
    """返回图片的绝对路径"""
    p = Path(item.image_path)
    if p.is_absolute():
        return p
    return _ASSETS_DIR / p
