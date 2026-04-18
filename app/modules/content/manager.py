# -*- coding: utf-8 -*-
"""笔记草稿 CRUD 操作"""

import json
from typing import Optional, List

from app.db.connection import get_db
from app.models.item import Note


def _row_to_note(row) -> Note:
    return Note(**dict(row))


def create_note(
    item_id: Optional[int] = None,
    item_ids: Optional[List[int]] = None,
    account_ref: Optional[str] = None,
    title: Optional[str] = None,
    body: Optional[str] = None,
    tags: Optional[List[str]] = None,
    cover_desc: Optional[str] = None,
    prompt_used: Optional[str] = None,
) -> Note:
    # item_ids 优先；若未传则从 item_id 推导
    ids: List[int] = item_ids if item_ids else ([item_id] if item_id else [])
    primary_id = ids[0] if ids else None
    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO notes
               (item_id, item_ids, account_ref, title, body, tags, cover_desc, prompt_used)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                primary_id,
                json.dumps(ids, ensure_ascii=False),
                account_ref,
                title,
                body,
                json.dumps(tags or [], ensure_ascii=False),
                cover_desc,
                prompt_used,
            ),
        )
        conn.commit()
        return get_note(cur.lastrowid)
    finally:
        conn.close()


def get_note(note_id: int) -> Optional[Note]:
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
        return _row_to_note(row) if row else None
    finally:
        conn.close()


def list_notes(
    status: Optional[str] = None,
    item_id: Optional[int] = None,
) -> List[Note]:
    conn = get_db()
    try:
        sql = "SELECT * FROM notes WHERE 1=1"
        params: list = []
        if status:
            sql += " AND status=?"
            params.append(status)
        if item_id:
            sql += " AND item_id=?"
            params.append(item_id)
        sql += " ORDER BY created_at DESC"
        rows = conn.execute(sql, params).fetchall()
        return [_row_to_note(r) for r in rows]
    finally:
        conn.close()


def update_note_status(note_id: int, status: str, note_url: Optional[str] = None) -> Note:
    conn = get_db()
    try:
        conn.execute(
            """UPDATE notes SET status=?, note_url=COALESCE(?, note_url),
               updated_at=datetime('now','localtime') WHERE id=?""",
            (status, note_url, note_id),
        )
        conn.commit()
    finally:
        conn.close()
    return get_note(note_id)


def update_note_content(
    note_id: int,
    title: Optional[str] = None,
    body: Optional[str] = None,
    tags: Optional[List[str]] = None,
    cover_desc: Optional[str] = None,
) -> Note:
    note = get_note(note_id)
    if not note:
        raise ValueError(f"笔记 ID {note_id} 不存在")
    conn = get_db()
    try:
        conn.execute(
            """UPDATE notes SET
               title=COALESCE(?, title),
               body=COALESCE(?, body),
               tags=COALESCE(?, tags),
               cover_desc=COALESCE(?, cover_desc),
               updated_at=datetime('now','localtime')
               WHERE id=?""",
            (
                title,
                body,
                json.dumps(tags, ensure_ascii=False) if tags is not None else None,
                cover_desc,
                note_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return get_note(note_id)


def delete_note(note_id: int) -> bool:
    conn = get_db()
    try:
        conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
        conn.commit()
    finally:
        conn.close()
    return True


def export_note_markdown(note: Note, item_title: str = "") -> str:
    """将笔记导出为 Markdown 格式"""
    lines = []
    if note.title:
        lines.append(f"# {note.title}")
    if item_title:
        lines.append(f"\n> 物品：{item_title}\n")
    if note.cover_desc:
        lines.append(f"**封面文案**：{note.cover_desc}\n")
    if note.body:
        lines.append(note.body)
    if note.tags:
        lines.append(f"\n{note.tags_str()}")
    lines.append(f"\n---\n*状态：{note.status} | 创建：{note.created_at}*")
    return "\n".join(lines)
