# AGENTS.md

## 项目定位
**爱吃红薯**（AI吃红书）—— 小红书家居/软装/装修垂类运营助手（仓库代号 RN-家居类）。三位一体架构：**CLI**（快速操作）+ **Tauri 客户端**（图形界面）+ **MCP Server**（AI Agent 直接调用）。

## 架构概览
```
CLI (app/cli.py)          ← 终端操作，适合批量/自动化
FastAPI (app/server.py)   ← REST API，Tauri 客户端连接此服务
MCP (app/mcp/server.py)   ← OpenCode/ClaudeCode 通过 MCP 协议调用
Tauri (client/)           ← React GUI 客户端，连接 FastAPI
共享：SQLite (data/app.db) + assets/ 图库
```

## 关键目录
- `app/server.py` — FastAPI REST API 入口（端口 8765）
- `app/routers/` — REST API 路由（library / content / profile / accounts / analytics / ai / crawler / settings / knowledge）
- `app/mcp/server.py` — MCP Server（14 个 tools，stdio 模式）
- `app/cli.py` — CLI 入口（保留，与 API 共享业务模块）
- `client/` — Tauri + React 客户端（pnpm 管理）
- `crawler/` — 爬虫封装脚本，**从项目根目录运行**（不要 cd 进去）
- `crawler/xhs_publish.py` — Playwright 自动发布脚本（必须用 MC_PYTHON 运行）
- `tools/MediaCrawler/` — git submodule，不要直接修改其代码
- `data/app.db` — SQLite 数据库，已 git ignore
- `assets/` — 图库图片，已 git ignore（只有 `.gitkeep` 入库）

## 日志位置
```
/tmp/rn-server.log          ← FastAPI 后端服务日志
/tmp/xhs_publish_uploads/   ← 自动发布截图（before_publish.png / publish_error.png 等）
```
查看日志命令：
```bash
tail -f /tmp/rn-server.log
ls /tmp/xhs_publish_uploads/
# 发布任务状态（替换 note_id 和 job_id）
curl -s "http://localhost:8765/api/content/<note_id>/publish-status/<job_id>" | python3 -m json.tool
```

## 启动服务
```bash
# REST API 服务（标准启动，日志写入 /tmp/rn-server.log）
nohup uv run python -m app.server --port 8765 > /tmp/rn-server.log 2>&1 &
# 热重载开发模式
uv run python -m app.server --port 8765 --reload

# 重启服务（修改后端代码后必须执行）
pkill -f "app.server" && sleep 1 && nohup uv run python -m app.server --port 8765 > /tmp/rn-server.log 2>&1 &

# Tauri 客户端开发模式（需先启动 FastAPI server）
cd client && pnpm tauri dev

# MCP Server（stdio 模式，由 OpenCode/ClaudeCode 自动调用）
uv run python -m app.mcp.server
```

## MCP Server 配置（OpenCode / ClaudeCode）
在 `~/.config/opencode/config.json` 或 `claude_desktop_config.json` 中添加：
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
可用 MCP Tools（14 个）：
`get_profile` `update_profile` `list_items` `get_item` `add_item_from_path` `tag_item`
`draft_note_prompt` `list_notes` `get_note` `save_note` `publish_note` `export_note`
`list_accounts` `get_analytics`

## 环境初始化（新 clone 后必须执行）
```bash
git submodule update --init --recursive
# MediaCrawler 自有依赖
cd tools/MediaCrawler && uv sync && cd ../..
# 项目自身依赖（openai / click / rich / pydantic 等）
uv sync
# 配置环境变量
cp .env.example .env   # 然后填入 MINIMAX_API_KEY
# 初始化数据库
uv run python app/cli.py db init
```
两套 `uv` 环境互相独立：项目根的 `.venv` 和 `tools/MediaCrawler/.venv` 分开管理。

## 常用命令

