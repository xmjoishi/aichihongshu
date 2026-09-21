# 爱吃红薯剪藏扩展（N12 最小原型 · 代号周星星）

把当前网页剪藏进爱吃红薯灵感待确认队列。扩展是**纯消息传输**：不接触数据库、Cookie、浏览器 profile；校验、账号盖章与入库都在爱吃红薯桌面端（Tauri/Rust）完成。

## 链路

```
本扩展（点击按钮 → activeTab 注入抓取 title/URL/划词/正文）
  → Chrome Native Messaging（stdio 长度前缀帧）
  → 原生宿主 host/host.cjs（仅封帧转发）
  → ~/.aichihongshu/browser-capture.sock（owner-only Unix socket）
  → Tauri Rust：镜像再校验 + 以当前激活账号盖章 targetAccountId
  → browser-capture://message 事件 → 灵感页待确认队列
  → 用户确认后写入本地 SQLite
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

# 3) 启动爱吃红薯桌面端，并停留在「灵感」页

# 4) 在任意网页点击扩展按钮：✓ 成功 / ! 失败；回到灵感页确认剪藏
```

卸载：Chrome 移除扩展；删除 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.aichihongshu.host.json`。

## QA 验收（不写正式数据）

```bash
npm run qa:prepare && npm run tauri:qa   # 使用 .qa/desktop-workspace
# 打开公开页面（或本地 fixture），点击扩展按钮，
# 在灵感页确认剪藏，验证写入 QA-A/QA-B 而非正式 data/app.db
```

## 已知限制（原型）

- 需停留在灵感页接收事件（与既有窗口消息通道同款限制）；不在页上时点击会得到「应用未运行或链路未就绪」类错误
- 桌面端单实例：socket 先到先得，多实例时后启动者不接收
- `chrome://` 等受限页面无法注入（按钮显示 !）
- 剪藏目标账号 = 应用当前激活账号（Rust 盖章，扩展无法指定）
- 同一页面重复剪藏按 `requestId`/`dedupeKey` 幂等去重

## 自动检查

```bash
npm run check:browser-capture        # 契约标记（TS/扩展/宿主/Rust）
npm run check:browser-capture-link   # 权限门禁 + 临时 socket 实测宿主转发 4 场景
```
