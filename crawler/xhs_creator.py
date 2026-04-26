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

# 把 MediaCrawler 自己的 venv site-packages 加入 sys.path，
# 确保 aiofiles 等依赖在项目根 venv 下也能 import
import glob as _glob
_mc_site = _glob.glob(str(MEDIA_CRAWLER_DIR / ".venv" / "lib" / "python3*" / "site-packages"))
for _p in _mc_site:
    if _p not in sys.path:
        sys.path.insert(1, _p)

PROJECT_ROOT = Path(__file__).parent.parent

# v0.2: 多账号 user_data_dir 桥接
sys.path.insert(0, str(PROJECT_ROOT))
from crawler._user_data_dir import resolve_active_user_data_dir, link_to_media_crawler  # noqa: E402

os.chdir(MEDIA_CRAWLER_DIR)


def _is_cdp_port_open(port: int = 9222, timeout: float = 1.0) -> bool:
    """快速检测本地 CDP 端口是否可达（即爬虫浏览器是否已打开）"""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False


def patch_config(creator_url: str):
    import config.base_config as base_cfg
    import config.xhs_config as xhs_cfg
    import config as cfg  # core.py 读的是 config.XXX，必须同时改这个

    base_cfg.PLATFORM = "xhs"
    base_cfg.CRAWLER_TYPE = "creator"
    base_cfg.HEADLESS = False
    base_cfg.SAVE_LOGIN_STATE = True
    base_cfg.CRAWLER_MAX_NOTES_COUNT = 30
    base_cfg.ENABLE_GET_COMMENTS = False
    xhs_cfg.XHS_CREATOR_ID_LIST = [creator_url]

    cfg.PLATFORM = "xhs"
    cfg.CRAWLER_TYPE = "creator"
    cfg.HEADLESS = False
    cfg.SAVE_LOGIN_STATE = True
    cfg.CRAWLER_MAX_NOTES_COUNT = 30
    cfg.ENABLE_GET_COMMENTS = False
    cfg.XHS_CREATOR_ID_LIST = [creator_url]

    # 只有在爬虫浏览器（9222端口）已打开时才启用 CDP 模式；
    # 否则使用 Playwright 内置 Chromium + xhs_user_data_dir（保存登录态，无需重复扫码）
    cdp_available = _is_cdp_port_open(9222)
    base_cfg.ENABLE_CDP_MODE = cdp_available
    base_cfg.CDP_DEBUG_PORT = 9222
    base_cfg.CDP_CONNECT_EXISTING = cdp_available
    cfg.ENABLE_CDP_MODE = cdp_available
    cfg.CDP_DEBUG_PORT = 9222
    cfg.CDP_CONNECT_EXISTING = cdp_available
    if cdp_available:
        print("[xhs_creator] 检测到爬虫浏览器（9222端口），使用 CDP 模式连接")
    else:
        print("[xhs_creator] 爬虫浏览器未开启，使用 Playwright Chromium 模式（首次需扫码，登录态会缓存）")


