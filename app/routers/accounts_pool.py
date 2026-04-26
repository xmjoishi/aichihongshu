# -*- coding: utf-8 -*-
"""账号池 REST API（v0.2 多账号隔离）"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import account_pool


router = APIRouter(prefix="/api/account-pool", tags=["account-pool"])


class AccountCreate(BaseModel):
    alias: str
    role: str = "operation"
    notes: Optional[str] = None


class AccountUpdate(BaseModel):
    alias: Optional[str] = None
    role: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    xhs_user_id: Optional[str] = None
    display_name: Optional[str] = None
    followers: Optional[int] = None


@router.get("")
def api_list_accounts():
    return {"items": account_pool.list_accounts()}


@router.get("/active")
def api_get_active():
    acc = account_pool.get_active()
    if not acc:
        raise HTTPException(404, "尚未设置激活账号")
    acc["is_active"] = True
    return acc


@router.post("")
def api_create_account(body: AccountCreate):
    try:
        return account_pool.create_account(
            alias=body.alias, role=body.role, notes=body.notes
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.patch("/{account_id}")
def api_update_account(account_id: int, body: AccountUpdate):
    if not account_pool.get_account(account_id):
        raise HTTPException(404, f"账号 {account_id} 不存在")
    try:
        return account_pool.update_account(account_id, **body.model_dump(exclude_none=True))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/{account_id}")
def api_delete_account(account_id: int):
    ok = account_pool.delete_account(account_id)
    if not ok:
        raise HTTPException(404, f"账号 {account_id} 不存在")
    return {"ok": True}


@router.post("/{account_id}/activate")
def api_activate(account_id: int):
    try:
        return account_pool.switch_active(account_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{account_id}/mark-banned")
def api_mark_banned(account_id: int):
    acc = account_pool.mark_banned(account_id)
    if not acc:
        raise HTTPException(404, f"账号 {account_id} 不存在")
    return acc


# ── 保护策略查询接口（前端可用来展示矩阵 / 判断按钮是否禁用） ────────────────
@router.get("/protection/status")
def api_protection_status():
    """返回当前激活账号针对所有 action 的策略矩阵。
    v0.3：不再有总开关，矩阵由当前激活账号的 role 固定决定。
    """
    active = account_pool.get_active()
    if not active:
        return {"active": None, "policies": {}}

    from app.services.protection import get_policy, ACTION_LABEL_CN

    return {
        "active": active,
        "policies": {a: get_policy(a) for a in ACTION_LABEL_CN.keys()},
    }
