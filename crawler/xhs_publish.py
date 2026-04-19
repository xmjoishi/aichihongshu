#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书笔记自动发布脚本
用途：将准备好的笔记按类型（text/image/video）自动发布到小红书
用法：
    cd <项目根目录>
    python crawler/xhs_publish.py --note-id 1
    python crawler/xhs_publish.py --title "标题" --body "正文" --note-type image --images "a.jpg,b.jpg"

笔记类型：
    text  — 文字配图（无需图片，小红书自动生成封面）
    image — 图文多图（上传 item_ids 关联的图库图片）
    video — 视频（上传 video_path 指定的视频文件）

注意：
    - 需要先通过 xhs_search.py 等脚本扫码登录，登录态缓存在 tools/MediaCrawler/browser_data/
    - 首次运行若未登录会等待扫码（最多 120 秒）
    - 默认 headless=False（可见窗口），便于处理滑块验证码
"""

import sys
import os
import asyncio
import argparse
import json
import shutil
from pathlib import Path
from typing import Optional

# ── 路径设置 ──────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).parent.parent
MEDIA_CRAWLER_DIR = PROJECT_ROOT / "tools" / "MediaCrawler"
sys.path.insert(0, str(MEDIA_CRAWLER_DIR))
os.chdir(MEDIA_CRAWLER_DIR)  # MediaCrawler 需要从自身目录运行

XHS_CREATOR_URL = "https://creator.xiaohongshu.com/publish/publish?source=official"
USER_DATA_DIR = MEDIA_CRAWLER_DIR / "browser_data" / "xhs_user_data_dir"
TMP_UPLOAD_DIR = Path("/tmp/xhs_publish_uploads")


# ── 工具函数 ──────────────────────────────────────────────

def prepare_images(image_paths: list[str]) -> list[Path]:
    """将图片复制到临时目录并返回临时路径列表"""
    TMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    tmp_paths = []
    for src in image_paths:
        src_path = Path(src)
        if not src_path.exists():
            print(f"[警告] 图片不存在，跳过：{src}")
            continue
        dst = TMP_UPLOAD_DIR / src_path.name
        shutil.copy2(src_path, dst)
        tmp_paths.append(dst)
    return tmp_paths


def kill_chromium_using_profile():
    """终止占用 xhs_user_data_dir 的旧 Chromium 进程"""
    import subprocess as _sp
    user_data_str = str(USER_DATA_DIR)
    try:
        result = _sp.run(["pgrep", "-f", user_data_str], capture_output=True, text=True)
        pids = [p.strip() for p in result.stdout.strip().splitlines() if p.strip()]
        for pid in pids:
            print(f"[发布] 终止占用 user_data_dir 的旧进程 pid={pid}")
            _sp.run(["kill", "-TERM", pid], capture_output=True)
    except Exception as e:
        print(f"[发布] 关闭旧进程时出错（忽略）：{e}")


async def check_login_status(headless: bool = True) -> bool:
    """快速检测是否已登录小红书（不打开发布页，只访问创作者中心首页）"""
    from playwright.async_api import async_playwright
    try:
        async with async_playwright() as p:
            context = await p.chromium.launch_persistent_context(
                user_data_dir=str(USER_DATA_DIR),
                headless=headless,
                args=["--disable-blink-features=AutomationControlled"],
                viewport={"width": 1280, "height": 800},
                locale="zh-CN",
            )
            page = await context.new_page()
            await page.goto("https://creator.xiaohongshu.com/publish/publish?source=official",
                            wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(2000)
            url = page.url
            await context.close()
            return "login" not in url and "passport" not in url
    except Exception:
        return False


async def wait_for_login(page, timeout_ms: int = 120000):
    """若当前页面在登录页，等待用户扫码"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout
    if "login" in page.url or "passport" in page.url:
        print("[发布] 未登录，等待扫码登录（最多 120 秒）...")
        print("[发布] 请在弹出的浏览器窗口中扫码登录小红书")
        try:
            await page.wait_for_url(
                lambda url: "creator.xiaohongshu.com" in url and "login" not in url,
                timeout=timeout_ms,
            )
        except PlaywrightTimeout:
            raise RuntimeError("扫码登录超时，请重新运行并完成登录")
        await page.wait_for_timeout(2000)


