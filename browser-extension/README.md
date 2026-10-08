# 爱吃红薯浏览器扩展（剪藏、单篇快照与创作页填充 · Native Messaging v9）

扩展在用户点击后读取当前网页。收藏、快照与详情写入本地 SQLite 后返回逐项回执。用户也可以在小红书创作页领取一条本地发布准备任务，预览文字和按顺序关联的本地图片；再次明确确认后，扩展只填入当前创作页，不会点击发布或代表用户提交。

当前源码扩展版本为 v0.8.3，Native Messaging 协议为 v9；正式与 DEV 构建共享运行代码，但使用各自固定扩展 ID 和宿主通道。

## 链路

Chrome / Edge 扩展
→ Native Messaging（stdio 长度前缀帧；Port 保持期间逐条处理）
→ 通道专属 shell launcher → 桌面应用自身可执行文件（--native-messaging-host，无系统 Node）
→ ~/.aichihongshu/instances/{channel}/{workspaceId}.sock（owner-only Unix socket）
→ Tauri Rust 校验账号、任务 token 与素材关联，写 SQLite / 读取有界素材分块

桌面应用把扩展资源编入二进制。正式版保留既有扩展 ID 与宿主名 `com.aichihongshu.host`；开发版使用固定 DEV ID、宿主名 `com.aichihongshu.host.dev`，并按工作区分开 socket、实例注册与锁。Chrome 启动契约不支持 Native Messaging manifest 的 `args` 字段，因此清单 path 指向固定参数的无界面 launcher；浏览器传入的 origin 不会被误当成宿主参数。DEV 宿主仅允许固定 DEV 与正式扩展 ID，正式宿主只允许正式扩展 ID，不使用通配符。首次加载仍由用户在浏览器扩展页手动完成。

## 连接、开发模式与断连恢复

- 日常使用正式扩展，默认连接正式桌面通道。需要测试时，在「高级连接设置」主动开启 DEV，再选择或确认开发工作区；选择会按通道记住。一个匹配实例时自动连接，多个实例时必须选择。连接始终绑定 `channel + workspaceId`；选中的实例离线时不会转投其他工作区或数据库。
- 打开扩展只做连接发现、桌面协议握手与本地账号读取，不启动桌面 APP，也不写入采集数据。实例离线时可点击「启动桌面端」请求启动精确绑定的应用，或显式选择其他实例。
- 弹窗按浏览器宿主缺失/旧注册/启动失败、桌面实例离线、协议不兼容、账号读取失败和超时分别提示失败步骤与操作。桌面端「设置 → 浏览器插件」可检查清单、精确扩展 ID、launcher 和二进制路径；Chrome/Edge 一键修复只覆盖所选通道与浏览器。实际通信验证还需点击「验证插件通信」后，再点浏览器工具栏扩展；宿主清单存在本身不代表插件已握手。
- 断连时弹窗保留模块、图片、评论、账号与来源选择。只有用户主动点击「暂存到浏览器」才会把本次请求放进当前浏览器 session，并明确标为「尚未保存到桌面端」；暂存期间冻结采集选项，避免预览与待保存请求不一致，用户可点「放弃暂存」后重新编辑。恢复连接后会重读原工作区账号，核对原目标账号与来源，再由用户点击「核对账号后保存」。
- 保存回执未知时，弹窗保留原 `requestId` 和请求，并先查询是否已写入；用户可核实后用相同请求做幂等重试。跨通道或切换工作区不会重定向暂存/待核实请求。
- 「复制脱敏诊断」仅含应用/扩展版本、通道、失败步骤、错误码、耗时和宿主注册状态，不复制账号信息、网页正文、凭据或本机路径。

## 创作页图片填充

1. 在桌面端为笔记创建发布准备记录，然后在小红书创作发布页打开扩展并选择本地运营账号。
2. 点击「领取一条待填充任务」。系统把任务绑定到所选账号、笔记版本和短期随机 token；素材列表严格取发布快照顺序，并再次核对笔记当前素材关联。
3. 弹窗显示标题、正文、现有文字和图片文件名/顺序/大小。用户勾选确认后，扩展才从本地读取图片。
4. Rust 只根据 attempt/account/token/item ID 读取受管目录中的素材，不接受扩展提供的路径。单图上限 25 MiB、任务图片总量上限 32 MiB，按最多 32 KiB 原始字节分块；传输和创作页再次校验长度、MIME、文件魔数和 SHA-256。
5. 全部可用图片按快照顺序构建浏览器 FileList，设置到唯一且支持多选的图片 input，并触发 input / change。逐字段和逐图片结果写回 outbox；重试仅发送失败字段与图片。用户可在传输时取消，未完成时不修改页面。
6. 网站 DOM 变动、隐藏输入拦截或页面校验可能导致真实上传失败。自动 fixture 验证标准 FileList 接口、文件顺序和事件；真实小红书账号、Chrome/Edge 的端到端兼容仍需人工验收。扩展永不点击发布按钮。

## 本人 / 榜样主页笔记同步

用户在主页选择「更新数据」后，扩展才会读取最近主页卡片：最多滚动 16 次、最多 30 篇，读取标题、摘要、互动数、标签和发布时间，并恢复原滚动位置；不会打开笔记详情页。笔记链接会去除查询参数，避免把临时追踪 token 存入本地。

