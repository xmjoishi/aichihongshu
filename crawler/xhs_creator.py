#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书榜样账号笔记抓取脚本
抓取指定创作者主页的笔记列表，写入 reference_accounts 表
用法（从项目根目录运行）：
    python crawler/xhs_creator.py --url "https://www.xiaohongshu.com/user/profile/<id>?xsec_token=..."
    python crawler/xhs_creator.py --url "..." --name "账号名" --save-db
"""

import sys
import os
import asyncio
import argparse
import json
import csv
from pathlib import Path
from datetime import datetime

MEDIA_CRAWLER_DIR = Path(__file__).parent.parent / "tools" / "MediaCrawler"
sys.path.insert(0, str(MEDIA_CRAWLER_DIR))
os.chdir(MEDIA_CRAWLER_DIR)

PROJECT_ROOT = Path(__file__).parent.parent


def patch_config(creator_url: str):
    import config.base_config as base_cfg
    import config.xhs_config as xhs_cfg

    base_cfg.PLATFORM = "xhs"
    base_cfg.CRAWLER_TYPE = "creator"
    base_cfg.HEADLESS = False
    base_cfg.SAVE_LOGIN_STATE = True
    base_cfg.ENABLE_CDP_MODE = True        # 连接已打开的 Chrome（--remote-debugging-port=9222）
    base_cfg.CDP_DEBUG_PORT = 9222
    base_cfg.CDP_CONNECT_EXISTING = True
    base_cfg.CRAWLER_MAX_NOTES_COUNT = 30
    base_cfg.ENABLE_GET_COMMENTS = False   # 抓账号主页不需要评论
    xhs_cfg.XHS_CREATOR_ID_LIST = [creator_url]


async def run_crawl(creator_url: str) -> tuple[list, dict | None]:
    """运行爬虫，返回 (笔记列表, creator_info 或 None)"""
    patch_config(creator_url)
    # 清空 sys.argv，防止我们脚本的参数被 MediaCrawler 的 typer/click 解析
    _orig_argv = sys.argv[:]
    sys.argv = sys.argv[:1]

    # 捕获 creator 信息：patch store/xhs 的 save_creator
    captured_creator: list = []

    async def _capture_save_creator(user_id: str, creator: dict):
        """拦截 save_creator，捕获原始 userPageData"""
        try:
            user_info = creator.get("basicInfo", {})
            follows = fans = interaction = 0
            for item in creator.get("interactions", []):
                if item.get("type") == "follows":
                    follows = item.get("count", 0)
                elif item.get("type") == "fans":
                    fans = item.get("count", 0)
                elif item.get("type") == "interaction":
                    interaction = item.get("count", 0)

            tags_raw = creator.get("tags", [])
            tags = [t.get("name") for t in tags_raw if t.get("name")]

            captured_creator.append({
                "user_id": user_id,
                "nickname": user_info.get("nickname"),
                "avatar": user_info.get("images"),
                "desc": user_info.get("desc"),
                "ip_location": user_info.get("ipLocation"),
                "gender": user_info.get("gender"),
                "follows": follows,
                "fans": fans,
                "interaction": interaction,
                "tags": tags,
            })
            print(f"[xhs_creator] 已捕获账号主页信息：{user_info.get('nickname')} "
                  f"粉丝 {fans} IP:{user_info.get('ipLocation')}")
        except Exception as e:
            print(f"[xhs_creator] 捕获 creator 信息失败：{e}")
        # 仍然调用原始实现（写入 MediaCrawler DB）
        try:
            import store.xhs as _xhs_store_mod
            await _xhs_store_mod._original_save_creator(user_id, creator)
        except Exception:
            pass

    try:
        import store.xhs as _xhs_store_mod
        _xhs_store_mod._original_save_creator = _xhs_store_mod.save_creator
        _xhs_store_mod.save_creator = _capture_save_creator
        from main import main as mc_main
        await mc_main()
    except (ImportError, ModuleNotFoundError) as e:
        print(f"[xhs_creator] 警告：MediaCrawler 环境不可用（{e}），跳过爬虫，直接读取已缓存的 jsonl 数据")
    except Exception as e:
        print(f"[xhs_creator] 爬虫异常：{e}")
    finally:
        sys.argv = _orig_argv
        # 恢复原始 save_creator
        try:
            import store.xhs as _xhs_store_mod
            if hasattr(_xhs_store_mod, "_original_save_creator"):
                _xhs_store_mod.save_creator = _xhs_store_mod._original_save_creator
                del _xhs_store_mod._original_save_creator
        except Exception:
            pass

    creator_info = captured_creator[0] if captured_creator else None

    # 读取最新的 creator jsonl（MediaCrawler 不输出 CSV，数据存在 jsonl）
    jsonl_dir = MEDIA_CRAWLER_DIR / "data" / "xhs" / "jsonl"
    results = []
    if jsonl_dir.exists():
        jsonl_files = sorted(jsonl_dir.glob("creator_contents_*.jsonl"), key=os.path.getmtime, reverse=True)
        if jsonl_files:
            latest = jsonl_files[0]
            with open(latest, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            results.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
            print(f"[xhs_creator] 读取 {latest.name}，共 {len(results)} 条笔记")
    return results, creator_info


def calc_stats(notes: list) -> dict:
    def safe_int(v):
        try:
            s = str(v).replace(",", "").replace("万", "0000").strip()
            return int(float(s))
        except Exception:
            return 0

    likes = [safe_int(n.get("liked_count") or n.get("likes", 0)) for n in notes]
    comments = [safe_int(n.get("comment_count") or n.get("comments", 0)) for n in notes]
    collects = [safe_int(n.get("collected_count") or n.get("collects", 0)) for n in notes]

    n = len(notes) or 1
    top_notes = sorted(notes, key=lambda x: safe_int(x.get("liked_count", 0)), reverse=True)[:5]
    top_notes_summary = [
        {
            "title": (x.get("title") or x.get("desc") or "")[:50],
            "likes": safe_int(x.get("liked_count", 0)),
            "url": x.get("note_url") or x.get("url", ""),
        }
        for x in top_notes
    ]

    return {
        "note_count": len(notes),
        "avg_likes": round(sum(likes) / n, 1),
        "avg_comments": round(sum(comments) / n, 1),
        "avg_collects": round(sum(collects) / n, 1),
        "total_likes": sum(likes),
        "top_notes": top_notes_summary,
    }


def save_my_profile_crawl_data(creator_info: dict):
    """将爬虫抓取的账号主页数据写入 my_profile 表（更新小红书原始字段）"""
    sys.path.insert(0, str(PROJECT_ROOT))
    try:
        from dotenv import load_dotenv
        load_dotenv(PROJECT_ROOT / ".env")
    except ImportError:
        pass

    from app.db.connection import get_db, init_db
    init_db()

    conn = get_db()
    try:
        tags = creator_info.get("tags", [])
        conn.execute(
            """UPDATE my_profile SET
                display_name = COALESCE(display_name, ?),
                avatar_url   = ?,
                xhs_bio      = ?,
                xhs_follows  = ?,
                followers    = CASE WHEN ? > 0 THEN ? ELSE followers END,
                ip_location  = ?,
                xhs_tags     = ?,
                crawled_at   = datetime('now','localtime'),
                updated_at   = datetime('now','localtime')
               WHERE id = 1
            """,
            (
                creator_info.get("nickname"),        # display_name（仅在未填写时覆盖）
                creator_info.get("avatar"),          # avatar_url
                creator_info.get("desc"),            # xhs_bio
                creator_info.get("follows", 0),      # xhs_follows
                creator_info.get("fans", 0),         # fans > 0 才更新
                creator_info.get("fans", 0),         # followers
                creator_info.get("ip_location"),     # ip_location
                json.dumps(tags, ensure_ascii=False), # xhs_tags
            ),
        )
        conn.commit()
        print(f"[xhs_creator] 账号主页信息已同步到 my_profile："
              f"{creator_info.get('nickname')} 粉丝{creator_info.get('fans', 0)}")
    finally:
        conn.close()



    """把账号数据写入 reference_accounts 表"""
    sys.path.insert(0, str(PROJECT_ROOT))
    # 加载项目根的 .env
    try:
        from dotenv import load_dotenv
        load_dotenv(PROJECT_ROOT / ".env")
    except ImportError:
        pass

    from app.db.connection import get_db, init_db
    init_db()

    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO reference_accounts
               (account_id, name, note_count, avg_likes, avg_comments, avg_collects,
                total_likes, top_notes, raw_data, crawled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
               ON CONFLICT(account_id) DO UPDATE SET
                 name=excluded.name,
                 note_count=excluded.note_count,
                 avg_likes=excluded.avg_likes,
                 avg_comments=excluded.avg_comments,
                 avg_collects=excluded.avg_collects,
                 total_likes=excluded.total_likes,
                 top_notes=excluded.top_notes,
                 raw_data=excluded.raw_data,
                 crawled_at=datetime('now','localtime')
            """,
            (
                account_id,
                name,
                stats["note_count"],
                stats["avg_likes"],
                stats["avg_comments"],
                stats["avg_collects"],
                stats["total_likes"],
                json.dumps(stats["top_notes"], ensure_ascii=False),
                json.dumps(notes[:50], ensure_ascii=False),  # 只存前 50 条原始数据
            ),
        )
        conn.commit()
        print(f"[xhs_creator] 账号数据已写入数据库：{account_id}")
    finally:
        conn.close()


