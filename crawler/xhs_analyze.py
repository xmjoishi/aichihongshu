#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书数据分析脚本
读取 crawler/xhs_search.py 抓取的 JSON 数据，
按首页推荐流分析框架（references/xhs-home-feed-analysis.md）输出结构化报告
用法：
    python crawler/xhs_analyze.py --input data/crawl/xhs_search_xxx.json
"""

import json
import argparse
import sys
from pathlib import Path
from datetime import datetime


def load_data(input_path: str) -> list:
    with open(input_path, encoding="utf-8") as f:
        return json.load(f)


def parse_int(val) -> int:
    """安全转换互动数字（可能带「万」）"""
    if not val:
        return 0
    s = str(val).replace(",", "").strip()
    if s.endswith("万"):
        try:
            return int(float(s[:-1]) * 10000)
        except ValueError:
            return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def enrich(items: list) -> list:
    """补充计算字段"""
    for item in items:
        item["_likes"] = parse_int(item.get("liked_count") or item.get("likes", 0))
        item["_comments"] = parse_int(item.get("comment_count") or item.get("comments", 0))
        item["_collects"] = parse_int(item.get("collected_count") or item.get("collects", 0))
        item["_score"] = item["_likes"] + item["_comments"] * 3 + item["_collects"] * 2
        title = item.get("title") or item.get("desc") or ""
        item["_title"] = title[:60]
    return items


def top_items(items: list, n=10) -> list:
    return sorted(items, key=lambda x: x["_score"], reverse=True)[:n]


def extract_hooks(title: str) -> list:
    """粗提取标题中的常见钩子词"""
    hooks = []
    patterns = [
        "为什么", "我发现", "别再", "不要", "到底", "真的",
        "！", "？", "被", "惊", "太", "超", "千万", "必看",
        "分享", "攻略", "踩坑", "避坑", "好物", "种草",
        "测评", "合集", "干货", "教程", "改造", "装修",
    ]
    for p in patterns:
        if p in title:
            hooks.append(p)
    return hooks


def analyze(items: list) -> dict:
    items = enrich(items)
    top = top_items(items, 10)

    # 统计高频钩子词
    hook_counter: dict = {}
    for item in items:
        for h in extract_hooks(item["_title"]):
            hook_counter[h] = hook_counter.get(h, 0) + 1
    top_hooks = sorted(hook_counter.items(), key=lambda x: x[1], reverse=True)[:8]

    # 统计平均互动
    if items:
        avg_likes = sum(i["_likes"] for i in items) / len(items)
        avg_comments = sum(i["_comments"] for i in items) / len(items)
        avg_collects = sum(i["_collects"] for i in items) / len(items)
    else:
        avg_likes = avg_comments = avg_collects = 0

    return {
        "total": len(items),
        "avg_likes": round(avg_likes),
        "avg_comments": round(avg_comments),
        "avg_collects": round(avg_collects),
        "top_hooks": top_hooks,
        "top_items": top,
    }


def print_report(result: dict, keywords: str):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    sep = "=" * 60

    print(f"\n{sep}")
    print(f"  小红书首页推荐流分析报告")
    print(f"  关键词：{keywords}  |  生成时间：{now}")
    print(sep)

    print(f"\n【数据概览】共 {result['total']} 条笔记")
    print(f"  平均点赞：{result['avg_likes']}  "
          f"平均评论：{result['avg_comments']}  "
          f"平均收藏：{result['avg_collects']}")

    print(f"\n【高频钩子词 TOP8】（出现在标题中的停留触发词）")
    for word, cnt in result["top_hooks"]:
        bar = "▇" * cnt
        print(f"  {word:8s}  {bar} ({cnt})")

    print(f"\n【高互动样本 TOP10】（综合得分 = 点赞 + 评论×3 + 收藏×2）")
    for i, item in enumerate(result["top_items"], 1):
        print(f"\n  {i:2d}. {item['_title']}")
        print(f"      点赞 {item['_likes']:>6}  评论 {item['_comments']:>5}  收藏 {item['_collects']:>6}  得分 {item['_score']:>7}")
        tags = item.get("tag_list", "")
        if tags:
            print(f"      话题：{str(tags)[:70]}")

    print(f"\n{sep}")
    print("【可复用模式推断】")
    hooks = [h for h, _ in result["top_hooks"][:5]]
    if hooks:
        print(f"  高频钩子：{'  '.join(hooks)}")
    print("  建议优先复用：情绪词 + 具体场景的标题结构")
    print("  下步动作：从 TOP10 中选 3 条，提炼标题句式做 A/B 测试")
    print(sep)


def save_report(result: dict, keywords: str, output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_kw = keywords.replace(",", "_")[:30]
    out_file = output_dir / f"analysis_{safe_kw}_{timestamp}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        # top_items 中可能有不可序列化字段，过滤一下
        clean = {k: v for k, v in result.items() if k != "top_items"}
        clean["top_items"] = [
            {fk: fv for fk, fv in item.items() if not fk.startswith("_") or fk in ("_title", "_likes", "_comments", "_collects", "_score")}
            for item in result["top_items"]
        ]
        json.dump(clean, f, ensure_ascii=False, indent=2)
    print(f"\n[xhs_analyze] 分析结果已保存到：{out_file}")


def save_to_db(result: dict, keywords: str, source_file: str, project_root: Path):
    """将抓取记录写入 crawl_logs 表"""
    sys.path.insert(0, str(project_root))
    try:
        from dotenv import load_dotenv
        load_dotenv(project_root / ".env")
    except ImportError:
        pass
    from app.db.connection import get_db, init_db
    init_db()
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO crawl_logs (keywords, count, source_file) VALUES (?, ?, ?)",
            (keywords, result["total"], source_file),
        )
        conn.commit()
        print(f"[xhs_analyze] 抓取记录已写入数据库（crawl_logs）")
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="小红书笔记数据分析")
    parser.add_argument("--input", required=True, help="xhs_search.py 输出的 JSON 文件路径")
    parser.add_argument("--keywords", default="家居,软装,装修", help="关键词（仅用于报告标题）")
    parser.add_argument("--output-dir", default="data/analysis", help="分析报告输出目录")
    parser.add_argument("--save-db", action="store_true", help="是否将抓取记录写入数据库")
    args = parser.parse_args()

    project_root = Path(__file__).parent.parent
    output_dir = project_root / args.output_dir

    items = load_data(args.input)
    if not items:
        print("[xhs_analyze] 数据为空，请检查输入文件")
        sys.exit(1)

    result = analyze(items)
    print_report(result, args.keywords)
    save_report(result, args.keywords, output_dir)

    if args.save_db:
        save_to_db(result, args.keywords, args.input, project_root)


if __name__ == "__main__":
    main()