```bash
# Step 0：初始化我的账号人设（首次必做）
# 推荐：提供账号 URL，爬虫抓取后 AI 自动推断
uv run python app/cli.py profile init \
    --url "https://www.xiaohongshu.com/user/profile/<我的账号ID>?xsec_token=..."
# 推断完成后，补充爬虫无法获取的字段（人设名、简介等）
uv run python app/cli.py profile edit \
    --persona-name "虾薯" --persona-bio "住出租屋也要好看的家居研究员"
# 如需覆盖 AI 推断的字段（语气/禁忌词），用 profile edit 修正
uv run python app/cli.py profile edit \
    --persona-tone "嘴硬傲娇，短句换行，先吐槽再给结论" \
    --taboos "精致,高品质,高级感,氛围感"
# 或完全手动填写（无账号URL时）：
# uv run python app/cli.py profile init \
#     --name "账号显示名" --niche "家居软装/出租屋改造" \
#     --persona-name "虾薯" --persona-bio "..." \
#     --persona-tone "..." --taboos "精致,高品质"
uv run python app/cli.py profile show
uv run python app/cli.py profile edit --followers 1000  # 更新单个字段

# 榜样账号（对标竞品，用于学习风格）
uv run python app/cli.py accounts add <account_id> --name "账号名" \
    --note-count 80 --avg-likes 5000 --avg-comments 150 --avg-collects 1200 \
    --style "内容风格描述" \
    --top-notes "高赞标题1,高赞标题2,高赞标题3"
uv run python app/cli.py accounts list
uv run python app/cli.py accounts show <account_id>
uv run python app/cli.py accounts delete <account_id>

# 图库
uv run python app/cli.py library add <图片路径> --title "物品名"   # 导入并 MiniMax 分析
uv run python app/cli.py library list
uv run python app/cli.py library show <id>
uv run python app/cli.py library tag <id> --add <标签>

# 内容创作（生成 prompt，粘贴给 Agent）
uv run python app/cli.py content draft <item_id> [--account-id <account_id>] [--save]
uv run python app/cli.py content list
uv run python app/cli.py content edit <note_id> --title "标题" --body "正文" --tags "家居,软装"
uv run python app/cli.py content export <note_id>

# 爬虫（从项目根运行，需要浏览器扫码登录）
python crawler/xhs_search.py --keywords "家居,软装,装修" --count 20
python crawler/xhs_analyze.py --input data/crawl/xxx.json --save-db
python crawler/xhs_creator.py --url "https://www.xiaohongshu.com/user/profile/<id>?xsec_token=..." --name "账号名" --save-db
```

## MediaCrawler 关键细节
- `xhs_search.py` / `xhs_creator.py` 通过 `patch_config()` 在运行时动态覆盖配置，**不要手动改 `tools/MediaCrawler/config/`**
- 默认 `ENABLE_CDP_MODE = False`（Playwright 模式，扫码登录），登录态缓存在 `tools/MediaCrawler/browser_data/`
- 爬虫原始 CSV 在 `tools/MediaCrawler/data/xhs/`，脚本会读取最新一个
- `patch_config()` 必须同时修改 `config.base_config` 和 `import config as cfg` 两个命名空间，因为 `config/__init__` 做的是值复制而非引用
- `store/xhs/__init__.py` 的 `save_creator` 接收的是原始 camelCase `userPageData`；`interactions[].count` 可能是字符串或"1.2万"格式，不能直接当 int 用，需 `safe_count()` 处理
- URL 里的 `/profile/<ID>` 与小红书实际 `user_id` 可能不同，爬虫捕获到的 `creator_info.user_id` 才是真实 ID
- `xsec_token` 只有在浏览器内从搜索结果点击进入主页后地址栏才会带，直接输入 URL 不会有

## MiniMax 接入
- Token Plan 图片分析：使用 `/v1/coding_plan/vlm` 原生接口（与 MCP `understand_image` 相同底层）
- Anthropic/OpenAI 兼容接口**不支持图片输入**，仅用于文本生成
- 图片传入方式：base64 data URL inline（不上传外部存储）
- `.env` 中 `MINIMAX_BASE_URL` 填 Anthropic 兼容地址，图片分析走 `https://api.minimaxi.com` 固定地址

