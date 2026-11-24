# 爱吃红薯（AI吃红书）

> 小红书家居/软装/装修垂类运营助手 · 代号 RN-家居类
> 当前版本 **v0.3.1**（多账号架构 + 榜样隔离）· 升级记录见 [CHANGELOG.md](./docs/CHANGELOG.md)

家居/软装/装修垂类小红书运营工具，覆盖账号人设设定 → 图库管理 → 物品分析 → 笔记创作 → 发布追踪完整链路。

三种使用方式：**GUI 客户端**（日常使用）/ **CLI**（批量/自动化）/ **MCP**（AI Agent 直接调用）。

当前桌面、Web、CLI 与 MCP 主链路由 Rust 提供。第一方 Python CLI、MCP、FastAPI 和爬虫脚本已退役，当前应用不依赖 Python 或 `uv`；第三方 MediaCrawler 子模块不参与构建、运行或打包。多平台发行与真实页面流程仍按 CHG-20260916-001 验收记录跟进。

## 项目结构

```
RN-家居类/
├── client/                       # Tauri + React GUI 客户端
│   └── rn/                       # Rust HTTP、CLI、MCP 与共享服务
├── tools/MediaCrawler/            # git submodule
├── data/                          # 运行时数据（git ignored）
├── assets/                        # 图库图片（git ignored）
├── .env.example                   # 环境变量模板
└── AGENTS.md                      # Agent 快速上手指南
```

## 初始化（Rust 客户端与 Web 开发）

```bash
# 安装 Web/Tauri 前端依赖
cd client && pnpm install && cd ..

# 构建 Rust HTTP/CLI/MCP
cargo build --locked --manifest-path client/rn/Cargo.toml

# 仅在尚无本地数据库时初始化（默认 data/app.db）
client/rn/target/debug/rn db init
```

桌面、Rust Web、CLI、MCP、AI 与浏览器 worker 当前均不依赖 Python/`uv`。关键词搜索与主页采集由 Rust CLI/API 和受管浏览器 worker 承接。

## 启动

### Mobile（Expo）

移动端启动、Debug、模拟器和真机部署手册见：

- [`mobile/README.md`](./mobile/README.md)

### GUI 客户端（推荐日常使用）

```bash
npm run tauri
```

Tauri 桌面通过 Rust commands 访问本地服务，无需启动兼容 HTTP 服务。

Windows 的 PowerShell 启动命令、端口占用与 WebView2 排查见 [Windows 桌面启动手册](./docs/开发参考/Windows桌面启动手册.md)。

### 浏览器 Web 开发模式

```bash
./scripts/start.sh
```

脚本启动 Rust `rn serve`（8765）与 Vite（1420）；`./scripts/stop.sh` 只停止本脚本启动且进程身份仍匹配的服务。若 8765 被其他服务占用，启动会提示先释放端口，不会接管或误杀未知进程。

> **生产打包**：`cd client && pnpm tauri build`，产物在 `client/src-tauri/target/release/`

### 桌面打包版说明

- Tauri 桌面直接使用 Rust commands；桌面包不携带 Python 源码或 MediaCrawler 资源，也不要求安装 `uv`/Python。
- Web 兼容服务仅供浏览器开发入口使用，由 `scripts/start.sh` 启动 Rust HTTP adapter。
- Rust adapter 不提供交互式 `/docs` 页面；健康检查地址为 `http://127.0.0.1:8765/health`。

### 仅启动 Rust API

在项目根目录运行：

```bash
client/rn/target/debug/rn serve --port 8765
```

Rust API 默认只监听 loopback，并对写请求校验 Origin 与会话令牌。

### MCP Server（供 OpenCode / Claude Desktop 调用）

Rust MCP 入口已提供，不启动 Python。开发者可在项目根目录构建并为目标数据库生成客户端配置：

```bash
cargo build --release --manifest-path client/rn/Cargo.toml
client/rn/target/release/rn mcp config --db /绝对路径/data/app.db
```

将命令输出的 `mcpServers` 合并进对应客户端配置。`rn mcp config` 只打印片段，不会改写用户配置文件。Rust 版保留旧 14 个 tool schema，并附加笔记关键词搜索、PC 记忆和 PC 写作经验维护工具，目前共 22 项；手机记忆/经验缓存不能通过 MCP 修改。隔离测试覆盖旧 schema、FastMCP 文本结果格式、参数类型、素材导入、记忆来源与账号隔离及错误路径。CLI 参数、主要文本/JSON 输出和 Unix 确认流程已有隔离回归；仍待 Windows TTY、少量低频输出、远端多平台构建及真实产品验收，见 PY07/PY10 检查点。

如果需要调用 `add_item_from_path`，请在 MCP server 配置中为它指定明确的本地图片目录；未设置时该工具会拒绝导入。配置片段示例：

```json
{
  "mcpServers": {
    "aichihongshu": {
      "command": "/absolute/path/to/rn",
      "args": ["--db", "/absolute/path/to/app.db", "mcp"],
      "env": {
        "AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR": "/absolute/path/to/approved-images"
      }
    }
  }
}
```

该目录限制只作用于 MCP 图片导入；不需要导入本地图片时，无需添加 `env` 项。