async def click_upload_image_tab(page):
    """点击「上传图文」tab"""
    await page.wait_for_selector("text=上传图文", timeout=10000)
    await page.evaluate("""
        () => {
            const els = document.querySelectorAll('span, div, button, a');
            for (const el of els) {
                if (el.textContent.trim() === '上传图文') { el.click(); return true; }
            }
            return false;
        }
    """)
    await page.wait_for_timeout(2000)


async def fill_title(page, title: str):
    """填写标题（单行 input）"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout
    try:
        title_input = page.locator('input[placeholder*="标题"]').first
        await title_input.click(timeout=8000)
        await page.keyboard.press("Meta+a")
        await page.keyboard.type(title[:20], delay=30)
    except PlaywrightTimeout:
        safe_title = title[:20].replace("'", "\\'").replace("\\", "\\\\")
        await page.evaluate(f"""
            () => {{
                const inputs = document.querySelectorAll('input');
                for (const inp of inputs) {{
                    if (inp.placeholder && inp.placeholder.includes('标题')) {{
                        inp.focus(); inp.value = '{safe_title}';
                        inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        return true;
                    }}
                }}
            }}
        """)
    await page.wait_for_timeout(300)


async def fill_body_and_tags(page, body: str, tags: list[str]):
    """填写正文（最大 contenteditable）并追加话题标签"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    # 找最大的 contenteditable 作为正文区
    body_filled = await page.evaluate("""
        () => {
            const areas = document.querySelectorAll('[contenteditable="true"]');
            let best = null;
            for (const a of areas) {
                if (!best || a.offsetHeight > best.offsetHeight) best = a;
            }
            if (best) {
                best.focus();
                best.textContent = '';
                best.dispatchEvent(new Event('input', {bubbles: true}));
                return true;
            }
            return false;
        }
    """)
    if body_filled:
        await page.keyboard.type(body, delay=8)
    await page.wait_for_timeout(300)

    # 追加话题标签
    if tags:
        print(f"[发布] 添加话题标签：{tags[:5]}...")
        for tag in tags[:5]:
            clean_tag = tag.strip().lstrip("#")
            if not clean_tag:
                continue
            await page.keyboard.press("End")
            await page.keyboard.type(f" #{clean_tag}")
            await page.wait_for_timeout(1000)
            try:
                suggestion = page.locator(
                    ".topic-item, .mention-item, .suggestion-item, [class*='topic'] li:first-child"
                ).first
                await suggestion.click(timeout=3000)
            except PlaywrightTimeout:
                await page.keyboard.press("Space")
            await page.wait_for_timeout(300)


async def click_publish_btn(page):
    """点击发布按钮"""
    published = await page.evaluate("""
        () => {
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
                if (btn.textContent.trim() === '发布' && !btn.disabled) {
                    btn.click(); return true;
                }
            }
            return false;
        }
    """)
    if not published:
        from playwright.async_api import TimeoutError as PlaywrightTimeout
        btn = page.locator('button:has-text("发布")').last
        await btn.click(timeout=10000)