def save_json(notes: list, output_dir: Path, account_id: str):
    output_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_file = output_dir / f"xhs_creator_{account_id}_{ts}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=2)
    print(f"[xhs_creator] 原始数据已保存：{out_file}")
    return out_file


def print_summary(stats: dict, name: str):
    print(f"\n{'='*55}")
    print(f"  账号：{name}")
    print(f"  笔记数：{stats['note_count']}  |  总点赞：{stats['total_likes']}")
    print(f"  平均点赞：{stats['avg_likes']}  "
          f"评论：{stats['avg_comments']}  "
          f"收藏：{stats['avg_collects']}")
    print(f"\n  TOP5 笔记：")
    for i, n in enumerate(stats["top_notes"], 1):
        print(f"    {i}. {n['title']} （赞 {n['likes']}）")
    print(f"{'='*55}\n")


def main():
    parser = argparse.ArgumentParser(description="小红书榜样账号笔记抓取")
    parser.add_argument("--url", required=True, help="创作者主页 URL（含 xsec_token）")
    parser.add_argument("--name", default="", help="账号名称（可选，便于标记）")
    parser.add_argument("--account-id", default="", help="账号 ID（可选，默认从 URL 解析）")
    parser.add_argument("--save-db", action="store_true", help="是否写入数据库")
    parser.add_argument("--output-dir", default="data/crawl", help="原始数据输出目录")
    args = parser.parse_args()

    # 从 URL 解析 account_id
    account_id = args.account_id
    if not account_id:
        import re
        m = re.search(r"/profile/([a-f0-9]+)", args.url)
        account_id = m.group(1) if m else f"account_{datetime.now().strftime('%Y%m%d%H%M%S')}"

    name = args.name or account_id
    output_dir = PROJECT_ROOT / args.output_dir

    print(f"[xhs_creator] 账号：{name} ({account_id})")
    print(f"[xhs_creator] 首次运行需扫码登录\n")

    notes, creator_info = asyncio.run(run_crawl(args.url))
    if not notes:
        print("[xhs_creator] 未获取到数据")
        return

    stats = calc_stats(notes)
    save_json(notes, output_dir, account_id)
    print_summary(stats, name)

    if args.save_db:
        save_to_db(account_id, name, notes, stats)


if __name__ == "__main__":
    main()