async def run_crawl(creator_url: str, user_data_dir: Path | None = None) -> tuple[list, dict | None]:
    """运行爬虫，返回 (笔记列表, creator_info 或 None)"""
    # v0.2: 桥接激活账号 user_data_dir（仅 Playwright 模式有效，CDP 模式由用户自己开浏览器）
    active_dir = user_data_dir or resolve_active_user_data_dir()
    link_to_media_crawler(active_dir, platform="xhs")
    print(f"[xhs_creator] 使用账号目录：{active_dir}")

    import re as _re
    m = _re.search(r"/profile/([a-f0-9]+)", creator_url)
    account_id = m.group(1) if m else ""

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
            # DEBUG: 打印原始 interactions，便于排查粉丝数为 0 的问题
            print(f"[xhs_creator][DEBUG] interactions raw: {creator.get('interactions')}")
            def _safe_count(v):
                """将可能是字符串或"1.2万"格式的数字安全转为 int"""
                try:
                    s = str(v).replace(",", "").replace("，", "").strip()
                    if "万" in s:
                        s = s.replace("万", "")
                        return int(float(s) * 10000)
                    return int(float(s))
                except Exception:
                    return 0

            follows = fans = interaction = 0
            for item in creator.get("interactions", []):
                if item.get("type") == "follows":
                    follows = _safe_count(item.get("count", 0))
                elif item.get("type") == "fans":
                    fans = _safe_count(item.get("count", 0))
                elif item.get("type") == "interaction":
                    interaction = _safe_count(item.get("count", 0))

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
        err_str = str(e)
        if "existing browser session" in err_str or "process did exit" in err_str or "has been closed" in err_str:
            print(f"[xhs_creator] ❌ 错误：爬虫浏览器正在运行但 CDP 连接失败。")
            print(f"[xhs_creator] 请确认浏览器是从「设置 → 爬虫浏览器」启动的（需带 --remote-debugging-port=9222），而不是手动打开的。")
            print(f"[xhs_creator] 如已正确启动，请尝试关闭并重新打开爬虫浏览器后再导入。")
        else:
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
    # 注意：URL 里的 profile ID 和小红书实际的 user_id 可能不同（即 account_id ≠ user_id）
    # 优先用爬虫捕获到的真实 user_id 过滤；否则 fallback 到 URL 解析的 account_id
    real_user_id = (creator_info or {}).get("user_id") or account_id
    if real_user_id != account_id:
        print(f"[xhs_creator] 注意：URL 中的 profile ID ({account_id}) 与实际 user_id ({real_user_id}) 不同，使用实际 user_id 读取 jsonl")

    jsonl_dir = MEDIA_CRAWLER_DIR / "data" / "xhs" / "jsonl"
    results = []
    if jsonl_dir.exists():
        jsonl_files = sorted(jsonl_dir.glob("creator_contents_*.jsonl"), key=os.path.getmtime, reverse=True)
        # 遍历所有 jsonl（从最新开始），找属于目标账号的笔记
        for latest in jsonl_files:
            matched = []
            with open(latest, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            obj = json.loads(line)
                            if obj.get("user_id") == real_user_id:
                                matched.append(obj)
                        except json.JSONDecodeError:
                            pass
            if matched:
                results = matched
                print(f"[xhs_creator] 读取 {latest.name}，找到 {len(results)} 条 {real_user_id} 的笔记")
                break
        if not results:
            print(f"[xhs_creator] 未在本地 jsonl 缓存中找到账号 {real_user_id} 的数据")
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
    top_notes = sorted(notes, key=lambda x: safe_int(x.get("liked_count", 0)), reverse=True)
    # 按标题去重，保留每组中点赞最高的（已排好序，第一次出现的即最高）
    seen_titles: set = set()
    deduped = []
    for x in top_notes:
        t = (x.get("title") or x.get("desc") or "").strip()
        if t and t not in seen_titles:
            seen_titles.add(t)
            deduped.append(x)
    top_notes_summary = [
        {
            "title": (x.get("title") or x.get("desc") or "")[:50],
            "likes": safe_int(x.get("liked_count", 0)),
            "url": x.get("note_url") or x.get("url", ""),
        }
        for x in deduped[:5]
    ]

    return {
        "note_count": len(notes),
        "avg_likes": round(sum(likes) / n, 1),
        "avg_comments": round(sum(comments) / n, 1),
        "avg_collects": round(sum(collects) / n, 1),
        "total_likes": sum(likes),
        "total_collects": sum(collects),
        "top_notes": top_notes_summary,
    }


def save_my_profile_crawl_data(creator_info: dict, notes: list | None = None, account_pool_id: int | None = None):
    """将爬虫抓取的账号主页数据写入 my_profile 表，并可选同步笔记数据到 notes 表

    account_pool_id：v0.3 多账号隔离。未指定时，回退到当前激活账号；都没有则报错。
    """
    sys.path.insert(0, str(PROJECT_ROOT))
    try:
        from dotenv import load_dotenv
        load_dotenv(PROJECT_ROOT / ".env")
    except ImportError:
        pass

    from app.db.connection import get_db, init_db
    init_db()

    if account_pool_id is None:
        from app.services import account_pool as _ap
        account_pool_id = _ap.get_active_id()
        if account_pool_id is None:
            raise RuntimeError("尚未激活运营账号，请先在 GUI 顶栏激活")

    conn = get_db()
    try:
        tags = creator_info.get("tags", [])
        nickname = creator_info.get("nickname") or ""

        # display_name：如果当前值是 account_id（未设置真实名字）则用昵称覆盖
        current = conn.execute(
            "SELECT account_id, display_name FROM my_profile WHERE account_pool_id=?",
            (account_pool_id,),
        ).fetchone()
        if current:
            cur_account_id = current["account_id"] or ""
            cur_display = current["display_name"] or ""
            # 若 display_name 为空或与 account_id 相同，则用爬到的昵称
            use_nickname = (not cur_display) or (cur_display == cur_account_id)
        else:
            use_nickname = True

        conn.execute(
            """UPDATE my_profile SET
                display_name = CASE WHEN ? THEN ? ELSE display_name END,
                avatar_url   = ?,
                xhs_bio      = ?,
                xhs_follows  = ?,
                followers    = CASE WHEN ? > 0 THEN ? ELSE followers END,
                ip_location  = ?,
                xhs_tags     = ?,
                crawled_at   = datetime('now','localtime'),
                updated_at   = datetime('now','localtime')
               WHERE account_pool_id = ?
            """,
            (
                1 if use_nickname else 0,
                nickname,                                # display_name
                creator_info.get("avatar"),              # avatar_url
                creator_info.get("desc"),                # xhs_bio
                creator_info.get("follows", 0),          # xhs_follows
                creator_info.get("fans", 0),             # fans > 0 才更新
                creator_info.get("fans", 0),             # followers
                creator_info.get("ip_location"),         # ip_location
                json.dumps(tags, ensure_ascii=False),    # xhs_tags
                account_pool_id,
            ),
        )
        conn.commit()
        print(f"[xhs_creator] 账号主页信息已同步到 my_profile："
              f"{nickname} 粉丝{creator_info.get('fans', 0)}")

        # 同步笔记数据到 notes 表，并缓存统计数据
        if notes:
            _sync_notes_to_db(conn, notes, creator_info, account_pool_id=account_pool_id)
            stats = _calc_notes_stats(notes)
            conn.execute(
                """UPDATE my_profile SET
                    total_notes    = ?,
                    total_likes    = ?,
                    total_collects = ?,
                    avg_likes      = ?,
                    avg_comments   = ?,
                    avg_collects   = ?,
                    updated_at     = datetime('now','localtime')
                   WHERE account_pool_id = ?
                """,
                (
                    stats["note_count"],
                    stats["total_likes"],
                    stats["total_collects"],
                    stats["avg_likes"],
                    stats["avg_comments"],
                    stats["avg_collects"],
                    account_pool_id,
                ),
            )
            conn.commit()
            print(f"[xhs_creator] 笔记统计已缓存：总获赞 {stats['total_likes']} 总收藏 {stats['total_collects']}")

    finally:
        conn.close()


def _sync_notes_to_db(conn, notes: list, creator_info: dict, account_pool_id: int | None = None):
    """将爬虫抓取的笔记 upsert 到 notes 表（按 note_url 去重，status='published'）"""
    def safe_int(v):
        try:
            return int(str(v).replace(",", "").replace("万", "0000").strip())
        except Exception:
            return 0

    synced = 0
    for n in notes:
        note_url = n.get("note_url") or n.get("url") or ""
        if not note_url:
            continue
        title = (n.get("title") or n.get("desc") or "")[:200]
        body = n.get("desc") or ""
        likes = safe_int(n.get("liked_count", 0))
        comments = safe_int(n.get("comment_count", 0))
        collects = safe_int(n.get("collected_count", 0))
        tag_list = n.get("tag_list") or ""
        tags = [t.strip() for t in tag_list.split(",") if t.strip()] if tag_list else []
        # 发布时间（毫秒时间戳 → ISO 字符串）
        ts = n.get("time") or n.get("last_update_time")
        published_at = None
        if ts:
            try:
                from datetime import datetime as _dt
                published_at = _dt.fromtimestamp(int(ts) / 1000).strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass

        # 检查是否已存在（按 note_url）
        existing = conn.execute(
            "SELECT id FROM notes WHERE note_url=?", (note_url,)
        ).fetchone()

        if existing:
            # 更新互动数据（不覆盖用户手动编辑的 title/body/tags）
            conn.execute(
                """UPDATE notes SET likes=?, comments=?, collects=?,
                   published_at=COALESCE(published_at, ?),
                   updated_at=datetime('now','localtime')
                   WHERE note_url=?""",
                (likes, comments, collects, published_at, note_url),
            )
        else:
            # 新插入
            conn.execute(
                """INSERT INTO notes
                   (title, body, tags, status, note_url, likes, comments, collects,
                    published_at, account_pool_id, created_at, updated_at)
                   VALUES (?, ?, ?, 'published', ?, ?, ?, ?,
                           ?, ?, datetime('now','localtime'), datetime('now','localtime'))""",
                (
                    title, body,
                    json.dumps(tags, ensure_ascii=False),
                    note_url, likes, comments, collects, published_at,
                    account_pool_id,
                ),
            )
        synced += 1

    conn.commit()
    print(f"[xhs_creator] 已同步 {synced} 条笔记到 notes 表")



def save_to_db(account_id: str, name: str, notes: list, stats: dict, account_pool_id: int | None = None):
    """把账号数据写入 reference_accounts 表（按 account_pool_id 隔离）

    account_pool_id：v0.3 多账号隔离。未指定时回退到当前激活的运营账号。
    """
    sys.path.insert(0, str(PROJECT_ROOT))
    # 加载项目根的 .env
    try:
        from dotenv import load_dotenv
        load_dotenv(PROJECT_ROOT / ".env")
    except ImportError:
        pass

    from app.db.connection import get_db, init_db
    init_db()

    if account_pool_id is None:
        from app.services import account_pool as _ap
        account_pool_id = _ap.get_active_id()
        if account_pool_id is None:
            raise RuntimeError("未指定 account_pool_id 且无激活账号")

    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO reference_accounts
               (account_pool_id, account_id, name, note_count, avg_likes, avg_comments, avg_collects,
                total_likes, top_notes, raw_data, crawled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
               ON CONFLICT(account_pool_id, account_id) DO UPDATE SET
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
                account_pool_id,
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
        print(f"[xhs_creator] 账号数据已写入数据库：{account_id}（pool_id={account_pool_id}）")
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
    parser.add_argument("--my-profile", action="store_true", help="将爬取结果同步到 my_profile 表（用于刷新我的账号数据）")
    parser.add_argument("--output-dir", default="data/crawl", help="原始数据输出目录")
    parser.add_argument("--user-data-dir", default=None,
                        help="浏览器 user_data_dir（v0.2 多账号），默认读激活账号")
    parser.add_argument("--account-pool-id", type=int, default=None,
                        help="v0.3 多账号隔离：指定将抓取结果写入哪个账号的 my_profile，默认读激活账号")
    args = parser.parse_args()

    # 从 URL 解析 account_id
    account_id = args.account_id
    if not account_id:
        import re
        m = re.search(r"/profile/([a-f0-9]+)", args.url)
        account_id = m.group(1) if m else f"account_{datetime.now().strftime('%Y%m%d%H%M%S')}"

    output_dir = PROJECT_ROOT / args.output_dir

    print(f"[xhs_creator] 账号：{args.name or account_id} ({account_id})")
    print(f"[xhs_creator] 首次运行需扫码登录\n")

    notes, creator_info = asyncio.run(run_crawl(
        args.url,
        user_data_dir=Path(args.user_data_dir) if args.user_data_dir else None,
    ))
    if not notes and not creator_info:
        print("[xhs_creator] 未获取到数据")
        return

    # 优先用爬虫抓到的真实 user_id 作为 account_id（URL 里的 profile ID 可能不同）
    real_user_id = (creator_info or {}).get("user_id") or ""
    if real_user_id and real_user_id != account_id:
        print(f"[xhs_creator] 使用真实 user_id ({real_user_id}) 替换 URL 解析的 ID ({account_id})")
        account_id = real_user_id

    # 优先用爬虫抓到的 nickname，其次用 --name，最后 fallback 到 account_id
    crawled_nickname = (creator_info or {}).get("nickname") or ""
    name = args.name or crawled_nickname or account_id

    if notes:
        stats = calc_stats(notes)
        save_json(notes, output_dir, account_id)
        print_summary(stats, name)

        if args.save_db:
            save_to_db(account_id, name, notes, stats, account_pool_id=args.account_pool_id)
            # 输出结构化结果，供 FastAPI 子进程解析（无论 --my-profile 与否都输出）
            result = {"account_id": account_id, "nickname": name}
            if creator_info:
                result.update(creator_info)
            print(f"RESULT_JSON:{json.dumps(result, ensure_ascii=False)}")

    if args.my_profile:
        if creator_info:
            save_my_profile_crawl_data(creator_info, notes=notes or [], account_pool_id=args.account_pool_id)
            # 若 --save-db 已输出过 RESULT_JSON，不重复输出
            if not args.save_db:
                print(f"RESULT_JSON:{json.dumps(creator_info, ensure_ascii=False)}")
        else:
            print("[xhs_creator] 未捕获到账号主页信息，无法同步 my_profile")
            if not args.save_db:
                print("RESULT_JSON:null")


if __name__ == "__main__":
    main()
