#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书关键词搜索抓取脚本
用途：抓取指定关键词的高互动笔记，供首页推荐流分析使用
用法：
    cd <项目根目录>
    python crawler/xhs_search.py --keywords "家居,软装,装修" --count 20
"""

import sys
import os
import asyncio
import argparse
import json
import csv
from pathlib import Path
from datetime import datetime

# 把 MediaCrawler 加入 sys.path
PROJECT_ROOT = Path(__file__).parent.parent
MEDIA_CRAWLER_DIR = PROJECT_ROOT / "tools" / "MediaCrawler"
sys.path.insert(0, str(MEDIA_CRAWLER_DIR))

# v0.2: 多账号 user_data_dir 桥接
sys.path.insert(0, str(PROJECT_ROOT))
from crawler._user_data_dir import resolve_active_user_data_dir, link_to_media_crawler  # noqa: E402

# 覆盖 MediaCrawler 配置
os.chdir(MEDIA_CRAWLER_DIR)  # MediaCrawler 需要从自身目录运行


def patch_config(keywords: str, max_count: int, headless: bool):
    """动态覆盖 MediaCrawler 配置"""
    import config.base_config as base_cfg
    import config.xhs_config as xhs_cfg

    base_cfg.PLATFORM = "xhs"
    base_cfg.KEYWORDS = keywords
    base_cfg.CRAWLER_TYPE = "search"
    base_cfg.HEADLESS = headless
    base_cfg.SAVE_LOGIN_STATE = True
    base_cfg.ENABLE_CDP_MODE = False  # 默认用 Playwright 模式，扫码登录
    xhs_cfg.SORT_TYPE = "popularity_descending"  # 按热度降序

    # 控制抓取数量
    import constant.base_constant as base_const
    if hasattr(base_const, "MAX_SCROLL_COUNT"):
        # 每页约 20 条，换算成滚动次数
        base_const.MAX_SCROLL_COUNT = max(1, max_count // 20)


async def run_crawl(keywords: str, max_count: int, headless: bool, output_dir: Path,
                    user_data_dir: Path | None = None):
    # v0.2: 桥接激活账号 user_data_dir
    active_dir = user_data_dir or resolve_active_user_data_dir()
    link_to_media_crawler(active_dir, platform="xhs")
    print(f"[xhs_search] 使用账号目录：{active_dir}")

    patch_config(keywords, max_count, headless)

    from main import main as mc_main
    await mc_main()

    # MediaCrawler 默认输出到 data/ 目录（CSV/JSON）
    data_dir = MEDIA_CRAWLER_DIR / "data" / "xhs"
    results = []

    if data_dir.exists():
        for csv_file in sorted(data_dir.glob("*.csv"), key=os.path.getmtime, reverse=True)[:1]:
            with open(csv_file, encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    results.append(row)
            print(f"[xhs_search] 读取数据文件：{csv_file.name}，共 {len(results)} 条")

    return results


def save_results(results: list, output_dir: Path, keywords: str):
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_kw = keywords.replace(",", "_").replace(" ", "")[:30]
    out_file = output_dir / f"xhs_search_{safe_kw}_{timestamp}.json"

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"[xhs_search] 结果已保存到：{out_file}")
    return out_file


def print_summary(results: list):
    """打印简要摘要供分析使用"""
    print("\n" + "=" * 60)
    print(f"抓取完成，共 {len(results)} 条笔记")
    print("=" * 60)

    # 尝试输出前 10 条关键字段
    key_fields = ["title", "desc", "liked_count", "comment_count", "collected_count", "tag_list", "note_url"]
    for i, item in enumerate(results[:10], 1):
        print(f"\n【{i}】{item.get('title') or item.get('desc', '')[:40]}")
        print(f"    点赞：{item.get('liked_count', '-')}  "
              f"评论：{item.get('comment_count', '-')}  "
              f"收藏：{item.get('collected_count', '-')}")
        tags = item.get("tag_list", "")
        if tags:
            print(f"    话题：{str(tags)[:80]}")


def main():
    parser = argparse.ArgumentParser(description="小红书关键词搜索抓取")
    parser.add_argument("--keywords", default="家居,软装,装修", help="搜索关键词，英文逗号分隔")
    parser.add_argument("--count", type=int, default=20, help="目标抓取数量（约数）")
    parser.add_argument("--headless", action="store_true", help="无头模式（不弹浏览器窗口）")
    parser.add_argument("--output-dir", default="data/crawl", help="结果输出目录（相对项目根目录）")
    parser.add_argument("--user-data-dir", default=None,
                        help="浏览器 user_data_dir 路径（v0.2 多账号），默认读激活账号")
    args = parser.parse_args()

    # 输出目录相对项目根
    project_root = Path(__file__).parent.parent
    output_dir = project_root / args.output_dir
    user_data_dir = Path(args.user_data_dir) if args.user_data_dir else None

    print(f"[xhs_search] 关键词：{args.keywords}")
    print(f"[xhs_search] 目标数量：{args.count}")
    print(f"[xhs_search] 输出目录：{output_dir}")
    print(f"[xhs_search] 首次运行需扫码登录小红书（登录态会缓存，后续无需重复）\n")

    results = asyncio.run(run_crawl(args.keywords, args.count, args.headless, output_dir,
                                     user_data_dir=user_data_dir))

    if results:
        save_results(results, output_dir, args.keywords)
        print_summary(results)
    else:
        print("[xhs_search] 未获取到数据，请检查登录态或网络")


if __name__ == "__main__":
    main()