如果此前配置了 `uv`/Python MCP，请在旧 MCP 客户端配置中保留其它 server 条目，将 `aichihongshu` 的 `command`、`args` 替换成 `rn mcp config` 当前输出，并删除旧的 `cwd` 字段；`rn mcp` 使用配置中的绝对程序和数据库路径，不需要工作目录。保存后完全退出并重启客户端，再确认 22 个工具可见。`rn mcp config` 不会自动改写客户端配置。

配置文件位置：
- OpenCode：`~/.config/opencode/config.json`
- Claude Desktop：`~/Library/Application Support/Claude/claude_desktop_config.json`

## 标准工作流（v0.3）

> v0.3 起所有数据按「运营账号」隔离。首次启动会自动创建 `id=1 主号`，老用户原有数据会自动归并到这条。
> 顶栏 `ActiveAccountSwitcher` 切换账号后，图库 / 笔记 / 灵感 / 数据 / 榜样列表跟着切。

```bash
# Step 0：在「账号池」页确认/新建运营账号（默认已有 id=1 主号）
#   - 新建小号：role=operation，独立 user_data_dir、独立扫码登录
#   - 顶栏切到目标账号后，下面所有命令都隐式落到当前激活账号

# Rust CLI：先构建并设置命令路径
cargo build --locked --manifest-path client/rn/Cargo.toml
RN=client/rn/target/debug/rn

# Step 1：初始化当前账号的人设（首次必做）
"$RN" profile init \
  --name "虾薯的家" \
  --niche "家居软装/出租屋改造" \
  --persona-name "虾薯" \
  --persona-bio "住出租屋也要好看，不花冤枉钱的家居研究员" \
  --persona-tone "嘴硬傲娇，短句换行，先吐槽再给结论" \
  --taboos "精致,高品质,高级感,氛围感" \
  --styles "奶油风,侘寂风" \
  --scenes "客厅,卧室,出租屋" \
  --hashtags "家居好物,软装分享,出租屋改造,装修日记"

# Step 2：录入榜样账号（v0.3.1 起按账号隔离，每个运营账号有自己的对标榜样）
"$RN" accounts add xhs_account_id \
  --name "榜样账号名" \
  --note-count 80 --avg-likes 5000 \
  --style "内容风格描述" \
  --top-notes "高赞标题1,高赞标题2"

# Step 3：导入图库物品（自动调用 MiniMax 分析）
"$RN" library add ./my-sofa.jpg --title "奶油色布艺沙发"

# Step 4：生成笔记 Prompt
"$RN" content draft 1 --account-id xhs_account_id --save
# 将输出的 prompt 粘贴给 OpenCode（或直接在当前对话中发送）生成标题/正文

# Step 5：填入生成的内容
"$RN" content edit 1 \
  --title "买了这个沙发，朋友都以为我花了大价钱" \
  --body "正文内容..." \
  --tags "家居,沙发,客厅,奶油风,软装" \
  --status ready

# Step 6：导出发布
"$RN" content export 1
```

> **角色说明**
> - `operation`（运营号）：可发笔记、能成为顶栏激活上下文。
> - `assistant`（辅助号）：仅用于爬虫抓数据（如竞品账号），不能激活成上下文。

## 老用户升级

```bash
git pull
cargo build --locked --manifest-path client/rn/Cargo.toml
./scripts/start.sh
```

详见 [CHANGELOG.md](./docs/CHANGELOG.md)。

## 免责声明

- 本项目中集成的爬虫工具（`tools/MediaCrawler` 子模块）**仅用于个人学习和研究目的**，遵守其 [NON-COMMERCIAL LEARNING LICENSE](./tools/MediaCrawler/LICENSE)，**严禁商业用途**。
- 使用本工具前，请阅读并遵守[小红书用户协议](https://www.xiaohongshu.com/protocal/xhsnote)及相关平台规则。
- 本项目不对因使用本工具导致的账号封禁、数据丢失或任何其他损失承担责任。
- 请勿将本工具用于任何违法或违反平台规定的行为。

## 贡献

欢迎 Issue 和 Pull Request！请先阅读 [CONTRIBUTING.md](./docs/CONTRIBUTING.md)。

- **Bug 报告**：使用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.md)
- **功能建议**：使用 [功能请求模板](.github/ISSUE_TEMPLATE/feature_request.md)
- **代码贡献**：Fork → 新建分支 → 提交 PR，PR 描述请说明改动目的

## 请我喝杯咖啡 ☕

如果这个项目对你有帮助，欢迎请我喝杯咖啡，你的支持是我持续维护的动力！

<table>
  <tr>
    <td align="center">
      <img src="./docs/donate-wechat.jpg" width="200" alt="微信收款码" /><br/>
      <b>微信支付</b>
    </td>
    <td align="center">
      <img src="./docs/donate-alipay.jpg" width="200" alt="支付宝收款码" /><br/>
      <b>支付宝</b>
    </td>
  </tr>
</table>

## License

本仓库自有代码（`app/`、`client/`、`crawler/` 等）采用 [MIT License](./LICENSE)。

`tools/MediaCrawler` 子模块遵守其自身的 NON-COMMERCIAL LEARNING LICENSE，**禁止商业用途**，详见 [LICENSE](./LICENSE)。
