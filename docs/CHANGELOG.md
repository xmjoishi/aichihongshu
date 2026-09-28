# Changelog

记录 **爱吃红薯（AI吃红书）** 各版本的核心变更与升级路径。

格式约定：每个版本下分「亮点 / Schema 变更 / 迁移路径 / 兼容性」四块，方便老用户拉取代码后对照执行。

---

## 未发布（PC 工作区性能优化）

### CHG-20260921-002 性能修复（2026-09-28 用户原生验收）

- 运营页与 AI 往返、菜单浏览状态保留；隐藏页面暂停无关轮询和快捷操作。
- 素材库按需加载图片并减少大列表渲染；不同模块复用分段本地数据缓存。
- 本地图片读取、模型连接检查和 CLI 模型扫描移入后台处理，慢响应不会卡住桌面窗口。
- 用户原生验收通过；当前仍未发布。CHG 其他 PC Harness 和手机回填工作继续进行。

## 未发布（记忆中心 · 双端）

### CHG-20260926-007 记忆中心双端维护（2026-09-27 用户验收）

- **记忆页（PC）**：侧栏新增「记忆」；系统规则（L0/L1 只读可重置）/ 经验提示词 / 事实与事件 三分区；本机\|手机池切换；Card 网格 + 弹窗编辑；字段带标签；「用于」出稿/对话多选。
- **状态模型**：记忆启用/停用开关（不再做候选/确认/否定/过时状态机）；AI 来源默认停用。
- **AI**：弹窗内 AI 生成/润色；任意会话尾部「存为记忆 / 存为经验」；记忆页 AI 可维护记忆；出稿注入 L2→L3（默认不串池）。
- **手机**：「我的 → 记忆」维护手机池；Harness 记忆同步端点（origin=mobile，配对令牌鉴权）。
- **Schema**：新增 `memory_entries`、`experience_prompts`（含 `origin`、`enabled`）；`app_settings` 增 `memory_l1_override`。
- **待后续**：经验库/快捷指令收编、三端 L0/L1 文案统一、AI 稿自动提炼、双池冲突细化。

## 未发布（移动端）

### 移动端体验与 AI 创作一批（2026-09-27 验收）

- 相册：系统照片缩略图稳定展示与缓存；HEIC 等原图转 JPEG 后再送识别；AI 分析走所配置的多模态模型（如 MiniMax M3）；支持状态筛选、多选批量分析与 limited 权限管理。
- 正文链路：生成文案去 Markdown、去标题混入与会话式口头语；「一键生成」可附加主题提示词（可空）；编辑页一键生成标题+正文+话题。
- 发布准备：标题/正文各一个复制按钮；进入页不默认「已复制」；图片大图可左右滑、笔记全文预览；导出相册修权限与重复入库；「发布完成」主题色描边并记为已发布。
- 创作列表：双列封面流；`[+]` 进编辑手传图；左「修改时间」下拉排序 + 右文字筛选 tab（可横滑）；上滑收起筛选行；笔记列表分页（12/页）。
- AI 对话：红底入口；可附加图片；历史会话本地保存；返回正确离开对话页；AI 头像对齐消息顶部。
- 一致性：三页标题区统一；筛选行与内容起点对齐；编辑页不点「存草稿」不写库，空白草稿返回即丢弃。
- 已知限制：Expo Go 下多图一次进分享面板需 dev build；语音输入仅系统键盘听写。

### CHG-20260925-004 移动端发布分享直发（2026-09-26 验收）

- 发布页主按钮改为系统分享面板直发：多图 + 正文话题一次带进小红书（与相册「分享」同款），分享前自动复制正文+话题到剪贴板兜底。
- 分享文案不含标题（小红书标题为独立输入框，预览卡「复制」贴标题栏）；话题格式 `#话题 `。
- AI 出稿结合关联图片（多模态，最多 6 张）。
- 「打开小红书」改国区：App Store `id741292507`，优先 `xhsdiscover://post_note` 直达发布页；`LSApplicationQueriesSchemes` 白名单。
- 「导出到相册」保留为备用；依赖新增 `react-native-share`，需 rebuild 生效。

### CHG-20260925-005 编辑页图片条体验（2026-09-26 验收）

- 编辑页图片条小红书化：长按拖动排序（拖起放大、其余让位）、首图即封面、右上角 × 删除（二次确认）、末尾加图入口。
- 点首图进笔记预览页（LOGO 头像 + 小红薯占位、图横滑/圆点、图内编辑图片与删除、预览封面 / 发笔记）；点图全屏看图可缩放切换。
- 封面预览为小红书信息流效果（双列瀑布 + 骨架占位 + 本笔记卡片）。
- 话题输入关键字联想历史话题；底栏「一键生成」，AI 对话入口移至相册右上角。
- 第七轮实施中（2026-09-27，待用户验收）：主 Tab 改称「相册」，照片来源为系统相册且不复制原图；浏览/临时选图不建应用记录，AI 实际使用或笔记保存关联时才创建/复用照片元数据 ID；支持「已入库/已分析/未分析/已使用」重叠状态筛选，移除记录不删除系统照片。
- 兼容性：仅移动端；需 rebuild 生效（含 gesture-handler/reanimated 相关）。

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