只有主页账号 ID 与所选账号的本人资料或已登记榜样账号精确匹配时才会写入。本人笔记按链接去重进入本地已发布笔记；榜样笔记只更新榜样原始样本和热门标题，不混入本人笔记列表。部分加载允许同步已看到的笔记，但不会覆盖互动总量和平均值；互动值不完整时也会保留旧聚合值。登录失效、安全验证或扩展采集不可用时，当前操作会停止且不写入，用户处理后重新点击。

## 权限与边界

- 申请 nativeMessaging、scripting、activeTab、storage。`chrome.storage.local` 仅记住正式/DEV 偏好和每通道 workspaceId；网页载荷不写 local/sync。`chrome.storage.session` 用于展开预览一次性消费、弹窗选择状态与临时账号快照，以及用户明确暂存或保存结果未知的请求；网页正文只在用户点击暂存或已发出保存请求且结果未知时保留到核实完成/浏览器会话结束。重开弹窗可按原 requestId 核实/幂等重试。
- 不申请 tabs、cookies、history、browsingData 或站点级 host_permissions；没有常驻 content script。
- 不持续后台采集、不点击分页、不打开笔记详情或下载远程图片；主页笔记只随用户点击在当前页有界滚动采集。不访问 Cookie/profile，不自动提交发布或互动。
- 创作页填充只读与任务绑定的本地素材，不开放任意路径或任意文件读取。

## 安装、升级与恢复

1. 安装并启动对应通道的桌面应用，在「设置 → 浏览器插件」点当前通道的「安装/修复 DEV/正式版到 Chrome」或 Edge。安装器会将完整扩展资源写入该通道的稳定用户目录，校验固定扩展 ID 与 SHA-256，并原子更新宿主清单。
2. 首次使用时，在自动打开的扩展管理页开启「开发者模式」→「加载已解压的扩展程序」→ 选择设置页显示的当前通道目录（正式版为 ~/.aichihongshu/browser-extension，DEV 为 ~/.aichihongshu/dev/browser-extension）。
3. 若仍在使用旧版清单（含非法 `args`）或升级桌面应用，再点一次与旧安装对应通道的安装/修复。该操作会重写当前通道的 Native Host 清单与 launcher，修复错误启动入口；不会更改另一通道。随后在扩展管理页手动重载扩展，核对设置页显示的通道、工作区、应用/扩展版本与最近上报版本。
4. 如果升级副本无法加载，再运行安装/修复。替换前的扩展目录会保留在对应通道的备份目录，失败部署也会保留供排查；宿主清单使用临时文件原子替换，激活失败时恢复旧 launcher。
5. 设置页「检查本机注册与路径」核对扩展文件、应用内 Rust 宿主、Chrome/Edge 清单、精确扩展来源和 launcher/binary 路径；「验证插件通信」需在 15 秒内点击工具栏扩展。应用必须运行才能处理剪藏与快照；插件的「启动桌面端」是用户明确操作。

## 卸载

先在 Chrome/Edge 扩展管理页移除「爱吃红薯数据抓取」，再删除对应浏览器的 Native Messaging 清单：

- 正式版 Chrome/Edge：`com.aichihongshu.host.json`
- 开发版 Chrome/Edge：`com.aichihongshu.host.dev.json`

可选地删除 ~/.aichihongshu/browser-extension 与 ~/.aichihongshu/browser-extension.previous-* 扩展文件。卸载不会删除桌面端本地业务数据库或素材；不要手工删除整个 ~/.aichihongshu 目录。

## 开发与检查

npm run check:browser-extension-package  检查 manifest、权限、固定 ID、文件清单和 JS 语法
npm run package:browser-extension         生成可加载副本与 SHA-256 清单
npm run check:browser-capture             采集/创作页 fixture 与静态契约
npm run check:browser-capture-link        兼容宿主转发 harness
npm run check:native-host                 编译并实测 Rust Native Messaging 宿主

`npm run package:browser-extension` 输出正式和 dev 两个可加载目录；生产/开发扩展不能互换 Native Host 清单。

扩展源码资源清单固定在 client/src-tauri/src/browser_capture.rs，桌面安装不读取仓库路径。browser-extension/host/host.cjs 和 install-host.mjs 仅供旧版联调，不是正式安装路径。

## 验收边界

- AC-22 的远程 URL 自动下载未实现；用户可在浏览器自行保存图片，再用素材库导入本地文件。
- 主页最近笔记的最多 30 篇、16 次滚动上限、互动/标签解析、验证/登录停止、原滚动位置恢复、链接 token 清理、Rust 账号隔离导入、本人编辑内容保留、部分聚合保护和 requestId 回执均有 fixture/单测；真实小红书卡片 DOM、本人/榜样账号写入和多平台扩展宿主仍待用户验收。
- AC-25 已有本地受管素材分块传输、顺序 FileList 填充、逐图持久化结果和失败项重试 fixture；真实小红书页面是否接受文件选择器仍待用户验收。
- AC-29/30 的无源码、无系统 Node 干净 macOS 安装和失败恢复，以及真实 Chrome/Edge 首次加载、升级、重载和卸载，仍需在目标机器验证。自动检查不等于产品验收。