## 数据库 Schema（SQLite）
5 张表：`items`（图库物品）/ `reference_accounts`（榜样账号）/ `notes`（笔记草稿）/ `crawl_logs`（抓取记录）/ `my_profile`（我的账号人设，单行 id=1）
DB 文件：`data/app.db`

### items 关键字段
- `image_path`：**只存文件名**（如 `tmpjimgk7z6.jpeg`），实际文件在 `assets/` 目录
- 拼完整路径：`PROJECT_ROOT / "assets" / image_path`（xhs_publish.py 和 ai.py 里均按此处理）
- `analysis_raw`：MiniMax VLM 分析的图片描述文本，AI chat 时需注入 system prompt

### my_profile 关键字段
查询时必须显式 SELECT 需要的字段，`summary` 接口等处**不能只取统计字段**，否则 `persona_name` 等人设字段会丢失：
```sql
SELECT followers, total_notes, avg_likes, avg_comments, avg_collects,
       persona_name, niche, display_name
FROM my_profile WHERE id=1
```

### notes 时间字段说明
- `published_at`：笔记在小红书的真实发布时间（爬虫抓取写入，毫秒时间戳 → ISO 格式）
- `created_at`：记录导入本地数据库的时间（爬虫批量导入时所有笔记 created_at 相同）
- **趋势图等统计应用 `published_at`，不要用 `created_at`**
- `note_type`：`text`（文字配图）/ `image`（图文多图）/ `video`（视频），默认 `text`
- `item_ids`：JSON 数组，多图笔记关联的图库 item id 列表

## 自动发布架构
```
前端 → POST /api/content/{note_id}/publish-auto
     → 后台线程运行 xhs_publish.py（MC_PYTHON）
     → GET /api/content/{note_id}/publish-status/{job_id}（前端每3秒轮询）
```

### 发布前登录检测
- `GET /api/content/xhs-login-status` — 调用 `xhs_publish.py --check-login`，返回 `{"logged_in": bool}`
- 前端发布前必须先调此接口；未登录直接报错提示用户去设置页登录
- 登录检测路由必须在 `/{note_id}` 参数路由**之前**注册，否则 FastAPI 会把 `xhs-login-status` 当 note_id 解析

### Playwright 登录态关键原则（macOS）
**必须用 `tools/MediaCrawler/.venv/bin/python`（MC_PYTHON）通过 Playwright API 打开浏览器**，不能直接 exec Chromium 二进制。

原因：macOS 上 Chromium cookie 用 Keychain 加密。直接 exec 的系统 Chromium 写入的 cookie，Playwright `launch_persistent_context` 无法读取（加密密钥不同）。

正确流程：
1. 设置页「打开浏览器」→ 后端用 MC_PYTHON 运行内联脚本，`launch_persistent_context` 打开浏览器
2. 用户在浏览器扫码登录创作者中心
3. **关闭浏览器窗口**（让 Playwright 写回 session 到磁盘，释放 user_data_dir 锁）
4. 发布时 `xhs_publish.py` 用同一 MC_PYTHON + 同一 `user_data_dir` → cookie 共享

### xhs_publish.py 图片路径处理
- DB 中 `image_path` 只存文件名，需拼接 `assets/` 前缀
- 代码中先尝试 `PROJECT_ROOT / "assets" / filename`，找不到再尝试 `PROJECT_ROOT / raw_path`

## 工作流（v0.1 标准路径）
```
1. 初始化我的账号人设（profile init）← 首次必做，影响所有笔记的语气和禁忌词
2. 初始化榜样账号（accounts add 手动录入，或 xhs_creator.py --save-db 爬虫抓取）
3. 导入图库图片（library add）→ MiniMax 自动分析
4. 生成笔记 prompt（content draft <item_id> --account-id <ref>）
5. 将 prompt 交给 Agent（OpenCode 对话）生成标题/正文
6. 填入内容（content edit <note_id>）
7. 导出 Markdown 准备发布（content export <note_id>）
```

