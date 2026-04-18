# -*- coding: utf-8 -*-
"""榜样账号 REST API"""

import json
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db.connection import get_db
from app.models.item import ReferenceAccount

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _row_to_account(row) -> ReferenceAccount:
    return ReferenceAccount(**dict(row))


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


@router.get("/{account_id}", response_model=ReferenceAccount)
def api_get_account(account_id: str):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM reference_accounts WHERE account_id=?", (account_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, f"账号 {account_id} 不存在")
        return _row_to_account(row)
    finally:
        conn.close()


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
