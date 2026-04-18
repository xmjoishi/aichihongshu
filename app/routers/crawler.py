# -*- coding: utf-8 -*-
"""爬虫触发接口"""

import json
import asyncio
from typing import Optional
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/crawler", tags=["crawler"])


class CrawlRequest(BaseModel):
    url: str
    name: Optional[str] = None
    save_db: bool = True


async def _crawl_and_stream(url: str, name: str, save_db: bool):
    """爬取账号数据并以 SSE 推流进度"""
    import re
    from pathlib import Path

    def sse(msg: str, done: bool = False):
        payload = {"message": msg, "done": done}
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    # 解析 account_id
    m = re.search(r"/profile/([a-f0-9]+)", url)
    account_id = m.group(1) if m else url

    yield sse(f"开始读取账号 {account_id} 的数据...")

    try:
        # 从已有 jsonl 读取（不重新触发浏览器爬虫）
        import os, sys
        project_root = Path(__file__).parent.parent.parent
        mc_dir = project_root / "tools" / "MediaCrawler"
        jsonl_dir = mc_dir / "data" / "xhs" / "jsonl"

        notes = []
        if jsonl_dir.exists():
            files = sorted(jsonl_dir.glob("creator_contents_*.jsonl"),
                           key=os.path.getmtime, reverse=True)
            if files:
                with open(files[0], encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                obj = json.loads(line)
                                if obj.get("user_id") == account_id:
                                    notes.append(obj)
                            except Exception:
                                pass
                yield sse(f"读取到 {len(notes)} 条笔记数据")

        if not notes:
            yield sse("未找到该账号的本地缓存数据，请先用爬虫抓取", done=False)
            yield sse("提示：运行 python crawler/xhs_creator.py --url <URL>", done=True)
            return

        yield sse("正在计算统计数据...")

        # 计算统计
        def safe_int(v):
            try:
                return int(float(str(v).replace(",", "").replace("万", "0000")))
            except Exception:
                return 0

        likes = [safe_int(n.get("liked_count", 0)) for n in notes]
        comments = [safe_int(n.get("comment_count", 0)) for n in notes]
        collects = [safe_int(n.get("collected_count", 0)) for n in notes]
        n = len(notes) or 1
        top_notes = sorted(notes, key=lambda x: safe_int(x.get("liked_count", 0)), reverse=True)[:5]

        stats = {
            "note_count": len(notes),
            "avg_likes": round(sum(likes) / n, 1),
            "avg_comments": round(sum(comments) / n, 1),
            "avg_collects": round(sum(collects) / n, 1),
            "total_likes": sum(likes),
            "top_notes": [
                {"title": (x.get("title") or x.get("desc") or "")[:50],
                 "likes": safe_int(x.get("liked_count", 0))}
                for x in top_notes
            ],
        }

        if save_db:
            yield sse("正在写入数据库...")
            sys.path.insert(0, str(project_root))
            from app.db.connection import get_db
            conn = get_db()
            try:
                conn.execute(
                    """INSERT INTO reference_accounts
                       (account_id, name, note_count, avg_likes, avg_comments,
                        avg_collects, total_likes, top_notes, raw_data, crawled_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                       ON CONFLICT(account_id) DO UPDATE SET
                         name=excluded.name, note_count=excluded.note_count,
                         avg_likes=excluded.avg_likes, avg_comments=excluded.avg_comments,
                         avg_collects=excluded.avg_collects, total_likes=excluded.total_likes,
                         top_notes=excluded.top_notes, raw_data=excluded.raw_data,
                         crawled_at=datetime('now','localtime')""",
                    (account_id, name or account_id, stats["note_count"],
                     stats["avg_likes"], stats["avg_comments"], stats["avg_collects"],
                     stats["total_likes"],
                     json.dumps(stats["top_notes"], ensure_ascii=False),
                     json.dumps(notes[:30], ensure_ascii=False)),
                )
                conn.commit()
            finally:
                conn.close()

        yield sse(
            f"完成！共 {stats['note_count']} 条笔记，均赞 {stats['avg_likes']}",
            done=True,
        )

    except Exception as e:
        yield sse(f"错误：{e}", done=True)


@router.post("/creator")
async def api_crawl_creator(body: CrawlRequest):
    """从本地缓存读取创作者数据并写库，SSE 推流进度"""
    return StreamingResponse(
        _crawl_and_stream(body.url, body.name or "", body.save_db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
