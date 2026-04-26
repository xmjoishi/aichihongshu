#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
爱吃红薯（AI吃红书） 运营助手 CLI
用法：python app/cli.py --help
"""

import json
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table
from rich import box

console = Console()


def _active_pool_id() -> int:
    """获取当前激活账号 id；未激活则报错退出。"""
    from app.services import account_pool

    aid = account_pool.get_active_id()
    if aid is None:
        console.print("[red]错误：尚未激活运营账号[/red]")
        console.print("[dim]请先在 GUI 顶栏激活，或运行 SQL：UPDATE account_pool SET is_active=1 WHERE id=1[/dim]")
        sys.exit(1)
    return aid


# ──────────────────────────────────────────────
# 根命令
# ──────────────────────────────────────────────

@click.group()
def cli():
    """爱吃红薯（AI吃红书） v0.1 · 小红书家居垂类运营助手"""
    pass


# ──────────────────────────────────────────────
# db 子命令组
# ──────────────────────────────────────────────

@cli.group()
def db():
    """数据库管理"""
    pass


@db.command("init")
def db_init():
    """初始化数据库（建表）"""
    from app.db.connection import init_db
    init_db()
    console.print("[green]✓[/green] 数据库初始化完成")


# ──────────────────────────────────────────────
# library 子命令组
# ──────────────────────────────────────────────

@cli.group()
def library():
    """图库管理"""
    pass


@library.command("add")
@click.argument("image_path", type=click.Path(exists=True))
@click.option("--title", "-t", default=None, help="物品名称")
@click.option("--analyze/--no-analyze", default=True, help="是否调用 MiniMax 分析（默认开启）")
def library_add(image_path, title, analyze):
    """添加图片到图库"""
    from app.db.connection import init_db
    from app.modules.library.manager import add_item
    from app.modules.library.analyzer import analyze_image

    init_db()

    analysis = None
    if analyze:
        console.print(f"[cyan]正在分析图片...[/cyan] {image_path}")
        try:
            analysis = analyze_image(image_path)
            console.print(f"[green]✓[/green] 分析完成：{analysis.get('title', '')} / {analysis.get('style', '')}")
        except Exception as e:
            console.print(f"[yellow]⚠ MiniMax 分析失败（{e}），将跳过分析直接入库[/yellow]")

    item = add_item(image_path=image_path, title=title, analysis=analysis, account_pool_id=_active_pool_id())
    console.print(f"[green]✓[/green] 已添加物品 ID={item.id}：{item.title}")
    _print_item_detail(item)


@library.command("list")
@click.option("--tag", "-g", default=None, help="按标签筛选")
@click.option("--style", "-s", default=None, help="按风格筛选")
def library_list(tag, style):
    """列出图库物品"""
    from app.modules.library.manager import list_items
    items = list_items(tag=tag, style=style, account_pool_id=_active_pool_id())

    if not items:
        console.print("[dim]图库为空[/dim]")
        return

    table = Table(box=box.SIMPLE, show_header=True, header_style="bold cyan")
    table.add_column("ID", width=4)
    table.add_column("名称", width=18)
    table.add_column("风格", width=12)
    table.add_column("材质", width=10)
    table.add_column("场景", width=10)
    table.add_column("标签", width=30)
    table.add_column("笔记数", width=5)

    for item in items:
        table.add_row(
            str(item.id),
            item.title,
            item.style or "—",
            item.material or "—",
            item.scene or "—",
            item.tags_str() or "—",
            str(item.note_count),
        )
    console.print(table)
    console.print(f"[dim]共 {len(items)} 件[/dim]")


@library.command("show")
@click.argument("item_id", type=int)
def library_show(item_id):
    """查看物品详情"""
    from app.modules.library.manager import get_item
    item = get_item(item_id, account_pool_id=_active_pool_id())
    if not item:
        console.print(f"[red]物品 ID {item_id} 不存在[/red]")
        sys.exit(1)
    _print_item_detail(item)


@library.command("tag")
@click.argument("item_id", type=int)
@click.option("--add", "add_tag", default=None, help="添加标签")
@click.option("--remove", "remove_tag", default=None, help="删除标签")
def library_tag(item_id, add_tag, remove_tag):
    """管理物品标签"""
    from app.modules.library.manager import add_tag as _add, remove_tag as _remove
    if add_tag:
        item = _add(item_id, add_tag, account_pool_id=_active_pool_id())
        console.print(f"[green]✓[/green] 已添加标签「{add_tag}」→ {item.tags_str()}")
    if remove_tag:
        item = _remove(item_id, remove_tag, account_pool_id=_active_pool_id())
        console.print(f"[green]✓[/green] 已删除标签「{remove_tag}」→ {item.tags_str()}")


@library.command("delete")
@click.argument("item_id", type=int)
@click.option("--delete-file", is_flag=True, help="同时删除图片文件")
@click.confirmation_option(prompt="确认删除？")
def library_delete(item_id, delete_file):
    """删除图库物品"""
    from app.modules.library.manager import delete_item
    ok = delete_item(item_id, delete_file=delete_file, account_pool_id=_active_pool_id())
    if ok:
        console.print(f"[green]✓[/green] 已删除物品 ID={item_id}")
    else:
        console.print(f"[red]物品 ID {item_id} 不存在[/red]")


def _print_item_detail(item):
    """打印物品详情"""
    analysis = {}
    if item.analysis_raw:
        try:
            analysis = json.loads(item.analysis_raw)
        except Exception:
            pass

    console.print(f"\n[bold]#{item.id} {item.title}[/bold]")
    console.print(f"  图片：{item.image_path}")
    console.print(f"  风格：{item.style or '—'}  材质：{item.material or '—'}  颜色：{item.color or '—'}")
    console.print(f"  场景：{item.scene or '—'}")
    console.print(f"  标签：{item.tags_str() or '—'}")

    selling_points = analysis.get("xhs_selling_points", [])
    if selling_points:
        console.print(f"  卖点：{' / '.join(selling_points)}")

    pairing = analysis.get("pairing_suggestions", "")
    if pairing:
        console.print(f"  搭配：{pairing}")
    console.print()


# ──────────────────────────────────────────────
# content 子命令组
# ──────────────────────────────────────────────

@cli.group()
def content():
    """内容创作"""
    pass


@content.command("draft")
@click.argument("item_id", type=int)
@click.option("--account-id", "-a", default=None, help="参考榜样账号 account_id")
@click.option("--extra", "-e", default="", help="额外创作要求")
@click.option("--save", is_flag=True, help="将 prompt 保存到数据库（创建草稿记录）")
def content_draft(item_id, account_id, extra, save):
    """为指定物品生成笔记创作 Prompt（交给 Agent 生成内容）"""
    from app.modules.library.manager import get_item
    from app.modules.content.prompt_builder import build_draft_prompt
    from app.modules.content.manager import create_note

    item = get_item(item_id, account_pool_id=_active_pool_id())
    if not item:
        console.print(f"[red]物品 ID {item_id} 不存在[/red]")
        sys.exit(1)

    # 读取我的账号人设
    my_profile = None
    from app.db.connection import get_db as _get_db
    pool_id = _active_pool_id()
    _conn = _get_db()
    _row = _conn.execute("SELECT * FROM my_profile WHERE account_pool_id=?", (pool_id,)).fetchone()
    _conn.close()
    if _row:
        my_profile = dict(_row)
        console.print(f"[dim]人设：{_row['persona_name'] or _row['display_name']}（{_row['niche']}）[/dim]")
    else:
        console.print("[yellow]⚠ 未初始化账号人设，使用默认风格。运行 profile init 先设定人设。[/yellow]")

    reference = None
    if account_id:
        from app.db.connection import get_db
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM reference_accounts WHERE account_id=?", (account_id,)
        ).fetchone()
        conn.close()
        if row:
            from app.models.item import ReferenceAccount
            reference = ReferenceAccount(**dict(row))
            console.print(f"[dim]参考账号：{reference.name or account_id}[/dim]")
        else:
            console.print(f"[yellow]⚠ 账号 {account_id} 不在数据库中，将使用默认风格[/yellow]")

    prompt = build_draft_prompt(item=item, reference=reference, my_profile=my_profile, extra_instructions=extra)

    console.print("\n" + "─" * 60)
    console.print("[bold cyan]📝 笔记创作 Prompt（复制给 Agent 生成内容）[/bold cyan]")
    console.print("─" * 60)
    console.print(prompt)
    console.print("─" * 60 + "\n")

    if save:
        note = create_note(
            item_id=item_id,
            account_ref=account_id,
            prompt_used=prompt,
            account_pool_id=pool_id,
        )
        console.print(f"[green]✓[/green] 草稿记录已创建 ID={note.id}（status=draft，等待填入内容）")
        console.print(f"[dim]填入内容后执行：python app/cli.py content edit {note.id}[/dim]")


@content.command("topic")
@click.option("--account-id", "-a", default=None, help="参考榜样账号 account_id")
@click.option("--analysis-file", "-f", default=None, help="xhs_analyze.py 输出的分析 JSON 文件（提供平台热信号）")
@click.option("--extra", "-e", default="", help="额外要求")
@click.option("--item-ids", "-i", default=None, help="指定图库物品 ID，逗号分隔；不指定则取全部")
def content_topic(account_id, analysis_file, extra, item_ids):
    """基于图库 + 爬虫数据生成选题 Prompt（skill xhs-topic-ideation 框架）"""
    import json as _json
    from app.modules.library.manager import list_items, get_item
    from app.modules.content.prompt_builder import build_topic_prompt

    # 获取物品列表
    pool_id = _active_pool_id()
    if item_ids:
        ids = [int(x.strip()) for x in item_ids.split(",") if x.strip()]
        items = [get_item(i, account_pool_id=pool_id) for i in ids]
        items = [x for x in items if x]
    else:
        items = list_items(account_pool_id=pool_id)

    if not items:
        console.print("[yellow]⚠ 图库为空，先用 library add 导入物品[/yellow]")
        return

    titles = [f"{item.title}（{item.style or ''}·{item.scene or ''}）" for item in items]

    # 读取爬虫分析摘要
    crawl_summary = ""
    if analysis_file:
        try:
            with open(analysis_file, encoding="utf-8") as f:
                data = _json.load(f)
            hooks = data.get("top_hooks", [])[:5]
            top = data.get("top_items", [])[:3]
            crawl_summary = "高频钩子词：" + "  ".join(f"{w}({c})" for w, c in hooks)
            if top:
                crawl_summary += "\nTOP笔记标题：\n" + "\n".join(
                    f"  - {x.get('_title') or x.get('title', '')}" for x in top
                )
        except Exception as e:
            console.print(f"[yellow]⚠ 读取分析文件失败：{e}[/yellow]")

    # 读取榜样账号
    reference = None
    if account_id:
        from app.db.connection import get_db
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM reference_accounts WHERE account_id=?", (account_id,)
        ).fetchone()
        conn.close()
        if row:
            from app.models.item import ReferenceAccount
            reference = ReferenceAccount(**dict(row))
            console.print(f"[dim]参考账号：{reference.name or account_id}[/dim]")

    prompt = build_topic_prompt(
        item_titles=titles,
        reference=reference,
        crawl_analysis_summary=crawl_summary,
        extra_instructions=extra,
    )

    console.print("\n" + "─" * 60)
    console.print("[bold cyan]🗂  选题生成 Prompt（复制给 Agent 生成选题清单）[/bold cyan]")
    console.print("─" * 60)
    console.print(prompt)
    console.print("─" * 60 + "\n")


@content.command("list")
@click.option("--status", "-s", default=None, help="按状态筛选：draft / ready / published")
@click.option("--item-id", "-i", default=None, type=int, help="按物品 ID 筛选")
def content_list(status, item_id):
    """列出笔记草稿"""
    from app.modules.content.manager import list_notes
    notes = list_notes(status=status, item_id=item_id, account_pool_id=_active_pool_id())

    if not notes:
        console.print("[dim]暂无笔记[/dim]")
        return

    table = Table(box=box.SIMPLE, show_header=True, header_style="bold cyan")
    table.add_column("ID", width=4)
    table.add_column("标题", width=30)
    table.add_column("物品ID", width=6)
    table.add_column("状态", width=10)
    table.add_column("话题", width=25)
    table.add_column("创建时间", width=18)

    status_color = {"draft": "yellow", "ready": "cyan", "published": "green"}
    for note in notes:
        sc = status_color.get(note.status, "white")
        table.add_row(
            str(note.id),
            (note.title or "（未填标题）")[:30],
            str(note.item_id or "—"),
            f"[{sc}]{note.status}[/{sc}]",
            note.tags_str()[:25] or "—",
            (note.created_at or "")[:16],
        )
    console.print(table)
    console.print(f"[dim]共 {len(notes)} 条[/dim]")


@content.command("show")
@click.argument("note_id", type=int)
def content_show(note_id):
    """查看笔记详情"""
    from app.modules.content.manager import get_note
    note = get_note(note_id, account_pool_id=_active_pool_id())
    if not note:
        console.print(f"[red]笔记 ID {note_id} 不存在[/red]")
        sys.exit(1)

    console.print(f"\n[bold]笔记 #{note.id}[/bold]  [{note.status}]")
    console.print(f"  物品 ID：{note.item_id or '—'}  参考账号：{note.account_ref or '—'}")
    if note.title:
        console.print(f"\n  标题：{note.title}")
    if note.cover_desc:
        console.print(f"  封面文案：{note.cover_desc}")
    if note.body:
        console.print(f"\n  正文：\n{note.body}")
    if note.tags:
        console.print(f"\n  话题：{note.tags_str()}")
    console.print()


@content.command("edit")
@click.argument("note_id", type=int)
@click.option("--title", "-t", default=None)
@click.option("--body", "-b", default=None)
@click.option("--cover", "-c", default=None, help="封面文案")
@click.option("--tags", default=None, help="话题标签，逗号分隔")
@click.option("--status", "-s", default=None, help="状态：draft / ready / published")
def content_edit(note_id, title, body, cover, tags, status):
    """更新笔记内容"""
    from app.modules.content.manager import update_note_content, update_note_status, get_note

    pool_id = _active_pool_id()
    if not get_note(note_id, account_pool_id=pool_id):
        console.print(f"[red]笔记 ID {note_id} 不存在（或不属于当前账号）[/red]")
        sys.exit(1)

    tags_list = [t.strip().lstrip("#") for t in tags.split(",")] if tags else None
    update_note_content(note_id, title=title, body=body, tags=tags_list, cover_desc=cover)
    if status:
        update_note_status(note_id, status)

    note = get_note(note_id, account_pool_id=pool_id)
    console.print(f"[green]✓[/green] 笔记 ID={note_id} 已更新（{note.status}）")


@content.command("export")
@click.argument("note_id", type=int)
@click.option("--output", "-o", default=None, help="输出文件路径（默认打印到终端）")
def content_export(note_id, output):
    """将笔记导出为 Markdown"""
    from app.modules.content.manager import get_note, export_note_markdown
    from app.modules.library.manager import get_item

    pool_id = _active_pool_id()
    note = get_note(note_id, account_pool_id=pool_id)
    if not note:
        console.print(f"[red]笔记 ID {note_id} 不存在[/red]")
        sys.exit(1)

    item_title = ""
    if note.item_id:
        item = get_item(note.item_id, account_pool_id=pool_id)
        if item:
            item_title = item.title

    md = export_note_markdown(note, item_title=item_title)

    if output:
        Path(output).write_text(md, encoding="utf-8")
        console.print(f"[green]✓[/green] 已导出到：{output}")
    else:
        console.print("\n" + md + "\n")


# ──────────────────────────────────────────────
# accounts 子命令组
# ──────────────────────────────────────────────

@cli.group()
def accounts():
    """榜样账号管理"""
    pass


@accounts.command("list")
def accounts_list():
    """列出已抓取的榜样账号"""
    from app.db.connection import get_db
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM reference_accounts ORDER BY crawled_at DESC"
    ).fetchall()
    conn.close()

    if not rows:
        console.print("[dim]暂无榜样账号数据，可用 accounts add 手动录入或运行 crawler/xhs_creator.py --save-db[/dim]")
        return

    table = Table(box=box.SIMPLE, show_header=True, header_style="bold cyan")
    table.add_column("account_id", width=24)
    table.add_column("名称", width=16)
    table.add_column("笔记数", width=6)
    table.add_column("均赞", width=7)
    table.add_column("均评", width=7)
    table.add_column("均藏", width=7)
    table.add_column("抓取时间", width=18)

    for r in rows:
        table.add_row(
            r["account_id"][:24],
            r["name"] or "—",
            str(r["note_count"]),
            str(r["avg_likes"]),
            str(r["avg_comments"]),
            str(r["avg_collects"]),
            (r["crawled_at"] or "")[:16],
        )
    console.print(table)


@accounts.command("add")
@click.argument("account_id")
@click.option("--name", "-n", required=True, help="账号名称")
@click.option("--note-count", default=0, type=int, help="笔记总数")
@click.option("--avg-likes", default=0.0, type=float, help="平均点赞数")
@click.option("--avg-comments", default=0.0, type=float, help="平均评论数")
@click.option("--avg-collects", default=0.0, type=float, help="平均收藏数")
@click.option("--style", default=None, help="内容风格描述（自由文本）")
@click.option("--top-notes", default=None, help='高赞笔记标题，逗号分隔，如 "标题1,标题2,标题3"')
def accounts_add(account_id, name, note_count, avg_likes, avg_comments, avg_collects, style, top_notes):
    """手动录入榜样账号信息（不依赖爬虫）"""
    from app.db.connection import get_db, init_db
    import json as _json
    from datetime import datetime

    init_db()
    conn = get_db()

    # 解析 top_notes
    top_notes_json = "[]"
    if top_notes:
        titles = [t.strip() for t in top_notes.split(",") if t.strip()]
        top_notes_json = _json.dumps(
            [{"title": t, "likes": 0, "url": ""} for t in titles],
            ensure_ascii=False
        )

    # 解析 style → content_style JSON
    content_style_json = None
    if style:
        content_style_json = _json.dumps({"description": style}, ensure_ascii=False)

    try:
        conn.execute(
            """INSERT INTO reference_accounts
               (account_id, name, note_count, avg_likes, avg_comments, avg_collects,
                total_likes, top_notes, content_style, raw_data, crawled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
               ON CONFLICT(account_id) DO UPDATE SET
                 name=excluded.name,
                 note_count=excluded.note_count,
                 avg_likes=excluded.avg_likes,
                 avg_comments=excluded.avg_comments,
                 avg_collects=excluded.avg_collects,
                 total_likes=excluded.total_likes,
                 top_notes=excluded.top_notes,
                 content_style=excluded.content_style,
                 crawled_at=datetime('now','localtime')
            """,
            (
                account_id, name, note_count,
                avg_likes, avg_comments, avg_collects,
                int(avg_likes * note_count),
                top_notes_json, content_style_json,
                _json.dumps({"source": "manual"}, ensure_ascii=False),
            )
        )
        conn.commit()
    finally:
        conn.close()

    console.print(f"[green]✓[/green] 已录入账号 [bold]{name}[/bold]（{account_id}）")
    if top_notes:
        titles = [t.strip() for t in top_notes.split(",") if t.strip()]
        for t in titles:
            console.print(f"  · {t}")


@accounts.command("show")
@click.argument("account_id")
def accounts_show(account_id):
    """查看账号详情"""
    from app.db.connection import get_db
    import json as _json

    conn = get_db()
    row = conn.execute(
        "SELECT * FROM reference_accounts WHERE account_id=?", (account_id,)
    ).fetchone()
    conn.close()

    if not row:
        console.print(f"[red]账号 {account_id} 不存在[/red]")
        return

    console.print(f"\n[bold cyan]{row['name']}[/bold cyan]  ({row['account_id']})")
    console.print(f"  笔记数：{row['note_count']}  "
                  f"均赞：{row['avg_likes']}  均评：{row['avg_comments']}  均藏：{row['avg_collects']}")

    if row["content_style"]:
        try:
            cs = _json.loads(row["content_style"])
            desc = cs.get("description") or _json.dumps(cs, ensure_ascii=False)
            console.print(f"  风格：{desc}")
        except Exception:
            console.print(f"  风格：{row['content_style']}")

    top_notes = _json.loads(row["top_notes"] or "[]")
    if top_notes:
        console.print("  高赞笔记：")
        for n in top_notes:
            likes_str = f"  赞 {n['likes']}" if n.get("likes") else ""
            console.print(f"    · {n.get('title', '')}[dim]{likes_str}[/dim]")

    console.print(f"  录入时间：{(row['crawled_at'] or '')[:16]}\n")


@accounts.command("delete")
@click.argument("account_id")
@click.confirmation_option(prompt="确认删除该账号吗？")
def accounts_delete(account_id):
    """删除榜样账号"""
    from app.db.connection import get_db

    conn = get_db()
    cur = conn.execute(
        "DELETE FROM reference_accounts WHERE account_id=?", (account_id,)
    )
    conn.commit()
    conn.close()

    if cur.rowcount:
        console.print(f"[green]✓[/green] 已删除账号 {account_id}")
    else:
        console.print(f"[yellow]账号 {account_id} 不存在[/yellow]")


# ──────────────────────────────────────────────
# profile 子命令组（我的账号人设）
# ──────────────────────────────────────────────

@cli.group()
def profile():
    """我的账号人设管理（运营主体信息）"""
    pass


@profile.command("init")
@click.option("--url",          default=None, help="我的小红书账号主页 URL（含 xsec_token），提供后自动爬虫+AI推断人设")
@click.option("--account-id",   default=None, help="小红书账号 ID（可选，--url 模式下会自动解析）")
@click.option("--name",         default=None, help="账号显示名（--url 模式下可选）")
@click.option("--niche",        default=None, help='垂类定位，如 "家居软装/租房改造"（--url 模式下由AI推断）')
@click.option("--audience",     default=None, help="目标受众描述")
@click.option("--pillars",      default=None, help='内容支柱，逗号分隔，如 "软装搭配,改造记录,好物分享"')
@click.option("--persona-name", default=None, help="人设名称/昵称")
@click.option("--persona-bio",  default=None, help="人设简介（50字以内）")
@click.option("--persona-tone", default=None, help='语气风格，如 "嘴硬傲娇，短句换行，不说空话"')
@click.option("--taboos",       default=None, help='禁忌词/风格，逗号分隔，如 "精致,高品质,高级感"')
@click.option("--styles",       default=None, help='偏好家居风格，逗号分隔，如 "奶油风,侘寂风"')
@click.option("--scenes",       default=None, help='偏好场景，逗号分隔，如 "客厅,卧室,出租屋"')
@click.option("--hashtags",     default=None, help='常用话题标签池，逗号分隔（不含#）')
@click.option("--rhythm",       default=None, help='发帖节奏，如 "每周3篇，周二四六"')
@click.option("--followers",    default=0, type=int, help="当前粉丝数")
@click.option("--total-notes",  default=0, type=int, help="已发笔记总数")
@click.option("--avg-likes",    default=0.0, type=float, help="平均点赞数")
@click.option("--avg-comments", default=0.0, type=float, help="平均评论数")
@click.option("--avg-collects", default=0.0, type=float, help="平均收藏数")
def profile_init(url, account_id, name, niche, audience, pillars, persona_name, persona_bio,
                 persona_tone, taboos, styles, scenes, hashtags, rhythm,
                 followers, total_notes, avg_likes, avg_comments, avg_collects):
    """初始化/更新我的账号信息（幂等，可重复运行）

    \b
    两种模式：
      1. 爬虫自动推断（推荐）：
         python app/cli.py profile init --url "https://www.xiaohongshu.com/user/profile/<id>?xsec_token=..."
         --url 选项触发爬虫抓取笔记数据，再由 AI 自动推断账号定位、语气、标签等字段。
      2. 手动填写：
         python app/cli.py profile init --name "账号名" --niche "家居软装"
    """
    from app.db.connection import get_db, init_db
    import json as _json

    init_db()

    def _split(s):
        return [t.strip().lstrip("#") for t in s.split(",") if t.strip()] if s else []

    # ── 模式一：爬虫 + AI 推断 ──────────────────────────────────────
    if url:
        import asyncio
        import re
        import sys as _sys
        from pathlib import Path as _Path

        console.print(f"[cyan]正在抓取账号数据...[/cyan]")
        console.print("[dim]首次运行需要扫码登录小红书，请在弹出的浏览器中完成[/dim]")

        # 解析 account_id
        if not account_id:
            m = re.search(r"/profile/([a-f0-9A-F]+)", url)
            account_id = m.group(1) if m else None

        # 复用 xhs_creator.py 的爬虫逻辑（直接 import 函数，避免重复代码）
        _project_root = _Path(__file__).parent.parent
        _mc_dir = _project_root / "tools" / "MediaCrawler"
        _sys.path.insert(0, str(_mc_dir))
        _sys.path.insert(0, str(_project_root))

        import os as _os
        _orig_dir = _os.getcwd()
        _os.chdir(_mc_dir)

        try:
            from crawler.xhs_creator import run_crawl, calc_stats, save_my_profile_crawl_data
            notes, creator_info = asyncio.run(run_crawl(url))
        finally:
            _os.chdir(_orig_dir)

        if not notes:
            console.print("[red]爬虫未获取到数据，请检查 URL 和登录状态[/red]")
            raise SystemExit(1)

        stats = calc_stats(notes)
        # 优先使用爬虫抓到的粉丝数，否则保留用户手动填写的值
        followers_crawled = creator_info.get("fans", 0) if creator_info else 0
        total_notes_crawled = stats["note_count"]
        avg_likes_crawled = stats["avg_likes"]
        avg_comments_crawled = stats["avg_comments"]
        avg_collects_crawled = stats["avg_collects"]

        console.print(f"[green]✓[/green] 抓取完成，共 {total_notes_crawled} 条笔记")
        console.print(f"[cyan]正在用 AI 分析笔记数据，推断账号人设...[/cyan]")

        from app.modules.profile.analyzer import infer_profile_from_notes
        try:
            inferred = infer_profile_from_notes(notes, stats)
        except Exception as e:
            console.print(f"[red]AI 推断失败：{e}[/red]")
            console.print("[yellow]将使用空人设写入数据库，请之后手动 profile edit 补充[/yellow]")
            inferred = {}

        # 命令行手动参数优先级 > AI 推断值（用户可以在 --url 的同时用 --niche 覆盖）
        niche         = niche         or inferred.get("niche", "")
        audience      = audience      or inferred.get("target_audience", "")
        persona_tone  = persona_tone  or inferred.get("persona_tone", "")
        rhythm        = rhythm        or inferred.get("posting_rhythm", "")
        name          = name          or account_id or "我的账号"

        if not pillars:
            pillars_list = inferred.get("content_pillars", [])
        else:
            pillars_list = _split(pillars)

        if not taboos:
            taboos_list = inferred.get("taboos", [])
        else:
            taboos_list = _split(taboos)

        if not styles:
            styles_list = inferred.get("preferred_styles", [])
        else:
            styles_list = _split(styles)

        if not scenes:
            scenes_list = inferred.get("preferred_scenes", [])
        else:
            scenes_list = _split(scenes)

        if not hashtags:
            hashtags_list = inferred.get("hashtag_pool", [])
        else:
            hashtags_list = _split(hashtags)

        # 用爬虫获取的统计数据，除非用户手动指定了非零值
        if followers == 0:
            followers = followers_crawled
        if total_notes == 0:
            total_notes = total_notes_crawled
        if avg_likes == 0.0:
            avg_likes = avg_likes_crawled
        if avg_comments == 0.0:
            avg_comments = avg_comments_crawled
        if avg_collects == 0.0:
            avg_collects = avg_collects_crawled

        # 打印推断结果
        console.print(f"\n[bold cyan]── AI 推断结果（已写入数据库，可用 profile edit 修正）──[/bold cyan]")
        console.print(f"  垂类：{niche}")
        console.print(f"  目标受众：{audience}")
        console.print(f"  内容支柱：{'、'.join(pillars_list)}")
        console.print(f"  语气风格：{persona_tone}")
        console.print(f"  偏好风格：{'、'.join(styles_list)}")
        console.print(f"  偏好场景：{'、'.join(scenes_list)}")
        console.print(f"  标签池：{'  '.join('#'+t for t in hashtags_list[:6])}")
        console.print(f"  禁忌词：{'、'.join(taboos_list)}")
        if inferred.get("analysis_summary"):
            console.print(f"  总结：{inferred['analysis_summary']}")

    # ── 模式二：手动填写 ─────────────────────────────────────────────
    else:
        creator_info = None
        if not name:
            console.print("[red]请提供 --name（账号显示名）或 --url（账号主页URL，自动推断）[/red]")
            raise SystemExit(1)
        if not niche:
            console.print("[red]请提供 --niche（垂类定位）或 --url（账号主页URL，自动推断）[/red]")
            raise SystemExit(1)

        pillars_list  = _split(pillars)
        taboos_list   = _split(taboos)
        styles_list   = _split(styles)
        scenes_list   = _split(scenes)
        hashtags_list = _split(hashtags)

    # ── 写入数据库 ────────────────────────────────────────────────────
    pool_id = _active_pool_id()
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO my_profile
               (account_pool_id, account_id, display_name, niche, target_audience, content_pillars,
                persona_name, persona_bio, persona_tone, persona_taboos,
                followers, total_notes, avg_likes, avg_comments, avg_collects,
                preferred_styles, preferred_scenes, hashtag_pool, posting_rhythm,
                updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                       datetime('now','localtime'))
               ON CONFLICT(account_pool_id) DO UPDATE SET
                 account_id=excluded.account_id,
                 display_name=excluded.display_name,
                 niche=excluded.niche,
                 target_audience=excluded.target_audience,
                 content_pillars=excluded.content_pillars,
                 persona_name=excluded.persona_name,
                 persona_bio=excluded.persona_bio,
                 persona_tone=excluded.persona_tone,
                 persona_taboos=excluded.persona_taboos,
                 followers=excluded.followers,
                 total_notes=excluded.total_notes,
                 avg_likes=excluded.avg_likes,
                 avg_comments=excluded.avg_comments,
                 avg_collects=excluded.avg_collects,
                 preferred_styles=excluded.preferred_styles,
                 preferred_scenes=excluded.preferred_scenes,
                 hashtag_pool=excluded.hashtag_pool,
                 posting_rhythm=excluded.posting_rhythm,
                 updated_at=datetime('now','localtime')
            """,
            (
                pool_id,
                account_id, name, niche, audience,
                _json.dumps(pillars_list, ensure_ascii=False),
                persona_name, persona_bio, persona_tone,
                _json.dumps(taboos_list, ensure_ascii=False),
                followers, total_notes, avg_likes, avg_comments, avg_collects,
                _json.dumps(styles_list, ensure_ascii=False),
                _json.dumps(scenes_list, ensure_ascii=False),
                _json.dumps(hashtags_list, ensure_ascii=False),
                rhythm,
            )
        )
        conn.commit()
    finally:
        conn.close()

    console.print(f"\n[green]✓[/green] 账号人设已写入数据库：[bold]{name}[/bold]")
    if niche:
        console.print(f"  垂类：{niche}")
    if persona_name:
        console.print(f"  人设：{persona_name}  {persona_bio or ''}")
    console.print("[dim]运行 profile show 查看完整信息 | profile edit 修正字段[/dim]")

    # 同步小红书主页原始数据（头像/粉丝/bio/IP/标签）
    if url and creator_info:
        try:
            save_my_profile_crawl_data(creator_info, account_pool_id=pool_id)
            console.print(f"[green]✓[/green] 小红书主页信息已同步（粉丝：{creator_info.get('fans', 0)}）")
        except Exception as e:
            console.print(f"[yellow]⚠ 同步小红书主页信息失败：{e}[/yellow]")


