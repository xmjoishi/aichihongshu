# Changelog

记录 **爱吃红薯（AI吃红书）** 各版本的核心变更与升级路径。

格式约定：每个版本下分「亮点 / Schema 变更 / 迁移路径 / 兼容性」四块，方便老用户拉取代码后对照执行。

---

## v0.3.1 — 榜样账号按运营账号隔离 + Sidebar 菜单重排（2026-04-26, commit `aa80272`）

### 亮点
- 榜样账号（`reference_accounts`）成为「运营账号上下文」的一部分。切换顶栏激活账号后，看板/榜样列表/数据分析/AI 引用上下文全部跟着切。
- Sidebar 菜单按「账号上下文 vs 全局」分组：顶部=看板/图库/笔记/灵感/数据/榜样/账号；中间一根细分隔线；底部=账号池/设置。

### Schema 变更
- `reference_accounts` 加 `account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE CASCADE`。
- UNIQUE 由 `(account_id)` 改为复合 `(account_pool_id, account_id)`：同一榜样可被多个运营账号关注，但每个账号下不重复。

### 迁移路径
- 升级时自动跑 `_migrate_v031_reference_accounts`：ALTER 加列 → 把所有现存榜样回填到当前激活的 operation 账号 → 重建表换 UNIQUE。
- 迁移前会备份到 `/tmp/app.db.before-v031`。
- 启动日志会打印：
  ```
  [db] backfill reference_accounts.account_pool_id=1（N 行）
  [db] reference_accounts 已升级为多账号隔离模式
  ```

### 兼容性
- `build_knowledge_ctx(conn, account_pool_id=None)`：参数可选，默认不过滤，向后兼容。
- 全部 router/CLI/MCP/crawler 都已加 `account_pool_id` 过滤，写入时也会带上。
- 切账号后前端会自动 invalidate `accounts/analytics/knowledge` query。

---

## v0.3 — 多账号架构升级（2026-04-26, commit `f4c41b6`）

### 亮点
- 单账号 → 多账号架构。引入「账号池」概念，区分两种角色：
  - **operation**（运营号）：可发笔记、能成为顶栏激活的「当前账号上下文」。
  - **assistant**（辅助号）：只用于爬虫抓数据，**不能**激活成上下文（service 层强制拒绝）。
- 顶栏新增 `ActiveAccountSwitcher`，所有页面（图库 / 笔记 / 灵感 / 数据 / 人设 / 知识库）随之切换。
- 浏览器入口下沉到账号池卡片，按账号 `user_data_dir` 独立进程，登录态互不干扰。
- 删除「主号保护」总开关，改用按角色固定的权限矩阵。

### Schema 变更
- 新增 `account_pool`：`id / alias / role / user_data_dir / xhs_user_id / display_name / followers / status / ban_count / last_used_at / notes`。
- `app_settings` 新增 key `active_account_id` 记录当前激活账号。
- `items / notes / my_profile / crawl_logs` 全部加 `account_pool_id` 列，UNIQUE 改为复合键。
- 旧角色 `main` / `sub_publish` 合并为 `operation`；`sub_crawl` 改为 `assistant`。

### 迁移路径
- 自动迁移 `_migrate_v03_account_pool`：
  1. 备份 `/tmp/app.db.before-v03`。
  2. 老用户的 `tools/MediaCrawler/browser_data/xhs_user_data_dir` 软链到 `data/browser_profiles/main/`，登录态归 id=1 主号。
  3. items/notes/my_profile/crawl_logs 全部回填 `account_pool_id=1`。
- 升级后默认账号池：`id=1 主号 (operation)`。如果原本有数据，自动归并到这条。

### 兼容性
- CLI / MCP / crawler 子进程支持 `--account-pool-id` 参数（默认拿激活账号）。
- 老用户首次启动会看到迁移日志；如出错可从 `/tmp/app.db.before-v03` 恢复。
- 顶栏切到 assistant 账号会被后端 400 拒绝（service 层 `switch_active` 校验）。

---

## v0.2 — 风险护栏（与 v0.3 合并发布于 commit `f4c41b6`）

### 亮点
- 高危操作加二次确认护栏：删除主号、批量发布、清空登录态等。
- API 层新增 `require_protection(action)` 装饰器；warn 级返回 HTTP 428，需 header `X-Risk-Acknowledged: yes` 才能继续。
- 前端拦截 428 并弹确认框，文案随 action 变化。

### 兼容性
- 旧脚本调用受保护接口需补 header；CLI/MCP 默认带 `X-Risk-Acknowledged: yes`，无感。

---

## v0.1 — 初始版本（2025-Q4, commit `7337fa7` / `8313117`）

### 亮点
- CLI（`app/cli.py`）+ FastAPI（`app/server.py`）+ MCP Server（`app/mcp/server.py`）+ Tauri 客户端（`client/`）四端架构。
- 图库管理（MiniMax VLM 分析）→ 笔记 prompt 生成 → 草稿编辑 → Markdown 导出。
- 榜样账号（reference_accounts）作为 prompt 上下文。
- Playwright 自动发布脚本（`crawler/xhs_publish.py`）。
- 数据库：5 表 SQLite（items / reference_accounts / notes / crawl_logs / my_profile）。

### Schema 基线
- 单账号假设：所有数据隐含归属「我的账号」。
- `my_profile` 单行 id=1。

---

## 升级总览（v0.1 → v0.3.1）

新 clone 仓库不需要看本表；直接按 README 走即可。
**老用户从 v0.1 升级**只需要：

```bash
git pull
git submodule update --init --recursive
uv sync
# 启动 server，迁移脚本会自动跑
nohup uv run python -m app.server --port 8765 > /tmp/rn-server.log 2>&1 &
tail -f /tmp/rn-server.log   # 看到迁移日志即可
```

迁移失败时按时间倒序检查：
- v0.3.1 备份：`/tmp/app.db.before-v031`
- v0.3 备份：`/tmp/app.db.before-v03`

恢复方法：`cp /tmp/app.db.before-v03 data/app.db && rm -f /tmp/rn-server.log`，然后重启服务。
