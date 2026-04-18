# -*- coding: utf-8 -*-
"""数据看板 REST API"""

import json
from fastapi import APIRouter

from app.db.connection import get_db

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/summary")
def api_summary():
    """全局数据汇总"""
    conn = get_db()
    try:
        items_count = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        notes_total = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        notes_by_status = {
            r[0]: r[1]
            for r in conn.execute(
                "SELECT status, COUNT(*) FROM notes GROUP BY status"
            ).fetchall()
        }
        published_stats = conn.execute(
            "SELECT AVG(likes), AVG(comments), AVG(collects) FROM notes WHERE status='published'"
        ).fetchone()
        accounts_count = conn.execute(
            "SELECT COUNT(*) FROM reference_accounts"
        ).fetchone()[0]

        profile_row = conn.execute(
            "SELECT followers, total_notes, avg_likes, avg_comments, avg_collects FROM my_profile WHERE id=1"
        ).fetchone()
        profile = dict(profile_row) if profile_row else {}

        top_notes = conn.execute(
            """SELECT n.id, n.title, n.likes, n.comments, n.collects,
                      i.title as item_title
               FROM notes n LEFT JOIN items i ON n.item_id=i.id
               WHERE n.status='published'
               ORDER BY n.likes DESC LIMIT 10"""
        ).fetchall()

        return {
            "library": {"total_items": items_count},
            "notes": {
                "total": notes_total,
                "by_status": notes_by_status,
                "published_avg": {
                    "likes": round(published_stats[0] or 0, 1),
                    "comments": round(published_stats[1] or 0, 1),
                    "collects": round(published_stats[2] or 0, 1),
                },
            },
            "accounts": {"total": accounts_count},
            "my_profile": profile,
            "top_notes": [dict(r) for r in top_notes],
        }
    finally:
        conn.close()


@router.get("/notes-trend")
def api_notes_trend():
    """笔记发布趋势（近30天，按天聚合）"""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT date(created_at) as day, COUNT(*) as count
               FROM notes
               WHERE created_at >= date('now', '-30 days')
               GROUP BY day ORDER BY day"""
        ).fetchall()
        return [{"day": r[0], "count": r[1]} for r in rows]
    finally:
        conn.close()