## 不要做的事
- 不要在 `tools/MediaCrawler/` 内直接运行 `python main.py`——配置未经 `patch_config` 注入
- 不要提交 `data/` / `assets/` 下的任何用户数据文件
- MediaCrawler 仅限学习/研究用途，禁止商业化使用
- 不要把 `.env` 提交到 git（已在 .gitignore）
- **修改后端代码后必须重启服务**：
  ```bash
  pkill -f "app.server" && sleep 1 && nohup uv run python -m app.server --port 8765 > /tmp/rn-server.log 2>&1 &
  ```
- 不要直接 exec Playwright Chromium 二进制打开浏览器（会导致 cookie 不兼容）

## 前端开发注意事项
- Dashboard 布局用 `max-w-4xl mx-auto` 才能全屏居中，单用 `max-w-4xl` 会居左
- Dashboard 人设 banner 有两种状态：已设置 → 红色渐变卡片；未设置 → 虚线边框引导卡片
- 建议行动色彩规范：红色=阻塞项（人设未设置）、琥珀色=建议项（未出稿/久未发布）、灰色=提醒项（有草稿）
- `analytics/summary` 返回的 `suggestions` 字段包含：`items_without_notes`（未出稿图库数）、`days_since_publish`（距上次发布天数）、`draft_count`（草稿数），可用于看板行动引导
- 趋势图数据来自 `analytics/notes-trend`，返回 `{ granularity, items }`，数据点 >14 时自动按周聚合
- 笔记列表已发 tab 切换时自动切 `published_desc` 排序（`handleStatusChange` 函数）
- FastAPI 路由注册顺序影响匹配：固定路径（如 `/xhs-login-status`）必须在参数路径（如 `/{note_id}`）前注册

## 运营 Skill
项目配套 `xiaohongshu-ops` skill（安装在 `~/.config/opencode/skills/xiaohongshu-ops/`）。
内容策略、发布流程参考该 skill 的 `references/` 目录；所有对外文案遵循 `persona.md`（虾薯人设，傲娇嘴硬风）。

## 项目定位
**爱吃红薯**（AI吃红书）—— 小红书家居/软装/装修垂类运营助手（仓库代号 RN-家居类）。三位一体架构：**CLI**（快速操作）+ **Tauri 客户端**（图形界面）+ **MCP Server**（AI Agent 直接调用）。

## 架构概览
```
CLI (app/cli.py)          ← 终端操作，适合批量/自动化
FastAPI (app/server.py)   ← REST API，Tauri 客户端连接此服务
MCP (app/mcp/server.py)   ← OpenCode/ClaudeCode 通过 MCP 协议调用
Tauri (client/)           ← React GUI 客户端，连接 FastAPI
共享：SQLite (data/app.db) + assets/ 图库
```

## 关键目录
- `app/server.py` — FastAPI REST API 入口（端口 8765）
- `app/routers/` — REST API 路由（library / content / profile / accounts / analytics）
- `app/mcp/server.py` — MCP Server（14 个 tools，stdio 模式）
- `app/cli.py` — CLI 入口（保留，与 API 共享业务模块）
- `client/` — Tauri + React 客户端（pnpm 管理）
- `crawler/` — 爬虫封装脚本，**从项目根目录运行**（不要 cd 进去）
- `tools/MediaCrawler/` — git submodule，不要直接修改其代码
- `data/app.db` — SQLite 数据库，已 git ignore
- `assets/` — 图库图片，已 git ignore（只有 `.gitkeep` 入库）

## 启动服务
```bash
# REST API 服务（Tauri 客户端需要先启动此服务）
uv run python -m app.server
# 或指定端口 + 热重载
uv run python -m app.server --port 8765 --reload

# Tauri 客户端开发模式（需先启动 FastAPI server）
cd client && pnpm tauri dev

# MCP Server（stdio 模式，由 OpenCode/ClaudeCode 自动调用）
uv run python -m app.mcp.server
```

## MCP Server 配置（OpenCode / ClaudeCode）
在 `~/.config/opencode/config.json` 或 `claude_desktop_config.json` 中添加：
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
可用 MCP Tools（14 个）：
`get_profile` `update_profile` `list_items` `get_item` `add_item_from_path` `tag_item`
`draft_note_prompt` `list_notes` `get_note` `save_note` `publish_note` `export_note`
`list_accounts` `get_analytics`