async def get_note_url_after_publish(page) -> Optional[str]:
    """发布后等待并尝试获取笔记链接"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout
    await page.wait_for_timeout(4000)
    current_url = page.url
    if "explore" in current_url or "noteId" in current_url:
        return current_url
    try:
        link_el = page.locator('a[href*="xiaohongshu.com/explore"]').first
        return await link_el.get_attribute("href", timeout=3000)
    except Exception:
        return None


# ── 三种发布流程 ──────────────────────────────────────────

async def publish_text_note(page, title: str, body: str, tags: list[str]):
    """文字配图发布流程"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    print("[发布] 进入图文发布页...")
    await click_upload_image_tab(page)

    print("[发布] 无图片，使用文字配图模式...")
    # 点「文字配图」
    await page.evaluate("""
        () => {
            const els = document.querySelectorAll('span, div, button, a');
            for (const el of els) {
                if (el.textContent.trim() === '文字配图') { el.click(); return true; }
            }
            return false;
        }
    """)
    await page.wait_for_timeout(1500)

    # 填封面文字（最大 contenteditable）
    cover_filled = await page.evaluate("""
        () => {
            const areas = document.querySelectorAll('[contenteditable="true"]');
            if (areas.length > 0) { areas[0].focus(); return true; }
            return false;
        }
    """)
    if cover_filled:
        await page.keyboard.type(title[:30], delay=50)
    await page.wait_for_timeout(500)

    # 点「生成图片」
    await page.evaluate("""
        () => {
            const btns = document.querySelectorAll('button, div[role="button"]');
            for (const btn of btns) {
                if (btn.textContent.trim() === '生成图片') { btn.click(); return true; }
            }
            return false;
        }
    """)
    await page.wait_for_timeout(4000)

    # 选第一个模板（JS 探测可用选择器）
    clicked = await page.evaluate("""
        () => {
            const selectors = [
                '.cover-item', '.template-item', '.style-item', '.card-item',
                '[class*="template"]', '[class*="cover"]', 'ul li', '.list li'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) { el.click(); return sel; }
            }
            return null;
        }
    """)
    print(f"[发布] 模板选择：{clicked}")
    await page.wait_for_timeout(1000)

    # 点「下一步」
    try:
        next_btn = page.get_by_text("下一步").first
        await next_btn.click(timeout=8000)
    except PlaywrightTimeout:
        await page.evaluate("""
            () => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    if (btn.textContent.includes('下一步')) { btn.click(); return true; }
                }
            }
        """)
    await page.wait_for_timeout(2000)

    print("[发布] 填写标题...")
    await fill_title(page, title)
    print("[发布] 填写正文和话题...")
    await fill_body_and_tags(page, body, tags)


async def publish_image_note(page, title: str, body: str, tags: list[str], image_paths: list[str]):
    """图文多图发布流程"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    print("[发布] 进入图文发布页...")
    await click_upload_image_tab(page)

    # 等待文件上传 input 出现
    await page.wait_for_timeout(1500)

    tmp_images = prepare_images(image_paths)
    if not tmp_images:
        raise RuntimeError("没有可用的图片文件，请检查图库图片路径")

    print(f"[发布] 上传 {len(tmp_images)} 张图片...")
    # 小红书图文上传：点击上传区域或直接找 file input
    try:
        # 先尝试直接 set_input_files
        file_input = page.locator('input[type="file"][accept*="image"]').first
        await file_input.set_input_files([str(p) for p in tmp_images], timeout=10000)
    except PlaywrightTimeout:
        # 备用：任意 file input
        file_input = page.locator('input[type="file"]').first
        await file_input.set_input_files([str(p) for p in tmp_images], timeout=10000)

    # 等待图片上传完成（出现预览）
    print("[发布] 等待图片上传完成...")
    try:
        await page.wait_for_selector(
            '.upload-success, .preview-item, .image-item, [class*="preview"] img',
            timeout=30000,
        )
    except PlaywrightTimeout:
        # 即使没检测到预览，等 5 秒继续
        await page.wait_for_timeout(5000)

    await page.wait_for_timeout(1500)
    print("[发布] 填写标题...")
    await fill_title(page, title)
    print("[发布] 填写正文和话题...")
    await fill_body_and_tags(page, body, tags)

    # 清理临时图片
    for tmp in tmp_images:
        try:
            tmp.unlink()
        except Exception:
            pass


async def publish_video_note(page, title: str, body: str, tags: list[str], video_path: str):
    """视频发布流程"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    print("[发布] 进入视频发布页...")
    # 默认页面就是「上传视频」，无需切换
    await page.wait_for_timeout(1500)

    print(f"[发布] 上传视频：{video_path}")
    file_input = page.locator('input[type="file"][accept*="video"]').first
    try:
        await file_input.set_input_files(video_path, timeout=10000)
    except PlaywrightTimeout:
        file_input = page.locator('input[type="file"]').first
        await file_input.set_input_files(video_path, timeout=10000)

    # 等待视频上传完成
    print("[发布] 等待视频上传...")
    try:
        await page.wait_for_selector(
            '.upload-success, [class*="video-preview"], [class*="upload-done"]',
            timeout=120000,
        )
    except PlaywrightTimeout:
        await page.wait_for_timeout(10000)

    await page.wait_for_timeout(2000)
    print("[发布] 填写标题...")
    await fill_title(page, title)
    print("[发布] 填写正文和话题...")
    await fill_body_and_tags(page, body, tags)


