# -*- coding: utf-8 -*-
"""数据模型 Pydantic 定义"""

from __future__ import annotations
import json
from typing import Optional, List
from pydantic import BaseModel, field_validator
from datetime import datetime


class Item(BaseModel):
    """图库物品"""
    id: Optional[int] = None
    title: str
    image_path: str
    style: Optional[str] = None
    material: Optional[str] = None
    scene: Optional[str] = None
    color: Optional[str] = None
    tags: List[str] = []
    analysis_raw: Optional[str] = None
    note_count: int = 0
    account_pool_id: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                return []
        return v or []

    def tags_str(self) -> str:
        return "、".join(self.tags) if self.tags else "—"


class ReferenceAccount(BaseModel):
    """榜样账号"""
    id: Optional[int] = None
    account_id: str
    name: Optional[str] = None
    followers: int = 0
    total_likes: int = 0
    note_count: int = 0
    avg_likes: float = 0
    avg_comments: float = 0
    avg_collects: float = 0
    content_style: Optional[str] = None   # JSON 字符串
    top_notes: List[dict] = []
    raw_data: Optional[str] = None
    crawled_at: Optional[str] = None
    analyzed_at: Optional[str] = None
    insights: Optional[str] = None
    insights_at: Optional[str] = None

    @field_validator("top_notes", mode="before")
    @classmethod
    def parse_top_notes(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                return []
        return v or []


class Note(BaseModel):
    """笔记草稿"""
    id: Optional[int] = None
    item_id: Optional[int] = None
    item_ids: List[int] = []
    account_ref: Optional[str] = None
    account_pool_id: Optional[int] = None
    title: Optional[str] = None
    body: Optional[str] = None
    tags: List[str] = []
    cover_desc: Optional[str] = None
    prompt_used: Optional[str] = None
    status: str = "draft"
    note_type: str = "text"   # text（文字配图）| image（图片）| video（视频，待实现）| article（长文，待实现）
    video_path: Optional[str] = None
    published_at: Optional[str] = None
    note_url: Optional[str] = None
    likes: int = 0
    comments: int = 0
    collects: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    @field_validator("item_ids", mode="before")
    @classmethod
    def parse_item_ids(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                return []
        return v or []

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                return []
        return v or []

    def tags_str(self) -> str:
        return " ".join(f"#{t}" for t in self.tags) if self.tags else ""