## 环境初始化（新 clone 后必须执行）
```bash
git submodule update --init --recursive
# MediaCrawler 自有依赖
cd tools/MediaCrawler && uv sync && cd ../..
# 项目自身依赖（openai / click / rich / pydantic 等）
uv sync
# 配置环境变量
cp .env.example .env   # 然后填入 MINIMAX_API_KEY
# 初始化数据库
uv run python app/cli.py db init
```
两套 `uv` 环境互相独立：项目根的 `.venv` 和 `tools/MediaCrawler/.venv` 分开管理。

## 常用命令

```bash
# Step 0：初始化我的账号人设（首次必做）
# 推荐：提供账号 URL，爬虫抓取后 AI 自动推断
uv run python app/cli.py profile init \
    --url "https://www.xiaohongshu.com/user/profile/<我的账号ID>?xsec_token=..."
# 推断完成后，补充爬虫无法获取的字段（人设名、简介等）
uv run python app/cli.py profile edit \
    --persona-name "虾薯" --persona-bio "住出租屋也要好看的家居研究员"
# 如需覆盖 AI 推断的字段（语气/禁忌词），用 profile edit 修正
uv run python app/cli.py profile edit \
    --persona-tone "嘴硬傲娇，短句换行，先吐槽再给结论" \
    --taboos "精致,高品质,高级感,氛围感"
# 或完全手动填写（无账号URL时）：
# uv run python app/cli.py profile init \
#     --name "账号显示名" --niche "家居软装/出租屋改造" \
#     --persona-name "虾薯" --persona-bio "..." \
#     --persona-tone "..." --taboos "精致,高品质"
uv run python app/cli.py profile show
uv run python app/cli.py profile edit --followers 1000  # 更新单个字段

# 榜样账号（对标竞品，用于学习风格）
uv run python app/cli.py accounts add <account_id> --name "账号名" \
    --note-count 80 --avg-likes 5000 --avg-comments 150 --avg-collects 1200 \
    --style "内容风格描述" \
    --top-notes "高赞标题1,高赞标题2,高赞标题3"
uv run python app/cli.py accounts list
uv run python app/cli.py accounts show <account_id>
uv run python app/cli.py accounts delete <account_id>

# 图库
uv run python app/cli.py library add <图片路径> --title "物品名"   # 导入并 MiniMax 分析
uv run python app/cli.py library list
uv run python app/cli.py library show <id>
uv run python app/cli.py library tag <id> --add <标签>

# 内容创作（生成 prompt，粘贴给 Agent）
uv run python app/cli.py content draft <item_id> [--account-id <account_id>] [--save]
uv run python app/cli.py content list
uv run python app/cli.py content edit <note_id> --title "标题" --body "正文" --tags "家居,软装"
uv run python app/cli.py content export <note_id>

# 爬虫（从项目根运行，需要浏览器扫码登录）
python crawler/xhs_search.py --keywords "家居,软装,装修" --count 20
python crawler/xhs_analyze.py --input data/crawl/xxx.json --save-db
python crawler/xhs_creator.py --url "https://www.xiaohongshu.com/user/profile/<id>?xsec_token=..." --name "账号名" --save-db
```

## MediaCrawler 关键细节
- `xhs_search.py` / `xhs_creator.py` 通过 `patch_config()` 在运行时动态覆盖配置，**不要手动改 `tools/MediaCrawler/config/`**
- 默认 `ENABLE_CDP_MODE = False`（Playwright 模式，扫码登录），登录态缓存在 `tools/MediaCrawler/browser_data/`
- 爬虫原始 CSV 在 `tools/MediaCrawler/data/xhs/`，脚本会读取最新一个
- `patch_config()` 必须同时修改 `config.base_config` 和 `import config as cfg` 两个命名空间，因为 `config/__init__` 做的是值复制而非引用
- `store/xhs/__init__.py` 的 `save_creator` 接收的是原始 camelCase `userPageData`；`interactions[].count` 可能是字符串或"1.2万"格式，不能直接当 int 用，需 `safe_count()` 处理
- URL 里的 `/profile/<ID>` 与小红书实际 `user_id` 可能不同，爬虫捕获到的 `creator_info.user_id` 才是真实 ID
- `xsec_token` 只有在浏览器内从搜索结果点击进入主页后地址栏才会带，直接输入 URL 不会有

