# -*- coding: utf-8 -*-
"""爬虫触发接口"""

import json
import asyncio
import subprocess
import sys
import os
import signal
import tempfile
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/crawler", tags=["crawler"])

PROJECT_ROOT = Path(__file__).parent.parent.parent
MC_DIR = PROJECT_ROOT / "tools" / "MediaCrawler"
XHS_USER_DATA_DIR = MC_DIR / "browser_data" / "xhs_user_data_dir"
MC_PYTHON = MC_DIR / ".venv" / "bin" / "python"

# 全局浏览器进程状态
_browser_proc: Optional[subprocess.Popen] = None

# 文件队列路径：服务器往这里追加 URL，浏览器脚本每 0.5 秒轮询读取并清空
# 用文件队列而非 stdin pipe，服务器重启后仍可向已有浏览器发送 URL，无需 kill 浏览器
_URL_QUEUE_FILE = Path(tempfile.gettempdir()) / "xhs_browser_url_queue.txt"


class CrawlRequest(BaseModel):
    url: str
    name: Optional[str] = None
    save_db: bool = True


# ── 浏览器管理 ────────────────────────────────────────────────────────────────
#
# 关键原则：必须用 MC_PYTHON（MediaCrawler 的 .venv/bin/python）通过 Playwright API
# 来启动浏览器，不能直接 exec Chromium 二进制。
# 原因：macOS 上 Chromium cookie 用 Keychain 加密，Playwright 有自己的密钥管理；
# 直接 exec 的 Chromium 写入的 cookie 无法被 Playwright launch_persistent_context 读取。

# 内联登录浏览器脚本，由 MC_PYTHON 执行
# IPC 机制：文件队列（_URL_QUEUE_FILE），服务器重启后无需 kill 浏览器仍可通信
_LOGIN_BROWSER_SCRIPT = """\
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

USER_DATA_DIR = sys.argv[1]
INITIAL_URL = sys.argv[2] if len(sys.argv) > 2 else "https://creator.xiaohongshu.com/new/home"
QUEUE_FILE = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("/tmp/xhs_browser_url_queue.txt")

# 启动时清空队列，避免重启后把旧 URL 重新打开
QUEUE_FILE.write_text("", encoding="utf-8")


async def _poll_queue(context):
    \"\"\"每 0.5 秒轮询队列文件，有 URL 就在浏览器中打开。\"\"\"
    while True:
        await asyncio.sleep(0.5)
        try:
            lines = QUEUE_FILE.read_text(encoding="utf-8").splitlines()
            pending = [l.strip() for l in lines if l.strip().startswith("http")]
            if not pending:
                continue
            QUEUE_FILE.write_text("", encoding="utf-8")  # 清空已读
            for url in pending:
                try:
                    # 复用空白页，避免留下 about:blank 标签
                    blank = next((p for p in context.pages if p.url in ("about:blank", "")), None)
                    page = blank or await context.new_page()
                    await page.bring_to_front()
                    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                except Exception:
                    pass
        except Exception:
            pass


async def main():
    args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run", "--no-default-browser-check", "--disable-infobars",
    ]
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=False,
            args=args,
            viewport={"width": 1280, "height": 900},
            locale="zh-CN",
        )
        # 优先复用已有空白页，避免出现多余的 about:blank 标签
        existing_pages = context.pages
        page = existing_pages[0] if existing_pages else await context.new_page()
        await page.goto(INITIAL_URL, wait_until="domcontentloaded", timeout=30000)

        # 同时等待队列轮询 和 浏览器关闭
        await asyncio.gather(
            _poll_queue(context),
            context.wait_for_event("close", timeout=0),
            return_exceptions=True,
        )

asyncio.run(main())
"""


def _get_python() -> str:
    return str(MC_PYTHON) if MC_PYTHON.exists() else sys.executable


def _write_login_script() -> str:
    p = Path(tempfile.gettempdir()) / "xhs_login_browser.py"
    p.write_text(_LOGIN_BROWSER_SCRIPT, encoding="utf-8")
    return str(p)


def _is_browser_running() -> bool:
    """检查浏览器进程是否仍在运行（兼容服务器重启后句柄丢失的情况）。"""
    global _browser_proc
    if _browser_proc and _browser_proc.poll() is None:
        return True
    # 服务器重启后句柄为 None：通过 pgrep 检查 Chromium 是否还在用 user_data_dir
    try:
        result = subprocess.run(
            ["pgrep", "-f", f"user-data-dir={XHS_USER_DATA_DIR}"],
            capture_output=True, timeout=2,
        )
        return result.returncode == 0
    except Exception:
        return False


