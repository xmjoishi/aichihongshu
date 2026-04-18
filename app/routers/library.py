# -*- coding: utf-8 -*-
"""图库 REST API"""

import base64
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query, BackgroundTasks
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.db.connection import get_db
from app.models.item import Item
from app.modules.library.manager import (
    add_item, get_item, list_items, add_tag, remove_tag,
    delete_item, image_abs_path, list_trash, restore_item, purge_item, purge_all_trash,
    update_analysis,
)

router = APIRouter(prefix="/api/library", tags=["library"])


class TagAction(BaseModel):
    tag: str
    action: str = "add"  # add | remove


def _with_abs_path(item: Item) -> Item:
    """将 image_path 替换为绝对路径，方便前端调用系统 open"""
    item.image_path = str(image_abs_path(item))
    return item


@router.get("/", response_model=list[Item])
def api_list_items(
    tag: Optional[str] = Query(None),
    style: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    return [_with_abs_path(i) for i in list_items(tag=tag, style=style, offset=offset, limit=limit)]


@router.get("/{item_id}", response_model=Item)
def api_get_item(item_id: int):
    item = get_item(item_id)
    if not item:
        raise HTTPException(404, f"物品 {item_id} 不存在")
    return _with_abs_path(item)


@router.post("/", response_model=Item)
async def api_add_item(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    analyze: bool = Form(True),
):
    """上传图片并导入图库，先快速入库，再后台异步 AI 分析"""
    import tempfile, shutil, os
    suffix = Path(file.filename).suffix if file.filename else ".jpg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        # 先入库（不分析），立即返回
        item = add_item(tmp_path, title=title, analysis=None)
    finally:
        os.unlink(tmp_path)

    # 后台异步分析
    if analyze:
        def _do_analyze(item_id: int, path: str):
            try:
                from app.modules.library.analyzer import analyze_image
                analysis = analyze_image(path)
                update_analysis(item_id, analysis)
            except Exception as e:
                print(f"[library] 异步分析失败 item={item_id}: {e}")

        background_tasks.add_task(_do_analyze, item.id, str(image_abs_path(item)))

    return _with_abs_path(item)


@router.post("/{item_id}/analyze", response_model=Item)
async def api_reanalyze_item(item_id: int, background_tasks: BackgroundTasks):
    """重新触发 AI 分析，后台异步执行，立即返回当前状态"""
    item = get_item(item_id)
    if not item:
        raise HTTPException(404, f"物品 {item_id} 不存在")

    def _do_analyze(iid: int, path: str):
        try:
            from app.modules.library.analyzer import analyze_image
            analysis = analyze_image(path)
            update_analysis(iid, analysis)
        except Exception as e:
            print(f"[library] 重新分析失败 item={iid}: {e}")

    background_tasks.add_task(_do_analyze, item.id, str(image_abs_path(item)))
    return _with_abs_path(item)


@router.patch("/{item_id}/tags", response_model=Item)
def api_tag_item(item_id: int, body: TagAction):
    item = get_item(item_id)
    if not item:
        raise HTTPException(404, f"物品 {item_id} 不存在")
    if body.action == "add":
        return add_tag(item_id, body.tag)
    elif body.action == "remove":
        return remove_tag(item_id, body.tag)
    raise HTTPException(400, "action 必须是 add 或 remove")


@router.delete("/{item_id}")
def api_delete_item(item_id: int, delete_file: bool = Query(False)):
    ok = delete_item(item_id)
    if not ok:
        raise HTTPException(404, f"物品 {item_id} 不存在")
    return {"ok": True}


# ── 回收站 ────────────────────────────────────────────────────────────

@router.get("/trash/list", response_model=list[Item])
def api_list_trash():
    """查询回收站中的物品"""
    return [_with_abs_path(i) for i in list_trash()]


@router.post("/trash/{item_id}/restore")
def api_restore_item(item_id: int):
    """从回收站恢复物品"""
    ok = restore_item(item_id)
    if not ok:
        raise HTTPException(404, f"物品 {item_id} 不在回收站中")
    return {"ok": True}


@router.delete("/trash/{item_id}/purge")
def api_purge_item(item_id: int):
    """物理删除单个回收站物品"""
    ok = purge_item(item_id)
    if not ok:
        raise HTTPException(404, f"物品 {item_id} 不在回收站中")
    return {"ok": True}


@router.delete("/trash/purge-all")
def api_purge_all():
    """清空回收站（物理删除所有）"""
    count = purge_all_trash()
    return {"ok": True, "deleted": count}


@router.get("/{item_id}/image")
def api_get_image(item_id: int):
    """返回物品图片文件"""
    item = get_item(item_id)
    if not item:
        raise HTTPException(404, f"物品 {item_id} 不存在")
    path = image_abs_path(item)
    if not path.exists():
        raise HTTPException(404, "图片文件不存在")
    return FileResponse(str(path))
