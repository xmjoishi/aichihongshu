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
_LOGIN_BROWSER_SCRIPT = """\
import asyncio, sys
from playwright.async_api import async_playwright

USER_DATA_DIR = sys.argv[1]
URL = sys.argv[2] if len(sys.argv) > 2 else "https://www.xiaohongshu.com/user/profile"

async def main():
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=False,
            args=["--disable-blink-features=AutomationControlled",
                  "--no-first-run", "--no-default-browser-check",
                  "--disable-infobars", "--excludeSwitches=enable-automation"],
            viewport={"width": 1280, "height": 900},
            locale="zh-CN",
        )
        page = await context.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        # 保持浏览器开着，等用户手动关闭
        await context.wait_for_event("close", timeout=0)

asyncio.run(main())
"""


def _get_python() -> str:
    return str(MC_PYTHON) if MC_PYTHON.exists() else sys.executable


def _write_login_script() -> str:
    p = Path(tempfile.gettempdir()) / "xhs_login_browser.py"
    p.write_text(_LOGIN_BROWSER_SCRIPT, encoding="utf-8")
    return str(p)


@router.post("/browser")
def api_open_browser():
    """用 Playwright Chromium 打开小红书个人中心（与发布脚本共享 cookie 加密密钥）"""
    global _browser_proc

    if _browser_proc and _browser_proc.poll() is None:
        return {"status": "running", "pid": _browser_proc.pid}

    XHS_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    script = _write_login_script()

    _browser_proc = subprocess.Popen(
        [_get_python(), script, str(XHS_USER_DATA_DIR),
         "https://creator.xiaohongshu.com/new/home"],
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
    global _browser_proc
    if _browser_proc and _browser_proc.poll() is None:
        return {"running": True, "pid": _browser_proc.pid}
    _browser_proc = None
    return {"running": False}


class OpenUrlRequest(BaseModel):
    url: str


@router.post("/open-url")
def api_open_url(body: OpenUrlRequest):
    """用 Playwright Chromium 打开指定 URL（与发布脚本共享 cookie 加密密钥）"""
    url = body.url
    if not url.startswith("http"):
        raise HTTPException(400, "URL 必须以 http 开头")

    global _browser_proc
    if _browser_proc and _browser_proc.poll() is None:
        return {"status": "already_running", "url": url, "pid": _browser_proc.pid}

    XHS_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    script = _write_login_script()

    proc = subprocess.Popen(
        [_get_python(), script, str(XHS_USER_DATA_DIR), url],
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