def _send_url_to_browser(url: str) -> bool:
    """将 URL 追加到文件队列，浏览器脚本在下次轮询（≤0.5s）时打开它。"""
    if not _is_browser_running():
        return False
    try:
        with open(_URL_QUEUE_FILE, "a", encoding="utf-8") as f:
            f.write(url + "\n")
        return True
    except Exception:
        return False


def _clear_singleton_lock() -> None:
    """删除 Chromium 遗留的 Singleton 锁文件（仅在确认无进程运行时调用）。"""
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try:
            f = XHS_USER_DATA_DIR / name
            if f.exists():
                f.unlink()
        except Exception:
            pass


@router.post("/browser")
def api_open_browser():
    """用 Playwright Chromium 打开创作者中心（与发布脚本共享 cookie）"""
    global _browser_proc

    if _is_browser_running():
        pid = _browser_proc.pid if (_browser_proc and _browser_proc.poll() is None) else None
        return {"status": "running", "pid": pid}

    XHS_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    _clear_singleton_lock()
    script = _write_login_script()

    _browser_proc = subprocess.Popen(
        [_get_python(), script, str(XHS_USER_DATA_DIR),
         "https://creator.xiaohongshu.com/new/home", str(_URL_QUEUE_FILE)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid,
    )
    return {"status": "launched", "pid": _browser_proc.pid}


@router.delete("/browser")
def api_close_browser():
    """关闭登录浏览器"""
    global _browser_proc
    if not _browser_proc or _browser_proc.poll() is not None:
        _browser_proc = None
        return {"status": "not_running"}
    try:
        pgid = os.getpgid(_browser_proc.pid)
        os.killpg(pgid, signal.SIGTERM)
    except Exception:
        _browser_proc.terminate()
    _browser_proc = None
    return {"status": "closed"}


@router.get("/browser")
def api_browser_status():
    """查询登录浏览器状态"""
    running = _is_browser_running()
    if not running:
        return {"running": False}
    pid = _browser_proc.pid if (_browser_proc and _browser_proc.poll() is None) else None
    return {"running": True, "pid": pid}


class OpenUrlRequest(BaseModel):
    url: str


@router.post("/open-url")
def api_open_url(body: OpenUrlRequest):
    """在小红书浏览器中打开指定 URL。
    若浏览器已运行（包括服务器重启后），通过文件队列发送 URL；
    否则启动新浏览器并打开该 URL。
    """
    url = body.url
    if not url.startswith("http"):
        raise HTTPException(400, "URL 必须以 http 开头")

    # 优先通过文件队列在已有浏览器里开新标签
    if _send_url_to_browser(url):
        return {"status": "opened_in_existing", "url": url}

    # 浏览器未运行，启动新浏览器
    global _browser_proc
    XHS_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    _clear_singleton_lock()
    script = _write_login_script()

    proc = subprocess.Popen(
        [_get_python(), script, str(XHS_USER_DATA_DIR), url, str(_URL_QUEUE_FILE)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid,
    )
    _browser_proc = proc
    return {"status": "launched", "url": url}


# ── 爬虫导入 ──────────────────────────────────────────────────────────────────

async def _crawl_and_stream(url: str, name: str, save_db: bool):
    """调起 xhs_creator.py 子进程，实时 pipe stdout 到 SSE"""

    def sse(msg: str, done: bool = False, error: bool = False, **extra):
        payload = {"message": msg, "done": done}
        if error:
            payload["error"] = msg
        payload.update(extra)
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    cmd = [
        "/usr/local/bin/uv", "run",
        "--project", str(PROJECT_ROOT),
        "python", str(PROJECT_ROOT / "crawler" / "xhs_creator.py"),
        "--url", url,
        "--save-db",
    ]
    if name:
        cmd += ["--name", name]

    yield sse("启动爬虫，首次运行需在浏览器中扫码登录...")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(PROJECT_ROOT),
        )

        result_data: dict = {}
        async for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").rstrip()
            if not line:
                continue
            if line.startswith("RESULT_JSON:"):
                try:
                    result_data = json.loads(line[len("RESULT_JSON:"):]) or {}
                except Exception:
                    pass
                continue
            yield sse(line)

        await proc.wait()

        if proc.returncode == 0:
            extra: dict = {}
            if result_data.get("nickname"):
                extra["nickname"] = result_data["nickname"]
            if result_data.get("account_id"):
                extra["account_id"] = result_data["account_id"]
            yield sse("导入完成", done=True, **extra)
        else:
            yield sse(f"爬虫退出码 {proc.returncode}，请检查上方日志", done=True)

    except Exception as e:
        yield sse(f"启动失败：{e}", done=True, error=True)


@router.post("/creator")
async def api_crawl_creator(body: CrawlRequest):
    """调起爬虫抓取创作者数据，SSE 推流进度"""
    return StreamingResponse(
        _crawl_and_stream(body.url, body.name or "", body.save_db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