# ── 主发布入口 ────────────────────────────────────────────

async def publish_note(
    title: str,
    body: str,
    tags: list[str],
    note_type: str = "text",          # text | image | video
    image_paths: list[str] | None = None,
    video_path: str | None = None,
    headless: bool = False,
) -> dict:
    """
    使用 Playwright 自动发布小红书笔记。
    返回 {"success": bool, "note_url": str | None, "error": str | None}
    """
    from playwright.async_api import async_playwright

    # 关闭占用登录态的旧进程
    kill_chromium_using_profile()
    await asyncio.sleep(2)

    # 预检登录态：若未登录，强制可见窗口让用户扫码
    print("[发布] 检测登录状态...")
    logged_in = await check_login_status(headless=True)
    # check 完毕后再次清理（check 时 context.close 已释放，但进程可能残留）
    kill_chromium_using_profile()
    await asyncio.sleep(1)

    if not logged_in:
        print("[发布] 未检测到登录态，将弹出浏览器窗口，请扫码登录后等待自动继续发布...")
        headless = False  # 强制可见，用户才能扫码
    else:
        print("[发布] 已登录，继续发布流程...")

    TMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=str(USER_DATA_DIR),
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
        )
        page = await context.new_page()

        try:
            print("[发布] 打开创作者中心...")
            await page.goto(XHS_CREATOR_URL, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2000)
            await wait_for_login(page)

            # 按类型走不同流程
            if note_type == "image":
                await publish_image_note(page, title, body, tags, image_paths or [])
            elif note_type == "video":
                if not video_path:
                    raise RuntimeError("video 类型必须提供 video_path")
                await publish_video_note(page, title, body, tags, video_path)
            else:  # text
                await publish_text_note(page, title, body, tags)

            # 截图确认发布前状态
            await page.screenshot(path=str(TMP_UPLOAD_DIR / "before_publish.png"))

            print("[发布] 点击发布按钮...")
            await click_publish_btn(page)

            print("[发布] 等待发布结果...")
            note_url = await get_note_url_after_publish(page)
            print(f"[发布] 成功！笔记链接：{note_url or '（未获取到链接）'}")
            return {"success": True, "note_url": note_url, "error": None}

        except Exception as e:
            error_msg = str(e)
            print(f"[发布] 失败：{error_msg}")
            try:
                await page.screenshot(path=str(TMP_UPLOAD_DIR / "publish_error.png"))
                print(f"[发布] 错误截图已保存：{TMP_UPLOAD_DIR}/publish_error.png")
            except Exception:
                pass
            return {"success": False, "note_url": None, "error": error_msg}

        finally:
            await context.close()


# ── 从数据库加载笔记 ──────────────────────────────────────

def load_note_from_db(note_id: int) -> dict:
    """从项目数据库读取笔记、note_type 及关联图片/视频路径"""
    import sqlite3
    db_path = PROJECT_ROOT / "data" / "app.db"
    if not db_path.exists():
        raise FileNotFoundError(f"数据库不存在：{db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        note = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not note:
            raise ValueError(f"笔记 {note_id} 不存在")

        note_dict = dict(note)
        note_type = note_dict.get("note_type") or "text"

        # 获取关联图库图片路径（image 类型）
        image_paths: list[str] = []
        raw_item_ids = note_dict.get("item_ids") or "[]"
        try:
            item_ids: list[int] = json.loads(raw_item_ids) if isinstance(raw_item_ids, str) else raw_item_ids
        except Exception:
            item_ids = []

        if not item_ids and note_dict.get("item_id"):
            item_ids = [note_dict["item_id"]]

        if item_ids:
            placeholders = ",".join("?" * len(item_ids))
            rows = conn.execute(
                f"SELECT id, image_path FROM items WHERE id IN ({placeholders})",
                item_ids,
            ).fetchall()
            # 按 item_ids 顺序排列
            id_to_path = {r["id"]: r["image_path"] for r in rows}
            for iid in item_ids:
                raw_path = id_to_path.get(iid)
                if not raw_path:
                    continue
                # image_path 可能是纯文件名、assets/xxx、或绝对路径
                candidate = Path(raw_path)
                if not candidate.is_absolute():
                    # 先尝试 assets/ 目录
                    full = PROJECT_ROOT / "assets" / candidate.name
                    if not full.exists():
                        # 再尝试直接拼
                        full = PROJECT_ROOT / candidate
                else:
                    full = candidate
                if full.exists():
                    image_paths.append(str(full))
                else:
                    print(f"[警告] 图片文件不存在，跳过：{full}")

        note_dict["note_type"] = note_type
        note_dict["image_paths"] = image_paths

        # 解析 tags
        raw_tags = note_dict.get("tags", "") or ""
        if raw_tags.startswith("["):
            try:
                note_dict["tags_list"] = json.loads(raw_tags)
            except Exception:
                note_dict["tags_list"] = []
        else:
            note_dict["tags_list"] = [t.strip() for t in raw_tags.split(",") if t.strip()]

        return note_dict
    finally:
        conn.close()


def update_note_published(note_id: int, note_url: Optional[str]):
    """更新笔记发布状态"""
    import sqlite3
    db_path = PROJECT_ROOT / "data" / "app.db"
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "UPDATE notes SET status = 'published', note_url = ? WHERE id = ?",
            (note_url, note_id),
        )
        conn.commit()
    finally:
        conn.close()


