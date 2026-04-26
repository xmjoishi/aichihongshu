# 爱吃红薯（AI吃红书）

> 小红书家居/软装/装修垂类运营助手 · 代号 RN-家居类

家居/软装/装修垂类小红书运营工具，覆盖账号人设设定 → 图库管理 → 物品分析 → 笔记创作 → 发布追踪完整链路。

三种使用方式：**GUI 客户端**（日常使用）/ **CLI**（批量/自动化）/ **MCP**（AI Agent 直接调用）。

## 项目结构

```
RN-家居类/
├── app/
│   ├── server.py                 # FastAPI REST API（端口 8765）
│   ├── cli.py                    # 统一 CLI 入口
│   ├── mcp/server.py             # MCP Server（stdio 模式）
│   ├── db/                       # SQLite 建库建表
│   ├── models/                   # Pydantic 数据模型
│   └── modules/
│       ├── library/              # 图库管理 + MiniMax 图片分析
│       └── content/              # 笔记 prompt 生成 + 草稿管理
├── client/                       # Tauri + React GUI 客户端
├── crawler/
│   ├── xhs_search.py             # 关键词搜索抓取
│   ├── xhs_creator.py            # 账号主页笔记抓取
│   └── xhs_analyze.py            # 数据分析报告
├── tools/MediaCrawler/            # git submodule
├── data/                          # 运行时数据（git ignored）
├── assets/                        # 图库图片（git ignored）
├── .env.example                   # 环境变量模板
└── AGENTS.md                      # Agent 快速上手指南
```

## 初始化（首次 clone 后必做）

```bash
# 1. 初始化 submodule
git submodule update --init --recursive
cd tools/MediaCrawler && uv sync && cd ../..

# 2. 安装项目依赖
uv sync

# 3. 安装客户端依赖（使用 GUI 客户端时需要）
cd client && pnpm install && cd ..

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 MINIMAX_API_KEY（MiniMax Token Plan Key，sk-cp- 开头）

# 5. 初始化数据库
uv run python app/cli.py db init
```

## 启动

### GUI 客户端（推荐日常使用）

需要**同时**启动后端 API 和前端客户端：

```bash
# 终端 1：启动后端 API（必须先启动）
uv run python -m app.server --port 8765

# 终端 2：启动 GUI 客户端（开发模式，热重载）
cd client && pnpm tauri dev
```

客户端启动后会自动打开桌面窗口。后端 API 默认运行在 `http://localhost:8765`。

> **生产打包**：`cd client && pnpm tauri build`，产物在 `client/src-tauri/target/release/`

### 仅启动后端 API

如只需 REST API（供其他客户端或脚本调用）：

```bash
uv run python -m app.server --port 8765

# 开启热重载（开发时）
uv run python -m app.server --port 8765 --reload
```

API 文档：启动后访问 `http://localhost:8765/docs`

### MCP Server（供 OpenCode / Claude Desktop 调用）

MCP Server 由 AI 工具自动以 stdio 模式启动，无需手动运行。在配置文件中添加：

```json
{
  "mcpServers": {
    "rednote-home": {
      "command": "uv",
      "args": ["run", "--project", "/path/to/RN-家居类", "python", "-m", "app.mcp.server"],
      "cwd": "/path/to/RN-家居类"
    }
  }
}
```

配置文件位置：
- OpenCode：`~/.config/opencode/config.json`
- Claude Desktop：`~/Library/Application Support/Claude/claude_desktop_config.json`

## 标准工作流（v0.1）

```bash
# Step 0：初始化我的账号人设（首次必做）
uv run python app/cli.py profile init \
  --name "虾薯的家" \
  --niche "家居软装/出租屋改造" \
  --persona-name "虾薯" \
  --persona-bio "住出租屋也要好看，不花冤枉钱的家居研究员" \
  --persona-tone "嘴硬傲娇，短句换行，先吐槽再给结论" \
  --taboos "精致,高品质,高级感,氛围感" \
  --styles "奶油风,侘寂风" \
  --scenes "客厅,卧室,出租屋" \
  --hashtags "家居好物,软装分享,出租屋改造,装修日记"

# Step 1：录入榜样账号（手动或爬虫）
uv run python app/cli.py accounts add <account_id> \
  --name "榜样账号名" \
  --note-count 80 --avg-likes 5000 \
  --style "内容风格描述" \
  --top-notes "高赞标题1,高赞标题2"

# Step 2：导入图库物品（自动调用 MiniMax 分析）
uv run python app/cli.py library add ./my-sofa.jpg --title "奶油色布艺沙发"

# Step 3：生成笔记 Prompt
uv run python app/cli.py content draft 1 --account-id <account_id> --save
# 将输出的 prompt 粘贴给 OpenCode（或直接在当前对话中发送）生成标题/正文

# Step 4：填入生成的内容
uv run python app/cli.py content edit 1 \
  --title "买了这个沙发，朋友都以为我花了大价钱" \
  --body "正文内容..." \
  --tags "家居,沙发,客厅,奶油风,软装" \
  --status ready

# Step 5：导出发布
uv run python app/cli.py content export 1
```

## 声明

本项目中的爬虫工具（MediaCrawler）仅用于学习和研究目的，遵守 NON-COMMERCIAL LEARNING LICENSE。
禁止商业用途，请遵守小红书平台使用条款。

