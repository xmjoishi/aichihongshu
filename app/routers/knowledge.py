# -*- coding: utf-8 -*-
"""经验库 REST API

管理沉淀数据：互动规律、我的高赞样本、榜样笔记样本、选题灵感。
这些数据会在生成笔记 prompt 时自动注入。
"""

import json
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db.connection import get_db
from app.services import account_pool

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


def _active_pool_id() -> int:
    """获取当前激活的运营账号 ID。无激活账号时抛 400。"""
    aid = account_pool.get_active_id()
    if aid is None:
        raise HTTPException(400, "尚未激活运营账号，请先在顶栏切换")
    return aid


# ─── 互动规律 ────────────────────────────────────────────────────────────────

@router.get("/rules")
def api_get_rules():
    """
    从已发布笔记实时计算互动规律，返回结构化规律列表。
    每条规律附带 enabled 标志（存储在 prompt_configs 表，key=rule_xxx）。
    """
    conn = get_db()
    try:
        rules = _compute_rules(conn)
        # 读取各规律的启用状态（存在 prompt_configs 表，enabled 字段复用）
        for rule in rules:
            row = conn.execute(
                "SELECT enabled FROM prompt_configs WHERE key=?", (rule["key"],)
            ).fetchone()
            rule["enabled"] = bool(row["enabled"]) if row else True
        return rules
    finally:
        conn.close()


@router.patch("/rules/{key}")
def api_toggle_rule(key: str, body: dict):
    """切换某条规律的启用状态"""
    enabled = int(bool(body.get("enabled", True)))
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO prompt_configs (key, label, prompt, enabled)
               VALUES (?, ?, '', ?)
               ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled""",
            (key, key, enabled),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def _compute_rules(conn) -> list[dict]:
    """从 notes 表实时计算互动规律，返回最多 6 条"""
    rules = []

    # 规律1：最佳标题字数区间
    rows = conn.execute(
        """SELECT
             CASE
               WHEN length(title) < 10  THEN '<10'
               WHEN length(title) < 20  THEN '10-20'
               WHEN length(title) < 30  THEN '20-30'
               ELSE '30+'
             END AS bucket,
             AVG(likes) AS avg_likes,
             COUNT(*) AS cnt
           FROM notes
           WHERE status='published' AND title IS NOT NULL AND title != ''
           GROUP BY bucket HAVING cnt >= 2
           ORDER BY avg_likes DESC LIMIT 1"""
    ).fetchone()
    if rows:
        rules.append({
            "key": "rule_title_len",
            "label": f"标题字数",
            "desc": f"{rows['bucket']} 字标题均赞最高（均赞 {round(rows['avg_likes'])}）",
            "value": rows["bucket"],
        })

    # 规律2：最佳发布时段
    rows = conn.execute(
        """SELECT strftime('%H', published_at) AS hour,
                  AVG(likes) AS avg_likes, COUNT(*) AS cnt
           FROM notes
           WHERE status='published' AND published_at IS NOT NULL
           GROUP BY hour HAVING cnt >= 2
           ORDER BY avg_likes DESC LIMIT 1"""
    ).fetchone()
    if rows:
        rules.append({
            "key": "rule_best_hour",
            "label": "最佳发布时段",
            "desc": f"{rows['hour']}:00 段互动最高（均赞 {round(rows['avg_likes'])}）",
            "value": rows["hour"],
        })

    # 规律3-5：高频高赞标签 Top3
    tag_stats: dict[str, dict] = {}
    note_rows = conn.execute(
        "SELECT tags, likes FROM notes WHERE status='published' AND tags != '[]'"
    ).fetchall()
    for row in note_rows:
        try:
            tags = json.loads(row["tags"])
        except Exception:
            continue
        for tag in tags:
            tag = tag.strip().lstrip("#")
            if not tag:
                continue
            if tag not in tag_stats:
                tag_stats[tag] = {"count": 0, "total_likes": 0}
            tag_stats[tag]["count"] += 1
            tag_stats[tag]["total_likes"] += row["likes"] or 0

    top_tags = sorted(
        [(t, s) for t, s in tag_stats.items() if s["count"] >= 2],
        key=lambda x: x[1]["total_likes"] / x[1]["count"],
        reverse=True,
    )[:3]
    for i, (tag, stats) in enumerate(top_tags):
        avg = round(stats["total_likes"] / stats["count"])
        rules.append({
            "key": f"rule_tag_{i}",
            "label": f"高效标签",
            "desc": f"#{tag} 高频且高赞（出现 {stats['count']} 次，均赞 {avg}）",
            "value": tag,
        })

    # 规律6：收藏率规律（高收藏/高点赞）
    ratio_row = conn.execute(
        """SELECT title, CAST(collects AS REAL)/NULLIF(likes,0) AS ratio, collects, likes
           FROM notes WHERE status='published' AND likes > 0
           ORDER BY ratio DESC LIMIT 1"""
    ).fetchone()
    if ratio_row and ratio_row["ratio"] and ratio_row["ratio"] > 0.3:
        rules.append({
            "key": "rule_collect_ratio",
            "label": "收藏率",
            "desc": f"高收藏笔记收藏/点赞比可达 {round(ratio_row['ratio']*100)}%，注重实用干货",
            "value": str(round(ratio_row["ratio"], 2)),
        })

    return rules


# ─── 我的高赞样本 ────────────────────────────────────────────────────────────

@router.get("/my-samples")
def api_get_my_samples():
    """返回已发布笔记列表，带 use_as_reference 字段，按点赞降序"""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, title, body, tags, likes, comments, collects,
                      published_at, note_url, use_as_reference
               FROM notes WHERE status='published'
               ORDER BY likes DESC"""
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["body_preview"] = (d.get("body") or "")[:80].strip()
            d["use_as_reference"] = bool(d.get("use_as_reference", 0))
            try:
                d["tags"] = json.loads(d.get("tags") or "[]")
            except Exception:
                d["tags"] = []
            result.append(d)
        return result
    finally:
        conn.close()