@profile.command("show")
def profile_show():
    """查看我的账号人设信息"""
    from app.db.connection import get_db
    import json as _json

    conn = get_db()
    row = conn.execute("SELECT * FROM my_profile WHERE account_pool_id=?", (_active_pool_id(),)).fetchone()
    conn.close()

    if not row:
        console.print("[yellow]尚未初始化账号信息，运行：profile init --name ... --niche ...[/yellow]")
        return

    console.print(f"\n[bold cyan]{'═'*50}[/bold cyan]")
    console.print(f"[bold]账号：{row['display_name']}[/bold]" +
                  (f"  ({row['account_id']})" if row['account_id'] else ""))
    console.print(f"[bold cyan]{'═'*50}[/bold cyan]")

    console.print(f"\n[bold]【定位 & 容局】[/bold]")
    console.print(f"  垂类：{row['niche'] or '—'}")
    if row['target_audience']:
        console.print(f"  目标受众：{row['target_audience']}")
    pillars = _json.loads(row['content_pillars'] or '[]')
    if pillars:
        console.print(f"  内容支柱：{'、'.join(pillars)}")

    console.print(f"\n[bold]【人设】[/bold]")
    console.print(f"  名称：{row['persona_name'] or '—'}")
    if row['persona_bio']:
        console.print(f"  简介：{row['persona_bio']}")
    if row['persona_tone']:
        console.print(f"  语气：{row['persona_tone']}")
    taboos = _json.loads(row['persona_taboos'] or '[]')
    if taboos:
        console.print(f"  禁忌：{'、'.join(taboos)}")

    console.print(f"\n[bold]【账号数据】[/bold]")
    console.print(f"  粉丝 {row['followers']}  |  已发 {row['total_notes']} 篇  |  "
                  f"均赞 {row['avg_likes']}  均评 {row['avg_comments']}  均藏 {row['avg_collects']}")

    console.print(f"\n[bold]【创作偏好】[/bold]")
    styles = _json.loads(row['preferred_styles'] or '[]')
    scenes = _json.loads(row['preferred_scenes'] or '[]')
    tags = _json.loads(row['hashtag_pool'] or '[]')
    if styles:
        console.print(f"  偏好风格：{'、'.join(styles)}")
    if scenes:
        console.print(f"  偏好场景：{'、'.join(scenes)}")
    if tags:
        console.print(f"  标签池：{'  '.join('#'+t for t in tags)}")
    if row['posting_rhythm']:
        console.print(f"  发帖节奏：{row['posting_rhythm']}")

    console.print(f"\n[dim]最后更新：{(row['updated_at'] or '')[:16]}[/dim]\n")


