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
            """SELECT followers, total_notes, avg_likes, avg_comments, avg_collects,
                      persona_name, niche, display_name
               FROM my_profile WHERE id=1"""
        ).fetchone()
        profile = dict(profile_row) if profile_row else {}

        top_notes = conn.execute(
            """SELECT n.id, n.title, n.likes, n.comments, n.collects,
                      i.title as item_title, n.note_url
               FROM notes n LEFT JOIN items i ON n.item_id=i.id
               WHERE n.status='published'
               ORDER BY n.likes DESC LIMIT 10"""
        ).fetchall()

        # 今日建议行动所需数据
        # 有图片但尚未生成任何笔记的图库物品数
        items_without_notes = conn.execute(
            """SELECT COUNT(*) FROM items i
               WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.item_id=i.id)"""
        ).fetchone()[0]
        # 距上次发布多少天
        last_published = conn.execute(
            "SELECT MAX(published_at) FROM notes WHERE status='published' AND published_at IS NOT NULL"
        ).fetchone()[0]
        days_since_publish = None
        if last_published:
            from datetime import datetime as _dt
            try:
                last_dt = _dt.fromisoformat(last_published)
                days_since_publish = (_dt.now() - last_dt).days
            except Exception:
                pass
        # 草稿数
        draft_count = notes_by_status.get("draft", 0)

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
            "suggestions": {
                "items_without_notes": items_without_notes,
                "days_since_publish": days_since_publish,
                "draft_count": draft_count,
            },
        }
    finally:
        conn.close()