class ToggleReferenceBody(BaseModel):
    use_as_reference: bool


@router.patch("/my-samples/{note_id}")
def api_toggle_my_sample(note_id: int, body: ToggleReferenceBody):
    """切换某篇笔记的「纳入参考库」状态"""
    conn = get_db()
    try:
        conn.execute(
            "UPDATE notes SET use_as_reference=? WHERE id=?",
            (int(body.use_as_reference), note_id),
        )
        conn.commit()
        return {"ok": True, "use_as_reference": body.use_as_reference}
    finally:
        conn.close()


# ─── 榜样笔记样本 ────────────────────────────────────────────────────────────

@router.get("/ref-samples")
def api_get_ref_samples():
    """返回所有榜样账号的参考库笔记，按账号分组（仅当前激活账号）"""
    pool_id = _active_pool_id()
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT account_id, name, ref_notes FROM reference_accounts "
            "WHERE account_pool_id=? ORDER BY name",
            (pool_id,),
        ).fetchall()
        result = []
        for r in rows:
            try:
                notes = json.loads(r["ref_notes"] or "[]")
            except Exception:
                notes = []
            if notes:  # 只返回有样本的账号
                result.append({
                    "account_id": r["account_id"],
                    "name": r["name"] or r["account_id"],
                    "notes": notes,
                })
        return result
    finally:
        conn.close()


class RefSampleBody(BaseModel):
    account_id: str
    title: str
    body: Optional[str] = None
    likes: int = 0
    note_url: Optional[str] = None


@router.post("/ref-samples")
def api_add_ref_sample(body: RefSampleBody):
    """向榜样账号的参考库添加一条笔记样本（仅当前激活账号下的榜样）"""
    pool_id = _active_pool_id()
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT ref_notes FROM reference_accounts "
            "WHERE account_id=? AND account_pool_id=?",
            (body.account_id, pool_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, f"账号 {body.account_id} 不存在")
        try:
            notes = json.loads(row["ref_notes"] or "[]")
        except Exception:
            notes = []
        # 去重：同标题不重复添加
        if any(n.get("title") == body.title for n in notes):
            return {"ok": True, "duplicate": True}
        notes.append({
            "title": body.title,
            "body": body.body or "",
            "likes": body.likes,
            "note_url": body.note_url or "",
        })
        conn.execute(
            "UPDATE reference_accounts SET ref_notes=? "
            "WHERE account_id=? AND account_pool_id=?",
            (json.dumps(notes, ensure_ascii=False), body.account_id, pool_id),
        )
        conn.commit()
        return {"ok": True, "count": len(notes)}
    finally:
        conn.close()