@profile.command("edit")
@click.option("--name",         default=None, help="账号显示名")
@click.option("--niche",        default=None, help="垂类定位")
@click.option("--audience",     default=None, help="目标受众")
@click.option("--pillars",      default=None, help="内容支柱，逗号分隔")
@click.option("--persona-name", default=None, help="人设名称")
@click.option("--persona-bio",  default=None, help="人设简介")
@click.option("--persona-tone", default=None, help="语气风格")
@click.option("--taboos",       default=None, help="禁忌词，逗号分隔")
@click.option("--styles",       default=None, help="偏好风格，逗号分隔")
@click.option("--scenes",       default=None, help="偏好场景，逗号分隔")
@click.option("--hashtags",     default=None, help="话题标签池，逗号分隔")
@click.option("--rhythm",       default=None, help="发帖节奏")
@click.option("--followers",    default=None, type=int, help="粉丝数")
@click.option("--total-notes",  default=None, type=int, help="已发笔记数")
@click.option("--avg-likes",    default=None, type=float, help="平均点赞")
@click.option("--avg-comments", default=None, type=float, help="平均评论")
@click.option("--avg-collects", default=None, type=float, help="平均收藏")
def profile_edit(**kwargs):
    """更新账号信息中的单个或多个字段"""
    from app.db.connection import get_db
    import json as _json

    def _split(s):
        return [t.strip().lstrip("#") for t in s.split(",") if t.strip()] if s else None

    field_map = {
        "name": "display_name",
        "niche": "niche",
        "audience": "target_audience",
        "persona_name": "persona_name",
        "persona_bio": "persona_bio",
        "persona_tone": "persona_tone",
        "rhythm": "posting_rhythm",
        "followers": "followers",
        "total_notes": "total_notes",
        "avg_likes": "avg_likes",
        "avg_comments": "avg_comments",
        "avg_collects": "avg_collects",
    }
    json_field_map = {
        "pillars":  "content_pillars",
        "taboos":   "persona_taboos",
        "styles":   "preferred_styles",
        "scenes":   "preferred_scenes",
        "hashtags": "hashtag_pool",
    }

    updates = {}
    for k, col in field_map.items():
        if kwargs.get(k) is not None:
            updates[col] = kwargs[k]
    for k, col in json_field_map.items():
        if kwargs.get(k) is not None:
            parsed = _split(kwargs[k])
            if parsed is not None:
                updates[col] = _json.dumps(parsed, ensure_ascii=False)

    if not updates:
        console.print("[yellow]未指定任何字段，无变更[/yellow]")
        return

    set_parts = [f"{col}=?" for col in updates]
    set_parts.append("updated_at=datetime('now','localtime')")
    set_clause = ", ".join(set_parts)
    values = list(updates.values())

    conn = get_db()
    try:
        conn.execute(
            f"UPDATE my_profile SET {set_clause} WHERE account_pool_id=?",
            values + [_active_pool_id()],
        )
        conn.commit()
    finally:
        conn.close()

    console.print(f"[green]✓[/green] 已更新 {len(updates)} 个字段")


if __name__ == "__main__":
    cli()
