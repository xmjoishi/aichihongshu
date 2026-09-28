# 爱吃红薯浏览器扩展（剪藏与单篇快照 · Native Messaging v3）

把当前网页剪藏进爱吃红薯「素材库 → 网页收藏」。扩展不接触 Cookie 或浏览器 profile；消息由桌面端校验并盖当前激活账号，Rust 在向扩展确认成功前直接写入本地 SQLite。

## 链路

```
本扩展（点击按钮 → activeTab 注入抓取 title/URL/划词/正文）
  → Chrome Native Messaging（stdio 长度前缀帧）
  → 原生宿主 host/host.cjs（仅封帧转发）
  → ~/.aichihongshu/browser-capture.sock（owner-only Unix socket）
  → Tauri Rust：镜像再校验 + 以当前激活账号盖章 targetAccountId
  → 本地 SQLite 网页收藏表（写入成功后才返回收藏成功）
  → browser-capture://message 事件通知桌面端刷新卡片状态
```

## 权限（最小化、可撤销）

- 恰好申请：`nativeMessaging`、`scripting`、`activeTab`
- 不申请：`tabs`、`cookies`、`history`、`browsingData`、任何 host 权限
- 无常驻 content script；仅用户点击按钮时对当前标签页注入一次
- `install-host.mjs` 会对超出最小集合的权限**拒绝安装**

## 安装（均为用户显式操作）

```bash
# 1) 安装原生宿主 manifest（写入本机用户级目录，无需 root）
node browser-extension/install-host.mjs

# 2) Chrome → 扩展程序 → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 browser-extension/ 目录

# 3) 启动爱吃红薯桌面端；可停留在任意页面

# 4) 在网页点击扩展按钮：剪藏入库后显示成功；打开「素材库 → 网页收藏」查看「已收藏」状态
```

卸载：Chrome 移除扩展；删除 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.aichihongshu.host.json`。

## QA 验收（不写正式数据）

```bash
npm run qa:prepare && npm run tauri:qa   # 使用 .qa/desktop-workspace
# 打开公开页面（或本地 fixture），点击扩展按钮，
# 点击剪藏并检查网页收藏卡片，验证写入 QA-A/QA-B 而非正式 data/app.db
```

## 已知限制（原型）

- 桌面端必须运行、扩展与原生宿主必须已安装，且当前激活账号可用；无需停留在特定业务页
- 桌面端单实例：socket 先到先得，多实例时后启动者不接收
- `chrome://` 等受限页面无法注入（按钮显示 !）
- 剪藏目标账号 = 应用当前激活账号（Rust 盖章，扩展无法指定）
- 同一页面重复剪藏按 `requestId`/`dedupeKey` 幂等去重；旧版待确认队列会在打开网页收藏页时迁入 SQLite，迁移失败可重试

## 自动检查

```bash
npm run check:browser-capture        # 契约标记（TS/扩展/宿主/Rust）
npm run check:browser-capture-link   # 权限门禁 + 临时 socket 实测宿主转发 4 场景
```