@router.delete("/ref-samples/{account_id}/{idx}")
def api_delete_ref_sample(account_id: str, idx: int):
    """从榜样参考库移除指定索引的笔记（仅当前激活账号下的榜样）"""
    pool_id = _active_pool_id()
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT ref_notes FROM reference_accounts "
            "WHERE account_id=? AND account_pool_id=?",
            (account_id, pool_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, f"账号 {account_id} 不存在")
        try:
            notes = json.loads(row["ref_notes"] or "[]")
        except Exception:
            notes = []
        if idx < 0 or idx >= len(notes):
            raise HTTPException(400, "索引超出范围")
        notes.pop(idx)
        conn.execute(
            "UPDATE reference_accounts SET ref_notes=? "
            "WHERE account_id=? AND account_pool_id=?",
            (json.dumps(notes, ensure_ascii=False), account_id, pool_id),
        )
        conn.commit()
        return {"ok": True, "count": len(notes)}
    finally:
        conn.close()


# ─── 选题灵感 ────────────────────────────────────────────────────────────────

@router.get("/inspirations")
def api_get_inspirations():
    """返回选题灵感列表（saved=1）"""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM inspirations WHERE saved=1 ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


class InspirationCreate(BaseModel):
    title: str
    keyword: Optional[str] = None
    source: str = "manual"
    likes_ref: int = 0
    note_ref: Optional[str] = None


@router.post("/inspirations")
def api_add_inspiration(body: InspirationCreate):
    """新增选题灵感"""
    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO inspirations (title, keyword, source, likes_ref, note_ref)
               VALUES (?, ?, ?, ?, ?)""",
            (body.title, body.keyword, body.source, body.likes_ref, body.note_ref),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM inspirations WHERE id=?", (cur.lastrowid,)
        ).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.delete("/inspirations/{inspiration_id}")
def api_delete_inspiration(inspiration_id: int):
    """删除选题灵感（软删除：saved=0）"""
    conn = get_db()
    try:
        conn.execute(
            "UPDATE inspirations SET saved=0 WHERE id=?", (inspiration_id,)
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── 经验库汇总（供 prompt 注入用）────────────────────────────────────────────

def build_knowledge_ctx(conn, account_pool_id: Optional[int] = None) -> dict:
    """
    构建经验库上下文 dict，供 build_draft_prompt 注入。
    直接传入 conn，避免重复建连接。
    account_pool_id：当前激活账号 ID，用于过滤榜样样本（None 时不过滤，向后兼容）。
    """
    # 互动规律（只取 enabled 的）
    all_rules = _compute_rules(conn)
    rules_text = []
    for rule in all_rules:
        row = conn.execute(
            "SELECT enabled FROM prompt_configs WHERE key=?", (rule["key"],)
        ).fetchone()
        if row is None or bool(row["enabled"]):  # 默认启用
            rules_text.append(rule["desc"])

    # 我的高赞样本（use_as_reference=1）
    my_samples = []
    rows = conn.execute(
        """SELECT title, body, likes FROM notes
           WHERE status='published' AND use_as_reference=1
           ORDER BY likes DESC LIMIT 3"""
    ).fetchall()
    for r in rows:
        my_samples.append({
            "title": r["title"] or "",
            "body_preview": (r["body"] or "")[:80].strip(),
            "likes": r["likes"] or 0,
        })

    # 榜样笔记样本（按当前激活账号过滤，取前3条）
    ref_samples = []
    if account_pool_id is not None:
        ref_rows = conn.execute(
            "SELECT name, account_id, ref_notes FROM reference_accounts WHERE account_pool_id=?",
            (account_pool_id,),
        ).fetchall()
    else:
        ref_rows = conn.execute(
            "SELECT name, account_id, ref_notes FROM reference_accounts"
        ).fetchall()
    for r in ref_rows:
        try:
            notes = json.loads(r["ref_notes"] or "[]")
        except Exception:
            notes = []
        for n in notes[:2]:
            ref_samples.append({
                "account": r["name"] or r["account_id"],
                "title": n.get("title", ""),
                "body_preview": (n.get("body") or "")[:80].strip(),
                "likes": n.get("likes", 0),
            })
        if len(ref_samples) >= 3:
            break

    # 选题灵感（最新3条）
    insp_rows = conn.execute(
        "SELECT title, keyword FROM inspirations WHERE saved=1 ORDER BY created_at DESC LIMIT 3"
    ).fetchall()
    inspirations = [r["title"] for r in insp_rows]

    return {
        "rules": rules_text,
        "my_samples": my_samples,
        "ref_samples": ref_samples,
        "inspirations": inspirations,
    }
