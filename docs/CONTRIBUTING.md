# 贡献指南

感谢你对**爱吃红薯（AI吃红书）**的关注！以下是参与贡献的基本流程和规范。

## 贡献前须知

- 本项目集成的 `tools/MediaCrawler` 子模块受 **NON-COMMERCIAL LEARNING LICENSE** 约束，**禁止商业用途**。请确保你的贡献不涉及商业化改造。
- 请勿提交任何涉及绕过平台反爬机制、批量恶意抓取的代码。
- 提交代码前请确认已在本地正常运行，不要提交 `.env`、`data/app.db`、`assets/` 等被 `.gitignore` 忽略的文件。

## Rust 主链路开发环境

```bash
# 1. Clone 仓库
git clone https://github.com/xmjoishi/aichihongshu.git
cd aichihongshu

# 2. 构建 Rust CLI / HTTP / MCP
cargo build --locked --manifest-path client/rn/Cargo.toml

# 3. 安装前端依赖
cd client && pnpm install && cd ..

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 MINIMAX_API_KEY

# 5. 初始化数据库
client/rn/target/debug/rn db init --yes
```

当前第一方运行链路不使用 Python 或 `uv`。Rust 变更运行对应 Cargo 检查；前端及 worker 变更运行相应的 pnpm/npm 构建和测试。MediaCrawler 子模块不属于产品运行依赖，也不要直接修改其代码。

## 提交 PR 流程

1. **Fork** 本仓库，并从 `main` 分支新建功能/修复分支：
   ```bash
   git checkout -b feat/your-feature-name
   # 或
   git checkout -b fix/your-bug-description
   ```

2. **开发并测试**：确保改动在本地正常运行。

3. **Commit 规范**：使用语义化前缀：
   - `feat:` 新功能
   - `fix:` Bug 修复
   - `docs:` 文档更新
   - `refactor:` 代码重构
   - `chore:` 构建/依赖/配置变更

4. **提交 PR**：目标分支为 `main`，PR 描述中请说明：
   - 改动目的和背景
   - 如何在本地验证

## 代码风格

- Rust：提交前运行 `cargo fmt --all -- --check` 与相关 crate 的 Clippy/tests
- TypeScript/React：遵守项目现有风格，组件使用函数式 + Hooks

## 报告问题

- Bug 报告请使用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.md)
- 功能建议请使用 [功能请求模板](.github/ISSUE_TEMPLATE/feature_request.md)
- 敏感安全问题请**不要**公开 Issue，直接发邮件联系维护者