@router.get("/notes")
def api_analytics_notes(sort: str = "likes"):
    """已发布笔记列表，按互动数据排序（sort=likes/collects/comments）"""
    allowed = {"likes", "collects", "comments"}
    if sort not in allowed:
        sort = "likes"
    conn = get_db()
    try:
        rows = conn.execute(
            f"""SELECT n.id, n.title, n.likes, n.comments, n.collects,
                       n.published_at, n.note_url, n.cover_desc,
                       i.image_path as cover_image
                FROM notes n LEFT JOIN items i ON n.item_id = i.id
                WHERE n.status = 'published'
                ORDER BY n.{sort} DESC"""
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            total = (d["likes"] or 0) + (d["comments"] or 0) + (d["collects"] or 0)
            d["engagement_rate"] = round(total / max(d["likes"] or 1, 1), 2)
            result.append(d)
        return result
    finally:
        conn.close()


@router.get("/insights")
def api_analytics_insights():
    """内容规律洞察：标题字数分布、发布时段、标签词频、与榜样账号对比"""
    conn = get_db()
    try:
        # 标题字数 vs 平均点赞（分桶）
        title_rows = conn.execute(
            """SELECT title, likes FROM notes WHERE status='published' AND title IS NOT NULL"""
        ).fetchall()
        buckets: dict = {"<10": [], "10-20": [], "20-30": [], "30+": []}
        for r in title_rows:
            ln = len(r[0] or "")
            if ln < 10:
                buckets["<10"].append(r[1] or 0)
            elif ln < 20:
                buckets["10-20"].append(r[1] or 0)
            elif ln < 30:
                buckets["20-30"].append(r[1] or 0)
            else:
                buckets["30+"].append(r[1] or 0)
        title_dist = [
            {"range": k, "avg_likes": round(sum(v) / len(v), 1) if v else 0, "count": len(v)}
            for k, v in buckets.items()
        ]

        # 发布时段（按小时）
        hour_rows = conn.execute(
            """SELECT strftime('%H', published_at) as hour,
                      AVG(likes) as avg_likes, COUNT(*) as count
               FROM notes
               WHERE status='published' AND published_at IS NOT NULL
               GROUP BY hour ORDER BY hour"""
        ).fetchall()
        hour_dist = [
            {"hour": int(r[0]), "avg_likes": round(r[1] or 0, 1), "count": r[2]}
            for r in hour_rows
        ]

        # 标签词频
        tag_rows = conn.execute(
            """SELECT tags, likes FROM notes WHERE status='published' AND tags IS NOT NULL"""
        ).fetchall()
        all_tags: dict = {}
        for r in tag_rows:
            try:
                tags = json.loads(r[0]) if isinstance(r[0], str) else (r[0] or [])
            except Exception:
                tags = []
            for t in tags:
                if t not in all_tags:
                    all_tags[t] = {"count": 0, "total_likes": 0}
                all_tags[t]["count"] += 1
                all_tags[t]["total_likes"] += r[1] or 0
        tag_freq = sorted(
            [{"tag": k, "count": v["count"], "avg_likes": round(v["total_likes"] / v["count"], 1)}
             for k, v in all_tags.items()],
            key=lambda x: x["count"], reverse=True
        )[:20]

        # 与榜样账号均值对比
        my_stats = conn.execute(
            "SELECT AVG(likes), AVG(comments), AVG(collects) FROM notes WHERE status='published'"
        ).fetchone()
        ref_stats = conn.execute(
            "SELECT AVG(avg_likes), AVG(avg_comments), AVG(avg_collects) FROM reference_accounts"
        ).fetchone()

        return {
            "title_length_dist": title_dist,
            "hour_dist": hour_dist,
            "tag_freq": tag_freq,
            "comparison": {
                "mine": {
                    "avg_likes": round(my_stats[0] or 0, 1),
                    "avg_comments": round(my_stats[1] or 0, 1),
                    "avg_collects": round(my_stats[2] or 0, 1),
                },
                "reference": {
                    "avg_likes": round(ref_stats[0] or 0, 1),
                    "avg_comments": round(ref_stats[1] or 0, 1),
                    "avg_collects": round(ref_stats[2] or 0, 1),
                },
            },
        }
    finally:
        conn.close()


@router.get("/notes-trend")
def api_notes_trend(granularity: str = "auto"):
    """笔记发布趋势（近90天，按天或周聚合）
    granularity: auto（自动判断）/ day / week
    优先使用 published_at，fallback 到 created_at
    """
    conn = get_db()
    try:
        # 统计有多少笔记有 published_at
        has_published = conn.execute(
            "SELECT COUNT(*) FROM notes WHERE status='published' AND published_at IS NOT NULL"
        ).fetchone()[0]

        if has_published >= 3:
            # 有足够发布时间数据，用 published_at
            date_expr = "date(published_at)"
            where_clause = "status='published' AND published_at IS NOT NULL AND published_at >= date('now', '-90 days')"
        else:
            # fallback：用 created_at（导入时间）
            date_expr = "date(created_at)"
            where_clause = "created_at >= date('now', '-90 days')"

        rows = conn.execute(
            f"""SELECT {date_expr} as day, COUNT(*) as count,
                       COALESCE(SUM(likes),0) as total_likes
               FROM notes
               WHERE {where_clause}
               GROUP BY day ORDER BY day"""
        ).fetchall()

        items = [{"day": r[0], "count": r[1], "total_likes": r[2]} for r in rows if r[0]]

        # 自动判断聚合粒度：跨度 > 14 天且数据点 > 10 时按周
        if granularity == "auto":
            span_days = len(items)
            granularity = "week" if span_days > 14 else "day"

        if granularity == "week" and items:
            from collections import defaultdict
            weekly: dict = defaultdict(lambda: {"count": 0, "total_likes": 0})
            for item in items:
                from datetime import datetime as _dt
                d = _dt.strptime(item["day"], "%Y-%m-%d")
                # 取本周一作为 key
                week_start = (d - __import__("datetime").timedelta(days=d.weekday())).strftime("%Y-%m-%d")
                weekly[week_start]["count"] += item["count"]
                weekly[week_start]["total_likes"] += item["total_likes"]
            items = [{"day": k, "count": v["count"], "total_likes": v["total_likes"]}
                     for k, v in sorted(weekly.items())]

        return {"granularity": granularity, "items": items}
    finally:
        conn.close()
