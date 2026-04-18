# -*- coding: utf-8 -*-
"""笔记草稿 REST API"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.db.connection import get_db
from app.models.item import Note
from app.modules.content.manager import (
    create_note, get_note, list_notes,
    update_note_content, update_note_status, delete_note, export_note_markdown,
)
from app.modules.library.manager import get_item

router = APIRouter(prefix="/api/content", tags=["content"])


class NoteCreate(BaseModel):
    item_id: Optional[int] = None
    account_ref: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[list[str]] = None
    cover_desc: Optional[str] = None
    prompt_used: Optional[str] = None


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[list[str]] = None
    cover_desc: Optional[str] = None


class StatusUpdate(BaseModel):
    status: str
    note_url: Optional[str] = None


class DraftRequest(BaseModel):
    item_id: int
    account_id: Optional[str] = None
    save: bool = False


@router.get("/", response_model=list[Note])
def api_list_notes(
    status: Optional[str] = Query(None),
    item_id: Optional[int] = Query(None),
):
    return list_notes(status=status, item_id=item_id)


@router.get("/{note_id}", response_model=Note)
def api_get_note(note_id: int):
    note = get_note(note_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    return note


@router.post("/", response_model=Note)
def api_create_note(body: NoteCreate):
    return create_note(**body.model_dump())


@router.patch("/{note_id}", response_model=Note)
def api_update_note(note_id: int, body: NoteUpdate):
    note = get_note(note_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    return update_note_content(note_id, **body.model_dump(exclude_none=True))


@router.patch("/{note_id}/status", response_model=Note)
def api_update_status(note_id: int, body: StatusUpdate):
    note = get_note(note_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    if body.status not in ("draft", "ready", "published"):
        raise HTTPException(400, "status 必须是 draft / ready / published")
    return update_note_status(note_id, body.status, note_url=body.note_url)


@router.delete("/{note_id}")
def api_delete_note(note_id: int):
    ok = delete_note(note_id)
    if not ok:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    return {"ok": True}


@router.get("/{note_id}/export")
def api_export_note(note_id: int):
    note = get_note(note_id)
    if not note:
        raise HTTPException(404, f"笔记 {note_id} 不存在")
    item_title = ""
    if note.item_id:
        item = get_item(note.item_id)
        item_title = item.title if item else ""
    md = export_note_markdown(note, item_title=item_title)
    return {"markdown": md}


@router.post("/draft")
def api_draft_prompt(body: DraftRequest):
    """生成笔记创作 Prompt（供 AI 使用）"""
    from app.modules.content.prompt_builder import build_draft_prompt
    from app.db.connection import get_db

    item = get_item(body.item_id)
    if not item:
        raise HTTPException(404, f"物品 {body.item_id} 不存在")

    conn = get_db()
    try:
        profile_row = conn.execute("SELECT * FROM my_profile WHERE id=1").fetchone()
        profile = dict(profile_row) if profile_row else {}
        account_row = None
        if body.account_id:
            account_row = conn.execute(
                "SELECT * FROM reference_accounts WHERE account_id=?",
                (body.account_id,)
            ).fetchone()
            account = dict(account_row) if account_row else None
        else:
            account = None
    finally:
        conn.close()

    prompt = build_draft_prompt(item, my_profile=profile, reference=account)

    note_id = None
    if body.save:
        note = create_note(
            item_id=body.item_id,
            item_ids=[body.item_id] if body.item_id else [],
            account_ref=body.account_id,
            prompt_used=prompt,
        )
        note_id = note.id

    return {"prompt": prompt, "note_id": note_id}


class MultiDraftRequest(BaseModel):
    item_ids: list[int]
    account_id: Optional[str] = None


@router.post("/draft/multi")
def api_draft_multi(body: MultiDraftRequest):
    """将多个图库物品合并生成一个笔记草稿，返回 note_id"""
    from app.modules.content.prompt_builder import build_multi_draft_prompt

    if not body.item_ids:
        raise HTTPException(400, "item_ids 不能为空")

    items = []
    for item_id in body.item_ids:
        item = get_item(item_id)
        if not item:
            raise HTTPException(404, f"物品 {item_id} 不存在")
        items.append(item)

    conn = get_db()
    try:
        profile_row = conn.execute("SELECT * FROM my_profile WHERE id=1").fetchone()
        profile = dict(profile_row) if profile_row else {}
        account = None
        if body.account_id:
            row = conn.execute(
                "SELECT * FROM reference_accounts WHERE account_id=?",
                (body.account_id,)
            ).fetchone()
            account = dict(row) if row else None
    finally:
        conn.close()

    prompt = build_multi_draft_prompt(items, my_profile=profile, reference=account)
    # 以第一个物品作为主物品关联（item_id），其余物品信息在 prompt 中体现
    note = create_note(
        item_ids=[item.id for item in items],
        account_ref=body.account_id,
        prompt_used=prompt,
    )
    return {"note_id": note.id, "item_count": len(items)}