# ── CLI 入口 ──────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="小红书笔记自动发布")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--note-id", type=int, help="从数据库读取笔记 ID 并发布")
    group.add_argument("--title", type=str, help="手动指定标题")
    group.add_argument("--check-login", action="store_true", help="仅检测登录状态后退出")

    parser.add_argument("--body", type=str, default="", help="正文内容")
    parser.add_argument("--tags", type=str, default="", help="话题标签，逗号分隔")
    parser.add_argument("--note-type", type=str, default="text",
                        choices=["text", "image", "video"], help="发布类型")
    parser.add_argument("--images", type=str, default="", help="图片路径，逗号分隔（image 类型）")
    parser.add_argument("--video", type=str, default="", help="视频文件路径（video 类型）")
    parser.add_argument("--headless", action="store_true", help="无头模式")
    parser.add_argument("--dry-run", action="store_true", help="仅打印参数，不实际发布")
    return parser.parse_args()


async def main():
    args = parse_args()

    # 仅检测登录状态
    if args.check_login:
        logged_in = await check_login_status(headless=True)
        print(f"LOGGED_IN:{'true' if logged_in else 'false'}")
        return

    if args.note_id:
        print(f"[发布] 从数据库加载笔记 #{args.note_id}...")
        note = load_note_from_db(args.note_id)
        title = note.get("title") or ""
        body = note.get("body") or ""
        tags = note.get("tags_list") or []
        note_type = note.get("note_type") or "text"
        image_paths = note.get("image_paths") or []
        video_path = note.get("video_path") or None

        if not title:
            print("[错误] 笔记标题为空，请先完善内容后再发布")
            sys.exit(1)
    else:
        title = args.title
        body = args.body
        tags = [t.strip() for t in args.tags.split(",") if t.strip()]
        note_type = args.note_type
        image_paths = [p.strip() for p in args.images.split(",") if p.strip()]
        video_path = args.video or None

    print("\n── 发布参数 ─────────────────────────────")
    print(f"  标题：{title}")
    print(f"  正文长度：{len(body)} 字")
    print(f"  话题标签：{tags}")
    print(f"  发布类型：{note_type}")
    if note_type == "image":
        print(f"  图片（{len(image_paths)} 张）：{image_paths}")
    elif note_type == "video":
        print(f"  视频：{video_path}")
    print(f"  无头模式：{args.headless}")
    print("──────────────────────────────────────\n")

    if args.dry_run:
        print("[dry-run] 跳过实际发布，退出")
        return

    result = await publish_note(
        title=title,
        body=body,
        tags=tags,
        note_type=note_type,
        image_paths=image_paths if note_type == "image" else None,
        video_path=video_path if note_type == "video" else None,
        headless=args.headless,
    )

    if result["success"]:
        print(f"\n✅ 发布成功！")
        if result["note_url"]:
            print(f"   笔记链接：{result['note_url']}")
        if args.note_id:
            update_note_published(args.note_id, result["note_url"])
            print(f"   数据库已更新（笔记 #{args.note_id} 状态 → published）")
    else:
        print(f"\n❌ 发布失败：{result['error']}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
