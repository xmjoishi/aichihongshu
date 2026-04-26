# -*- coding: utf-8 -*-
"""
FastAPI Server — 爱吃红薯（AI吃红书）后端

运行模式：
  REST API 模式（供 Tauri 客户端）：
      uv run python -m app.server
      uv run python -m app.server --port 8765

  MCP stdio 模式（供 OpenCode / ClaudeCode）：
      uv run python -m app.mcp.server
"""

import argparse
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.db.connection import init_db
from app.routers import (
    library, content, profile, accounts, analytics, ai, crawler,
    settings, knowledge, accounts_pool,
)

# ── 初始化 ──────────────────────────────────────────────────────────────────
init_db()

app = FastAPI(
    title="RedNote Home Assistant",
    description="小红书家居垂类运营助手 API",
    version="0.1.0",
)

# CORS（开发时允许 Tauri webview / localhost 访问）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 路由挂载 ────────────────────────────────────────────────────────────────
app.include_router(library.router)
app.include_router(content.router)
app.include_router(profile.router)
app.include_router(accounts.router)
app.include_router(analytics.router)
app.include_router(ai.router)
app.include_router(crawler.router)
app.include_router(settings.router)
app.include_router(knowledge.router)
app.include_router(accounts_pool.router)


# ── 静态资源（图库图片）────────────────────────────────────────────────────
_ASSETS_DIR = Path(__file__).parent.parent / "assets"
_ASSETS_DIR.mkdir(exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(_ASSETS_DIR)), name="assets")


# ── 健康检查 ────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "service": "rednote-home"}


@app.get("/")
def root():
    return {
        "service": "RedNote Home Assistant",
        "docs": "/docs",
        "openapi": "/openapi.json",
    }


# ── 主入口 ──────────────────────────────────────────────────────────────────
def main():
    import uvicorn

    parser = argparse.ArgumentParser(description="RedNote Home Assistant Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reload", action="store_true", help="开发模式热重载")
    args = parser.parse_args()

    print(f"[server] 启动 REST API 服务 http://{args.host}:{args.port}")
    print(f"[server] API 文档：http://{args.host}:{args.port}/docs")
    uvicorn.run(
        "app.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