## MiniMax 接入
- Token Plan 图片分析：使用 `/v1/coding_plan/vlm` 原生接口（与 MCP `understand_image` 相同底层）
- Anthropic/OpenAI 兼容接口**不支持图片输入**，仅用于文本生成
- 图片传入方式：base64 data URL inline（不上传外部存储）
- `.env` 中 `MINIMAX_BASE_URL` 填 Anthropic 兼容地址，图片分析走 `https://api.minimaxi.com` 固定地址

## 数据库 Schema（SQLite）
5 张表：`items`（图库物品）/ `reference_accounts`（榜样账号）/ `notes`（笔记草稿）/ `crawl_logs`（抓取记录）/ `my_profile`（我的账号人设，单行 id=1）
DB 文件：`data/app.db`

### my_profile 关键字段
查询时必须显式 SELECT 需要的字段，`summary` 接口等处**不能只取统计字段**，否则 `persona_name` 等人设字段会丢失：
```sql
SELECT followers, total_notes, avg_likes, avg_comments, avg_collects,
       persona_name, niche, display_name
FROM my_profile WHERE id=1
```

### notes 时间字段说明
- `published_at`：笔记在小红书的真实发布时间（爬虫抓取写入，毫秒时间戳 → ISO 格式）
- `created_at`：记录导入本地数据库的时间（爬虫批量导入时所有笔记 created_at 相同）
- **趋势图等统计应用 `published_at`，不要用 `created_at`**

## 工作流（v0.1 标准路径）
```
1. 初始化我的账号人设（profile init）← 首次必做，影响所有笔记的语气和禁忌词
2. 初始化榜样账号（accounts add 手动录入，或 xhs_creator.py --save-db 爬虫抓取）
3. 导入图库图片（library add）→ MiniMax 自动分析
4. 生成笔记 prompt（content draft <item_id> --account-id <ref>）
5. 将 prompt 交给 Agent（OpenCode 对话）生成标题/正文
6. 填入内容（content edit <note_id>）
7. 导出 Markdown 准备发布（content export <note_id>）
```

## 不要做的事
- 不要在 `tools/MediaCrawler/` 内直接运行 `python main.py`——配置未经 `patch_config` 注入
- 不要提交 `data/` / `assets/` 下的任何用户数据文件
- MediaCrawler 仅限学习/研究用途，禁止商业化使用
- 不要把 `.env` 提交到 git（已在 .gitignore）
- **修改后端代码后必须重启服务**，FastAPI 默认不热重载（除非加 `--reload`）：
  ```bash
  pkill -f "app.server" && uv run python -m app.server --port 8765 &
  ```

## 前端开发注意事项
- Dashboard 布局用 `max-w-4xl mx-auto` 才能全屏居中，单用 `max-w-4xl` 会居左
- Dashboard 人设 banner 有两种状态：已设置 → 红色渐变卡片；未设置 → 虚线边框引导卡片
- 建议行动色彩规范：红色=阻塞项（人设未设置）、琥珀色=建议项（未出稿/久未发布）、灰色=提醒项（有草稿）
- `analytics/summary` 返回的 `suggestions` 字段包含：`items_without_notes`（未出稿图库数）、`days_since_publish`（距上次发布天数）、`draft_count`（草稿数），可用于看板行动引导
- 趋势图数据来自 `analytics/notes-trend`，返回 `{ granularity, items }`，数据点 >14 时自动按周聚合

## 运营 Skill
项目配套 `xiaohongshu-ops` skill（安装在 `~/.config/opencode/skills/xiaohongshu-ops/`）。
内容策略、发布流程参考该 skill 的 `references/` 目录；所有对外文案遵循 `persona.md`（虾薯人设，傲娇嘴硬风）。
