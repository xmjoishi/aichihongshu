# Python 替代契约与验收矩阵（PY00）

2026-10-05 PY10 MCP 进程级调用回归：新增无 Node/Python PATH 的真实 stdio 子进程测试，逐条读写 22 工具协议并覆盖 PC 记忆 CRUD/状态、PC 写作经验 CRUD/省略字段保留、笔记空搜索和非法经验来源拒绝。RN 65 单测 + 24 子进程 = 89/89，strict Clippy、fmt、`git diff --check` 通过。第一方 `.py` 文件为 0；Cargo/npm lockfile 除 `Python-2.0` 许可证外无 Python/PyO3 runtime 命中。未安装 rustup 或 Windows/Linux/Intel target，跨平台门禁仍待原生 runner。

2026-10-05 PY10 当前源码全量验收复核：core 64/64、services 23/23、rn 89/89、Tauri 51/51；四 crate strict Clippy/rustfmt、browser-worker 17/17、AI stream 4/4、resource guard 与 Vite production build（2794 modules）通过。当前源码下 Python denylist 构建 arm64 `.app`/DMG 为零命中；两份实包资源 guard 零违规、主程序无 libpython、DMG checksum 有效，映像内 app 的空 PATH/临时 HOME 随包 Chromium 内存页 smoke 通过。源码和锁依赖无第一方 Python runtime；远端四平台、GUI/Web、MCP 用户配置迁移及真实 Provider/XHS 验收仍待，不能据此标记产品验收完成。

2026-10-06 Web 与原生 UI 验收增量：临时 QA 副本的 release `rn serve` + Vite 在 Python denylist PATH 下启动，Web API、概览/素材/笔记/数据/账号池/设置路由以及 QA-A/QA-B 数据切换通过浏览器 E2E，审计日志零命中。原生窗口曾通过桌面接口启动，但 QA 副本仍使用编译期应用标识，用户 app_data_dir 无法由改写 Info.plist 隔离；已关闭应用，不执行回滚或 CRUD。原生 GUI 当前标“未验收”，未来必须用编译期隔离 identifier 或 debug QA workspace 重建后复验。

2026-10-04 PY10 跨 crate 复验与 Clippy 修复：core 61/61、services 23/23、rn 88/88、Tauri 48/48；services/Tauri 本地 loopback 与 Unix socket fixture 在可绑定本机 fixture 的环境中通过。四 crate strict Clippy、四 crate fmt 和 Tauri `cargo check --lib` 均通过。strict Clippy 发现并修复共享 `db/browser.rs` 两处冗余写法，不改变数据或 URL 语义。普通 core target 的两条 private helper `dead_code` warning 来自共享数据库模块未包含 Tauri command adapter 的编译边界；Tauri command 实际调用这些 helpers。同步修复 `BrowserCollectionPanel.tsx` 已实现但未接入的剪藏引用 UI 后，Vite build 通过。

2026-10-04 Python-free 边界复验：排除 `tools/MediaCrawler`、依赖及构建目录后没有第一方 `.py` 源文件；第一方 Cargo/npm lockfile 未发现 Python/PyO3 runtime 依赖（许可证文本 `Python-2.0` 除外）；denylist、Tauri resource guard、browser-worker 17/17、AI stream 4/4、Vite build 和 `git diff --check` 均通过。当前源码重建的 macOS arm64 `.app` 与 DMG 在 denylist 下零命中；实际包资源守卫零违规、符号链接 0、主程序无 libpython，DMG checksum 有效，映像内随包 Node/Playwright/Chromium headless fixture 通过。当前 rn 独立 Cargo 安装后可在无 Node/Python PATH 下查询版本、初始化隔离 DB 和列空素材 JSON。外部 Windows/四平台 CI、MCP 配置迁移、真实 Provider/XHS 与 GUI/Web 产品验收仍待。

2026-10-04 PY10 CLI JSON 诊断输出：对 `content topic --analysis-file` 文件缺失分支新增空 Python PATH 子进程检查，普通模式继续生成 Prompt 并提示，JSON 模式 stdout 保持纯 JSON、错误提示写 stderr；全量 rn 64 单测 + 24 子进程 = 88/88，strict Clippy/fmt、Python denylist、Tauri resource guard 与 diff check 通过。Windows TTY 和外部平台/产品验收仍待。

2026-10-04 PY10 CLI 低频删除兼容分支：新增无 Python PATH 子进程回归，导入受管图片后执行 `library delete ITEM_ID --delete-file --yes`，核对兼容提示、旧软删除 stdout、回收站可恢复性以及磁盘图片仍存在；与旧 `delete_item` 的真实实现相符。RN 全量 64 单测 + 23 子进程 = 87/87，strict Clippy、fmt 与 diff check 通过。此项仅补合同测试，没有变更生产逻辑。

2026-10-04 PY10 收藏图片来源字段合同：core 回归核对旧 URL 图片为 `legacy_url`、扩展受管字节上传为 `extension_bytes`；恢复续传合同直接读取临时分块文件验证已确认前缀，完整图片读取仍要求达到申报长度。core 58/58 和 core strict Clippy 通过；Tauri lib check/strict Clippy 通过。

2026-10-04 PY10 跨 crate 恢复验证（早期计数与 fmt 状态已由上方最新复验取代）：core 58/58、services 23/23、rn 87/87、Tauri 45/45；当时 core/Tauri fmt 尚未通过。MCP `add_item_from_path` 省略 analyze 且缺少凭据的子进程回归确认错误后不导入。Python denylist/resource guard、browser-worker 17/17、AI stream 4/4、Vite production build 与 first-party Python source/runtime dependency scan 通过。当前计数与格式状态见本文顶部及 `00-03` 检查点。

2026-10-04 PY10 独立 Rust CLI 安装验证：`cargo install --path client/rn --locked --offline --debug --root <temp>` 后，将 PATH 限定为安装目录且无 Node/Python 可执行文件，`rn --version`、隔离 SQLite 初始化和 JSON 素材列表均成功（`[]`）。core 58/58、rn 87/87、core/rn/Tauri strict Clippy 及 Tauri lib check 通过；安装目录和隔离 DB 已清理。此项验证无仓库/系统 Node/Python 的基础 CLI 数据库工作流，不替代随包浏览器 worker 的平台安装验收。

2026-10-04 PY10 活跃文档 Python 引用审计：README、贡献指南、操作手册和导航没有第一方 Python 安装/启动步骤；旧工程说明中的旧架构只作迁移排查参考。修复旧工程说明当前状态横幅中过期的测试计数与 fmt 状态，并标记 00-09 中早期“尚未纳入安装包”的 PY07 段落为历史记录。源码运行命令扫描仅发现 `AGENTS.md` 约束旧 MediaCrawler 路径的说明，不属于当前第一方 runtime 入口。

2026-10-04 PY10 MCP 默认分析失败原子性：`add_item_from_path` 在授权目录内省略 `analyze` 时按默认 `true`；隔离 MCP 子进程移除 MiniMax 凭据后检查工具错误类别，并在后续 `list_items` 核验没有半导入素材。旧实现同样先分析后导入。rn 64 单测 + 23 子进程 = 87/87，strict Clippy、fmt、diff check 通过；上一轮共享 Rust 编译阻塞已随并行工作树更新解除。第一方 Python-free 源码/锁依赖审计、denylist、resource guard、browser-worker 17/17、AI stream 4/4 与 Vite production build 也通过。Windows TTY、少量其它低频 CLI 输出、剩余 MCP 状态组合和远端平台/产品验收仍待。

2026-10-04 PY10 运行时调用审计加固：CI PATH shim 覆盖常见版本化 `python`/`pythonw`、PyPy、pip 和 uv 命令，并优先加入 Node shim；它使用 runner 提供的 Node 预加载 child-process hook，钩子再把自身加入当前进程环境供子 Node 继承。`GITHUB_ENV` 只写审计日志路径；Tauri 发布 action 由 step-level `NODE_OPTIONS` 单独加载 hook。黑盒用不存在的 Unix/Windows 风格绝对目标覆盖同步/异步 Node API 和 shell，并确认 attempt 被记录；本轮用全新临时 runner 目录模拟 `GITHUB_PATH`/`GITHUB_ENV`，PATH shim 下 denylist 回归、Vite production build 均通过且报告零命中。此项对 Node 管理的子进程提供动态覆盖，非 Node 直接调用仍由 PATH denylist、源码/依赖审查及 bundle resource guard 约束；四平台 CI 尚待远端运行。

2026-10-04 PY10 CLI `profile edit` 全字段子进程契约：无 Python PATH 的隔离进程为旧 CLI 17 个编辑字段一次性赋值，再通过 JSON 读回核对人设、画像、统计数字和数组；列表断言覆盖空项过滤与 `#` 前缀清理。rn 全量更新为 64 单测 + 23 子进程 = 87/87，strict Clippy、fmt 通过。

2026-10-04 PY10 `content list` 双过滤真实 CLI 回归：两个素材分别关联 ready/draft 笔记，测试 `--status` 与 `--item-id` 同时生效的两个匹配组合及两个交叉空结果；既验证正向返回，也验证任何一个过滤条件被忽略会失败。完整 rn 仍为 64 单测 + 21 子进程 = 85/85。

2026-10-04 PY10 `library analyze` 缺凭据失败原子性：空 Python PATH 的真实 CLI 子进程在没有 Provider 凭据时断言退出码 2、stdout 为空、stderr 可操作提示，并逐字段比较操作前后素材 JSON 确认无部分写入。CLI 现为 64 单测 + 22 子进程 = 86/86；本地 MiniMax mock 的请求/解析契约由 services 测试覆盖，未访问真实 Provider。

2026-10-04 PY10 Unix 伪终端交互矩阵补充：真实子进程验证 `db init`、`accounts delete`、`library delete` 的 y/n 确认，逐项断言 stdout/stderr、退出码与隔离数据结果；取消不会创建/删除，确认后的素材进入回收站。完整 rn 为 64 单测 + 22 子进程 = 86/86，strict Clippy、crate fmt 与 diff check 通过。Windows TTY 仍待原生 runner。

2026-10-03 PY10 常规 CI 与完整本机复验：release workflow 的四平台 push/PR 门禁现包括 services localhost MiniMax mock、四 crate fmt、core/services/rn/Tauri strict Clippy、Vite build 与 Tauri lib tests；release 仍须先通过该 gate。macOS 本机 core 57/57、services 23/23、rn 84/84、Tauri 44/44、browser-worker 17/17、AI stream 4/4，denylist/resource guard、前端构建、Tauri cargo check、格式/lint 与 YAML parse 通过。远端矩阵未运行，不能据此标为 Windows/Linux/Intel 已验收。

2026-10-03 PY10 CLI/MCP 隔离契约矩阵：所有旧 CLI 数值参数的非法值、值选项缺值、必填位置参数缺失均在空 Python PATH 的真实子进程中逐项检查退出码/stdout/stderr；修复多个命令与公共 option parser 的 Click 错误契约差异，回归 trash、restore 及受保护/成功 purge 流程。MCP 双账号 fixture 验证 profile/reference 归属，并检查跨账号 draft/publish/save/export 不泄漏或写入，同时保持各工具旧错误类别。跨 crate 补齐 core/Tauri 的 chrono manifest 依赖；完整快照且字段齐全时才同步互动汇总，部分快照不再覆盖已有均值。core 57/57、services 23/23、rn 64 单测 + 20 子进程 = 84/84、Tauri 44/44；四 crate strict Clippy/fmt、Tauri offline check、diff check 均通过。

2026-10-03 PY07 MCP schema 参数矩阵补缺：`default: null` 的可选字符串/整数属性接受显式 `null`；新增自动遍历全部工具属性的隔离 tools/call，验证每个参数的无效类型及字符串数组成员错误会被拒绝，并扩展 `update_profile` 四个可空字段的 no-op 实际调用。此前校验器会在执行前误拒绝可选 null。rn 全量 64 单测 + 17 子进程 = 81/81，strict Clippy、crate fmt、`git diff --check` 通过。

2026-10-03 PY07 active-account 引用 fail-closed：修复非数字/空/NULL `active_account_id` 被当作缺省值并静默选默认账号的问题；现在配置值损坏直接失败。全部 14 个 MCP tools/call 对不存在 ID、损坏配置值和有效 assistant 角色 ID 均返回 `isError=true`，包括授权目录 PNG 导入；core 57/57，rn 79/79，strict Clippy 与 targeted rustfmt 通过。

2026-10-03 PY07 MCP 账号状态矩阵补充：全部 14 个 tools/call 在隔离库中以有效参数执行时，遇到指向不存在账号的 `active_account_id` 均 fail-closed；授权目录中的有效图片也没有在账号上下文失效时导入。RN 全量 79/79、strict Clippy、MCP targeted rustfmt 与 diff check 通过。此项补足失效账号边界，不代表所有参数/数据库状态组合穷尽；remaining MCP matrix、用户配置迁移、跨平台包及真实产品验收仍待。

2026-10-03 PY05 CLI worker 失败原子性：`profile init --url` 收到 `login-required` 时子进程退出码为 2，stdout 为空、stderr 提示用户登录，profile 数据无部分写入且 worker 收到 `shutdown`；成功路径亦检查收尾。隔离 CLI 进程合同纳入 rn 全量 79/79、strict Clippy 和 targeted rustfmt。未访问真实 XHS。

2026-10-03 PY10 Rust gate 全闭环（后续 CLI 参数矩阵扩展前计数）：精简共享账号校验调用的借用、去除相应多余 `mut`，收藏图片写入改用具名结构；其余收藏/桌面 Clippy 项均修复。core 57/57、services 23/23、rn 81/81、Tauri 43/43；core/services/rn/Tauri strict Clippy、Tauri offline `cargo check --lib`、四 crate fmt、定向 rustfmt 与 diff check 通过。services 的 MiniMax 请求仅发往本地 mock。最新计数见本文顶部；四平台远端 CI、用户 MCP 客户端配置迁移及真实 Provider/XHS 验收仍待。

2026-10-03 PY09/PY10 当前包验收：Python command denylist 在 PATH 前置后拦截零命中，Tauri app-only release 重建 macOS arm64 `.app`（约 728 MiB）；实际包资源树 guard 零违规，无 Python/虚拟环境/MediaCrawler 文件名、无符号链接，主二进制无 libpython 动态依赖。runtime manifest 和 Node/Chromium Mach-O 均匹配 `aarch64-apple-darwin`。直接从实际 `.app` 启动随包 Node/Playwright/Chromium，在 headless 临时 profile 中打开内存页面并断言标题和 DOM 文本通过；沙箱首次启动受进程管理权限限制，授权本机重跑通过。未启动桌面 GUI 或真实站点；四平台干净安装及产品功能仍待。

2026-10-03 PY09 macOS arm64 DMG 安装映像验收：`pnpm tauri build --bundles dmg -vv` 在 Python command denylist PATH 下成功生成约 316 MiB DMG；此前无权限沙箱里的 `hdiutil create` 返回“设备未配置”，空白映像提升权限 smoke 成功后才重跑完整打包。`hdiutil verify` 校验和有效。DMG 只读挂载后确认含 Applications 链接和 `.app`；对映像内 `Contents/Resources` 执行同一递归 Python resource guard 为零违规、零符号链接，主程序及随包 Node 是 arm64 Mach-O。直接从映像 app 的 Node/Playwright/Chromium 在临时 profile 打开内存页面，标题/DOM 断言通过。Python/uv/pip 拦截器无调用记录；已卸载映像并清理自建临时 smoke DMG。

2026-10-03 PY10 本机可运行合同复验（前次记录）：core 56/56，rn 79/79，browser-worker 17/17，AI stream 4/4；Vite production build、publish-preparation、扩展 fixtures、Python command denylist、Tauri resource guard 均通过。Tauri native compile 后已在本日后续门禁复验中通过；远端四平台与真实 XHS/Provider 验收仍待。

历史环境限制（已由 2026-10-03 最新 PY10 checkpoint 取代）：早前 services MiniMax 合同测试在沙箱内绑定本地 TCP mock listener 时返回 EPERM；之后授权本机重跑 `cargo test --locked --offline --manifest-path client/services/Cargo.toml -- --include-ignored` 为 23/23，通过仅访问本地 mock，没有连接真实 Provider。

2026-10-02 PY06 视频发布契约进展（当日门禁状态已由 2026-10-03 PY10 记录取代）：确认旧 `xhs_publish.py` 支持 `--video`，前序矩阵把视频分支当成可退役功能的记录已纠正。视频路径持久化、账号隔离分块导入/取消清理、outbox claim 授权分块读取、扩展端签名/SHA-256 校验、确认后设置唯一视频文件框和失败重试已实施；平台最终提交仍由用户执行。新增字段不破坏旧 HTTP/MCP/CLI 构造与内容更新，RN 的 61 单测 + 17 子进程、core 55/55、Vite build 和视频/扩展契约通过。真实 XHS 页面 DOM 与登录验收仍未完成。

2026-10-02 PY10 `rn search` browser worker 进程契约：空 Python PATH 下用临时 Node JSONL worker 验证多关键词 URL 编码、账号绑定、字段映射、JSON/普通文本 stdout、进度 stderr、搜索文件和账号采集历史；成功及未登录错误都必须发送 worker `shutdown`。该回归发现并修复搜索命令遗漏显式 worker 收尾的问题。rn 61 单测 + 17 子进程 = 78/78，strict Clippy、fmt 与 diff check 通过；不访问真实 XHS/Provider。

2026-10-02 PY10 CLI process matrix：新增空 Python PATH 的 `rn crawl history` 子进程覆盖空态/JSON/倒序/账号过滤/limit 错误；`rn analyze` 子进程与已归档旧 JSON 报告 fixture 精确一致，并核对报告文件、普通 console 结构及 `--save-db` 历史回执。当前 rn 为 61 单测 + 16 进程 = 77/77，`client/services -- --include-ignored` 为 23/23，rn strict Clippy/fmt、diff check 通过。

2026-10-01 PY10 Web 双账号隔离冒烟：本机 Vite + Rust HTTP adapter 使用 `/private/tmp` 合成 SQLite，通过 Playwright 切换一号/二号/一号；dashboard 数量、人设及素材库/笔记专属数据均正确，两个方向没有跨账号显示。无页面异常、无失败 `/api` 响应。隔离 listener 已停止，未访问正式数据库、Provider 或 XHS。重跑 `cargo test --locked --offline --manifest-path client/rn/Cargo.toml`：61 单测 + 14 子进程 = 75/75。此项是合成 Web 检查，不等同于原生客户端或真实产品验收。

2026-10-01 PY10 services loopback contract：在本地受控 runner 用 `-- --include-ignored` 运行完整 `client/services` 套件，23/23 通过；原被沙箱标记 ignored 的用例仅启动本机 mock server 并验证 MiniMax VLM 请求/响应形状，不访问外部供应商。

2026-10-01 PY08 历史数据与导出契约收口：analytics 全部四条路由用账号限定 SQL 覆盖快照外数据；单条笔记详情/导出/编辑与 AI 聊天按 ID 直查，知识规则和灵感提示从完整历史聚合。5001 条隔离回归核对排名、前十、均值、标签、趋势、详情、导出、聊天上下文和知识规律；另核对旧灵感标签井号拼接及均值并列时的首次出现顺序。MCP 隔离测试补齐 `get_item` 有效/损坏分析 JSON 和未知非 `add` 标签 action 的旧行为。MCP/CLI/Web 共用旧 Markdown 导出格式。core 52/52、services 22 passed / 1 sandbox-ignored、rn 75/75、browser-worker 17/17、AI stream 4/4、denylist/resource guard、前端 production build、Tauri check、三 crate strict Clippy、四 crate fmt 与 diff check 通过。多平台 CI/包、真实 Provider/XHS、MCP 其余状态矩阵及用户配置迁移仍待外部验收。

2026-10-01 PY08 analytics 全量聚合：`/api/analytics/summary`、`insights`、`notes-trend` 不再从有 5000 行上限的 UI 快照统计；summary 使用账号限定 SQL 聚合与 top 10，insights 聚合标题/时段并流式累计标签，trend 只读取近 90 天日聚合。`notes` 榜单也查询当前账号全部已发布行。隔离回归以 5001 条验证快照外数据进入均值、榜单、标签和趋势，并检查 summary 账号隔离；core 52/52、services 22 passed / 1 ignored、rn 74/74、Tauri lib check、三 crate strict Clippy/fmt、diff check 通过。

2026-10-01 PY08 analytics ranking 全量行：`/api/analytics/notes` 已由受激活账号校验的专用查询替换 UI 快照读取，避免 5000 条上限截断旧接口榜单；保留 likes/collects/comments 排序、字段和同账号封面查找。隔离 handler 回归插入 5001 条，验证总数、最早行和三类排序。core 52/52、services 22 通过/1 sandbox-ignored、rn 60 单测 + 14 进程 = 74/74；Tauri lib check、三 crate strict Clippy/fmt、diff check 通过。

2026-10-01 PY10 本机合同矩阵复验：core 52/52；services 22 passed / 1 ignored（本机沙箱禁止本地 TCP listener）；rn 59 单测 + 14 进程测试 = 73/73；browser-worker 17/17、AI stream 4/4、Python 命令 denylist、Tauri resource guard、TypeScript/Vite production build、strict Clippy、Rust fmt、启动脚本语法和 diff check 通过。运行入口静态复核无第一方 Python/uv/pip 执行调用。尝试从临时合成数据库启动 Web 双账号冒烟时，沙箱拒绝 loopback listener，Vite/浏览器步骤未启动，原 `.qa` 未改且临时副本已清理。当前仅安装 `aarch64-apple-darwin` Rust target 且没有 `rustup`，无法本地交叉编译；CI 四平台矩阵尚未实际运行。真实 Provider/XHS、Web 双账号、用户 MCP 配置与多平台发行验收仍待。

2026-10-01 PY09/PY10 Tauri 资源闭合：bundle guard 递归审计全部配置资源，拒绝嵌套 Python 源码/运行时/环境元数据、通配资源与资源树外符号链接，允许并测试资源树内链接；隔离 fixture 和 release contract job 均已覆盖。Playwright/Chromium 包内绝对链接现重写为相对链接；arm64 Chromium 从复制后的资源树启动并通过 headless 页面 fixture。`pnpm tauri build --bundles app` 生成约 727 MiB macOS arm64 `.app`；实包资源通过同一递归 guard，未发现 Python 源码/解释器/环境或残留符号链接。`build:tauri`、Python denylist、资源 guard、browser-worker 17/17、AI stream 4/4 与 `git diff --check` 通过。该项只验收本机 arm64 app 资源闭合；四平台 CI、Intel/Windows/Linux 包及原生产品验收仍待。

2026-10-01 PY07 非空榜样账号 CLI 列表：隔离空 Python PATH 子进程新增第二个参考账号，核对 JSON/文本排序为 `crawled_at` 倒序，文本精确验证标题、统计字段、24 字符 account_id 截断和时间字段。`cargo test --locked --offline --manifest-path client/rn/Cargo.toml --test cli_process_contract` 13/13；本轮未改生产逻辑。其它命令完整输出和交互边界仍待。

2026-10-01 PY07 `profile init --url`：临时 Node 22 worker 在空环境下完成 JSONL 握手、session/profile 回执与 shutdown；真实 `rn` CLI 将主页资料和统计写入隔离 SQLite，未设置 Provider 时保留已有/采集字段继续同步。普通模式恢复旧版抓取进度、AI 失败后继续提示、推断摘要和保存回执；JSON 模式进度/警告在 stderr，stdout 保持纯 JSON。修复 CLI 完成采集后显式关闭 worker。rn 59 单测 + 14 进程测试 = 73/73、strict Clippy、fmt 与 diff check 通过。XHS DOM/登录态及真实 Provider 仍待验收。

2026-10-01 PY07 `library add` 输出流契约：旧 CLI 的分析进度、分析成功/失败提示和导入回执均在 stdout；Rust 普通模式已恢复原顺序，JSON 模式的诊断写 stderr 且 stdout 保持纯 JSON。空 Python PATH、空 Provider 凭据的隔离子进程覆盖失败后继续导入。rn 59 单测 + 13 进程测试 = 72/72，core 52/52、services 22 通过/1 受沙箱限制忽略；三个 crate strict Clippy、fmt、diff check 和 denylist 自测通过。静态盘点在 MediaCrawler/构建目录外未发现第一方 `.py` 源文件或运行时 Python/uv/pip 调用；旧工程说明已切换当前命令并将旧 FastAPI/发布/schema 章节明确归档。

2026-10-01 PY07 MCP 更新状态边界：回归精确覆盖 `update_profile` 的未传字段保留/显式空值清除、`save_note` 的空标题/标签与其它字段保留，以及 `publish_note` 省略 URL 时保留已有链接；旧 Python `COALESCE` 和 None 过滤语义均匹配。rn 59 单测 + 12 进程测试 = 71/71，strict Clippy、fmt、diff check 通过。

2026-10-01 PY07 CLI Click 错误契约：单 ID 命令与选项型 `library delete`、`content edit/export`、`accounts delete/add` 共用解析器，精确处理缺参、非法整数/浮点数、未知选项、多余位置参数、缺少选项值及 `accounts add --name` 必填错误。空 Python PATH 子进程断言 Usage、Try help、Error、stderr/空 stdout 与退出码 2；Rust 单元 59 + 进程 12 = 71/71，strict Clippy、fmt、diff check 通过。

2026-10-01 PY07 CLI Click token 消费语义：旧 Click 会把值选项后的连字符/开关样式 token 消费为值；Rust CLI 已同步普通选项、`content draft`、`library add/tag`，双向 `--analyze/--no-analyze` 采用最后一个真实开关。独立空 Python PATH 子进程覆盖 `--persona-tone -短句换行`、`--tag --style`、`--extra --save` 不误保存、以 `--no-analyze` 作标题值和连字符标签写入。rn 59 单测 + 11 进程测试 = 70/70，strict Clippy、fmt 与 diff check 通过。

2026-10-01 PY07 CLI/MCP 契约：Rust CLI 的重复字符串选项/长短别名按最后出现位置决胜，带 positional ID 的 `content edit/export`、`accounts add/delete`、`library delete` 支持选项混排；空 tags/status/output/style 与手动 profile init name/niche 恢复旧 falsey 语义。`library tag` 空值和无操作保持成功 no-op。MCP `get_analytics` 统计本账号内的软删除行以保持旧计数，但不泄漏其它账号；整数参数按 JSON Schema 接受 `1.0` 形式的整值。隔离进程与 DB 覆盖 stdio、退出码和状态；core 52/52、rn 59 单测 + 10 进程 = 69/69，strict Clippy、fmt 与 diff check 通过。

2026-10-01 PY07 CLI/MCP 标题契约：`library add` 与 MCP `add_item_from_path` 的显式空标题都按旧 Python `title or src.stem` 回退到文件名 stem；隔离无 Python PATH 子进程核验 `--title ""`、CLI 标题选项写在图片路径前、MCP 导入结果和后续列表。rn 58 单测 + 10 进程测试 = 68/68，strict Clippy、fmt 与 diff check 通过。

前序 PY07 `content draft` 契约：完整旧 Python Prompt 静态 fixture 逐字匹配；Rust CLI 的素材 ID 前后选项、重复值、连字符文本及缺参/无效 ID/未知选项/多余位置参数均由无 Python PATH 子进程回归。rn 58 单测 + 10 进程测试 = 68/68、services 22 通过/1 项受沙箱限制忽略，strict Clippy、fmt 与 diff check 通过。

前序 PY08 analytics/topics 契约：按旧行为合并当前运营账号全部已发布笔记标签（按 ID 正序、不受 UI 快照上限影响）与该账号最早 50 条采集日志关键词；热词同频保持首次出现顺序。账号归属为空的迁移日志保持隐藏，避免跨账号泄漏。core 52/52、rn 67/67、core/rn strict Clippy、Tauri lib check、fmt 与 diff check 通过。

2026-10-01 后续 CLI/MCP 契约：CLI 与 MCP `list_notes` 共用激活账号范围的直接 SQLite 查询，恢复旧 `created_at DESC`、非空 status 和 truthy item_id 条件、主素材字段过滤，不受 5000 条快照限制；CLI `library trash` 按当前账号与 `deleted_at DESC` 读取全量回收站。CLI 素材 show/analyze/tag/delete 与笔记 show/edit/export 及 MCP 单条素材/笔记工具均改为按账号和 ID 直接读取，MCP 图片导入只取当前账号 ID。MCP 草稿只取人设/参考账号区段，analytics 只计算总数，不物化 UI 列表；5001 条隔离数据验证最早记录可操作且统计准确。三个长参数 DB API 已收敛为具名输入结构体，4 条冗余 core lint 已清理；core/rn strict Clippy 通过。core 52/52；当时 rn 58 单元 + 9 进程测试 = 67/67，覆盖全部 14 工具的空态/缺失态结果类别及 `db init` 普通/JSON 成功契约；Tauri lib check、fmt 与 diff check 通过。最新 macOS arm64 `.app` 已重建，约 727 MB，主程序与随包 Node 均为 arm64，静态审计无 Python/uv/MediaCrawler。其它 CLI 输出/错误交互及 MCP 其它参数/数据库状态仍待继续验证。

任务：CHG-20260916-001；更新日期：2026-10-04；基线：HEAD `77b32563` 加共享工作区脏修改。第一方 Python 应用源码、根依赖清单和锁文件已删除；MediaCrawler 子模块仍原样保留且排除在应用运行范围之外。MCP 完整工具 schema 与旧 FastMCP 1.27 的结果序列化/错误类别已有隔离回归；真实 `rn mcp` 子进程握手、初始化前错误、14 工具列表、必填/类型参数、授权目录导入与目录外拒绝、空/缺失/软删除/失效账号状态，以及 stdout/stderr 检查通过；`get_profile` 返回字段精确覆盖旧数据库 32 个字段（含 `created_at`）并验证旧表迁移。参数和主要数据状态已有逐项回归，但所有工具状态组合仍未穷尽。CLI 全命令参数别名已有 Click fixture；无 Python PATH 的真实子进程覆盖 help/version/config、核心本地 CRUD、素材/笔记/榜样账号/profile 代表性文本、缺失对象退出码、空状态/no-op、`content draft/topic` Prompt 与参数边界、search/analyze/crawl history，以及所有声明数值参数的非法值、值选项缺值和必填参数缺失错误矩阵；Unix 伪终端已覆盖 `db init`、账号删除和素材软删除的 y/n 确认及隔离数据结果，`library analyze` 缺凭据失败后的素材数据不变也由真实子进程验证；旧 `--delete-file` 软删除、`content topic` JSON 诊断流与独立 Cargo 安装的无系统 Node/Python 基础 CLI 冒烟也已核验。Windows 终端和其它未识别边界仍待原生验收。当前全量复验 core 61/61、services 23/23、rn 64 单测 + 24 子进程 = 88/88、Tauri 48/48；四 crate strict Clippy/fmt 与 Tauri offline check 通过，普通 check/test 有两条 core private helper dead_code warning 待查。macOS arm64 `.app` 与 DMG 在 Python denylist 下构建并通过资源审计和包内 Node/Playwright/Chromium headless smoke；release contracts gate 已配置 macOS arm64/x64、Windows、Linux，远端 CI 尚未运行。MCP 客户端配置迁移、多平台发行包/签名、GUI/Web 双账号及真实 Provider/XHS 验收仍未完成。

2026-10-01 CLI 缺失对象与空编辑契约：依据隔离旧版 CLI 分支对照，素材/笔记 `show`、`draft`、`edit`、`export` 的不存在记录维持旧 stdout 提示与退出码 1；榜样账号 `show`/`delete`、确认后的素材 `delete` 对缺失对象成功返回；空 `profile edit` 成功提示；已有笔记空字段 `content edit` 仍刷新更新时间但不改内容版本。空 Python PATH 真实子进程覆盖 stdout/stderr/退出码及 JSON 错误输出。`rn` 56 单元 + 8 进程 = 64/64、strict Clippy、fmt 与 diff check 通过。其它 CLI 输出和交互仍未穷尽。

2026-10-01 CLI 非空列表与导入输出：素材列表文本补齐笔记数和合计，笔记列表补主素材 ID/话题/创建时间/合计，榜样列表补均赞/均评/均藏/抓取时间；普通模式素材导入恢复旧成功文案和详情。空 Python PATH 子进程隔离 DB 核对各字段、时间戳、输出流，JSON 模式未变。其它 CLI 分支的完整 stdout/stderr、退出码及交互仍未穷尽。

2026-10-01 `content draft/topic` 文本输出：draft 恢复人设/参考账号提示、旧式分隔线和标题；保存回执进入 stdout，并使用 Rust `rn content edit ID` 后续命令。topic 恢复选题标题和分隔线包装。隔离进程核对已初始化人设、保存草稿提示与选题输出首尾，`--json` 仍单独输出 JSON 对象。其余参数组合和 AI 服务错误输出仍待。

2026-10-01 `library tag` 文本/匹配语义：普通输出按旧 CLI 在 add、remove 每一步分别报告标签，支持同一命令按 add 后 remove 顺序执行；标签重复与删除采用区分大小写的精确匹配。隔离子进程断言逐步文案。其它素材操作和分析失败输出仍需基准。

2026-10-01 `library list` 查询语义：素材过滤移入 LocalDb SQL，按当前账号限制并恢复旧 `created_at DESC LIMIT 50`；标签 JSON 与风格均按 SQLite `LIKE` 匹配，空过滤值不筛选。核心数据库回归验证 `%`/`_` 通配、ASCII 大小写、风格子串、排序和 filter-before-limit。完整 CLI 参数/错误码与交互矩阵仍待。

2026-10-01 删除确认：素材与榜样账号删除支持旧终端 `[y/N]` 提示、`y` 继续及取消 `Aborted!`/退出 1；空 stdin 取消后真实子进程验证素材/账号仍存在。`--yes` 免提示；`--json` 没有 `--yes` 时明确报错，避免在 JSON stdout 混入交互文本。

2026-10-01 `accounts show` 输出：固定测试账号核对旧 Rich CLI 文本输出的均赞/均评/均藏小数格式、风格 description、高赞标题、录入时间与粉丝数隐藏行为；录入时间取自同一行 JSON 返回的 `crawledAt`。CLI 其它文本输出仍无完整逐命令 fixture。

2026-10-01 CLI 详情/操作输出：`library show`、`content show` 的文本详情对齐旧字段布局，素材详情覆盖路径、风格/材质/颜色/场景/标签及分析卖点/搭配（存在时），笔记详情覆盖状态、素材/参考账号、标题、封面、正文与话题；另核对 `content export --output` 和 `library delete` 成功提示。隔离子进程断言对应 stdout/stderr；其它 CLI 命令完整输出仍待 fixture。

2026-10-01 CLI 空状态对照：临时旧版 CLI 对照得到空图库“图库为空”、空账号“暂无榜样账号数据，可用 accounts add 手动录入”、空笔记“暂无笔记”及未初始化 profile 成功引导。Rust CLI 对齐三种空列表和 profile 文本/JSON 行为；账号提示省去已退役的 Python crawler 命令。进程测试用隔离 DB 和空 Python PATH 检查退出码、stdout、stderr。旧归档初始化约束只在 `/private/tmp` 临时副本修正，不修改当前仓库。

2026-10-01 `content topic` 输出补充：真实 CLI 子进程以隔离素材库验证空图库 JSON、显式 ID 保序/保留重复/忽略缺失、空 `--item-ids` 与 `--analysis-file` 等价于未指定、最多 5 个 hook/3 个标题、标题字段回退、榜样账号名称/互动统计、extra，以及分析文件缺失时的 plain stdout 告警和 JSON 模式 stderr 告警。service 单测使用结构化 `content_style` 核对标题风格/情绪调性；旧 `accounts add --style` 自由文本存入 description、旧 topic builder 忽略该键的行为也由子进程 fixture 锁定。完整提示词已固化到 `client/services/tests/fixtures/legacy_topic_prompt.txt`，逐字校验换行、榜样风格/浮点互动值、分析摘要、选题指南、人物设定、任务与补充要求；其它 CLI 命令输出 fixture 未完成。

2026-10-01 MCP 边界补充：真实 LocalDb 隔离测试覆盖空 `tag/style/status` 不启用过滤、`list_notes item_id=0` 不启用过滤、SQLite `LIKE` 的 ASCII 大小写与 `%`/`_` 通配匹配、filter-before-limit、`list_items` 默认最多 50 条及创建时间倒序；`list_notes item_id` 只匹配旧 manager 使用的主素材 ID。`tag_item` 接受空字符串、仅去重完全相同标签、大小写不同标签分别保留，并可精确删除。缺失及跨账号 tag/save 错误保持 FastMCP `isError=true`，对两种情况统一使用 ID 不存在文案，不向当前账号泄漏另一账号记录。MCP item/note 返回值按旧 Pydantic 字段精确投影，回归断言 account_pool、updated_at、video_path 和无内部版本字段；无编辑字段 `save_note` 仍触碰更新时间。新增无 Python PATH 的 `rn mcp` 子进程契约：显式授权目录图片导入后可列表读取，目录外同级路径被拒绝；不启用分析服务。双账号隔离回归验证 `get_analytics` 只返回当前运营账号计数，并验证 `list_accounts` 的旧字段形状、`top_notes` 和均赞降序。其它 tools/call 状态组合仍待补齐。旧 `get_analytics` 用无账号条件的全库计数；Rust 版本限定激活账号计数，防止账号间聚合泄漏，字段形状不变，这是保留账号隔离边界的显式差异。

本表保留第一方 Python 入口的迁移基线，并记录当前 Rust / 扩展替代状态。旧 FastAPI 源码已删除；清理前自动发布、平台登录探测及部分 crawler/profile 兼容路由曾按确认范围返回 HTTP 410，现不再存在 FastAPI 服务可供调用。Rust HTTP adapter 中仍保留的 410 是明确退役能力的当前行为。执行者开始下一阶段前须重新核对实时工作树；当前存在与浏览器插件、Rust 模块拆分等相关的共享工作区修改。

2026-10-08 PY10 debug 启动补充：debug `BrowserWorkerManager` 使用仓库内 `client/browser-worker`，无需查询 bundle-only `resource_dir`；该调用现仅在 release 构建执行。Tauri 51/51、strict Clippy/fmt 通过。Python 替代契约无新增缺口；编译期 QA release app 资源扫描通过，但 CUA 未显示隔离窗口，因此原生产品验收仍为未验收。

2026-10-01 PY07 查询增量：MCP `add_item_from_path` 只读取当前账号 ID，`tag_item`、`draft_note_prompt`、`get_note`、`save_note`、`publish_note`、`export_note` 不再依赖 UI 工作区快照查单条素材/笔记；草稿只读取 references/profile，analytics 读取精确账号计数。超过 5000 条的回归通过。rn 57 单元 + 8 进程测试通过；CLI 全量输出契约和 MCP 其余状态组合仍未穷尽。

2026-09-30 Rust CLI 退役增量：旧 Click 命令的参数、类型、默认值、选项和别名已导出为基线 fixture；自动回归确认 Rust 帮助保留每个旧选项名与别名。新增进程级覆盖：PATH 不含 Python/uv/pip 时检查 help/version、MCP config 和错误码，并在隔离 DB 真实执行素材导入/标签、建稿、笔记编辑/导出、榜样 CRUD、回收站恢复及引用保护。用户手册与贡献指南已切换 Rust；删除 Python CLI 和 `rn` Python console-script，移除 `click`/`rich` 第一方直接依赖（click 仍由开发依赖的其它包传递引入）。所有命令分支的 stdout/stderr、错误码与交互提示全量 fixtures 仍待补。

2026-09-30 Web/采集增量：`scripts/start.sh` 现构建并启动 Rust `rn serve` + Vite；`api.ts` 写入必须先取 `/api/session`，不再对 FastAPI 404/405 降级为无令牌写请求。静态归并前端 `api.*` 调用得到 63 种 method/path 形态，逐项核对到 Rust handler 家族；loopback health、Vite 首页、Origin 会话发放和启动/停止端口释放冒烟测试通过。旧 `crawler/xhs_search.py` 已删除，`rn search`/可见页面 worker 接手有界搜索与 JSON 输出；标准标题/描述/互动数/标签/笔记 URL 字段有 worker fixture，旧 MediaCrawler 原始 CSV 的其它扩展列与平台热度排序不再模拟，搜索顺序遵循页面可见顺序。真实页面与双账号仍待产品验收。第一方 Python 源和根目录 Python 依赖/锁文件已删除；无 Python 环境、多平台发行与剩余 CLI/MCP 契约验收仍待。

## 1. Web/FastAPI 路由覆盖

旧服务曾由 `app/server.py` 在 8765 端口承载；下列 router 为已退役服务的契约基线。当前由 Rust 领域服务及 Tauri / CLI / MCP / Rust HTTP adapter 替代；桌面直连本地领域服务，Web 开发脚本启动 Rust HTTP adapter。

| 领域 / 旧路由 | 旧行为与主要调用方 | Rust 替代目标 | 状态 / 退出证据 |
| --- | --- | --- | --- |
| 服务 `GET /health`, `GET /` | Web 启动脚本健康检查、版本提示；旧桌面 `BackendGate` 已删除且不再阻塞 UI | Rust sidecar/HTTP `health` 与版本信息；桌面 runtime status | `rn serve` 返回 Rust 名称/版本与健康状态；2026-09-30 loopback 冒烟已验证真实 listener 与 Vite 启动脚本；完整 Web 页面/双账号仍待产品验收 |
| 写入会话 `GET /api/session`（Rust adapter 新路由） | Rust Web API 写操作的本机 CSRF/Bearer 闸门 | 每进程随机令牌 + Origin allowlist | 已发放 `no-store` 会话令牌；所有非 GET/HEAD/OPTIONS 请求校验 Origin 与 Bearer。前端现必须先获取令牌，旧 FastAPI 不支持会话时会显示明确错误而不降级无令牌；adapter 写路由与 API 调用覆盖待真实 Web 流程验收 |
| 素材 `GET/POST /api/library/`; `GET /{id}`; `POST /{id}/analyze`; `PATCH /{id}/tags`; `DELETE /{id}` | 列表/详情、multipart 导入、视觉分析、标签、软删及可选删文件 | LocalDb 资产服务 + 文件选择导入 + Rust Model API | Rust HTTP 已支持账号范围列表/详情、tags 写入与软删；multipart `file/title/analyze` 已接入，文件名目录被剥离、图片 MIME/签名校验、单图 25 MiB，写入当前账号托管目录；可立即返回并后台复用 Rust MiniMax VLM 分析，按当前账号与 image_version 条件写回；重新分析也异步返回当前素材。隔离测试覆盖二进制图片回读与非法 MIME 拒绝。真实 VLM、实际 Web upload/UI 刷新和双账号验收仍待完成 |
| 素材回收站 `GET /trash/list`; `POST /trash/{id}/restore`; `DELETE /trash/{id}/purge`; `DELETE /trash/purge-all`; `GET /{id}/image` | 回收站、恢复、永久清理、图片读取 | LocalDb 回收站及受限 image command；Rust HTTP 若确有 Web 使用 | Rust HTTP 已支持回收站列表/恢复/单项及全部清理和账号范围图片读取；purge 仍验证托管路径并阻止笔记引用，批次最多 100 项。AC：跨账号及笔记引用保护 |
| 笔记 `GET /api/content/`; `GET /{id}`; `POST /`; `PATCH /{id}`; `PATCH /{id}/status`; `PATCH /{id}/stats`; `DELETE /{id}`; `GET /{id}/export` | 筛选、详情、增改、状态/统计、删除、Markdown 导出 | LocalDb notes / stats + 公共 Markdown formatter | Rust HTTP 已支持列表筛选、详情和 Markdown 导出，以及创建、局部编辑、状态/互动数据更新、回收站软删除；所有写入受 Origin/Bearer 闸门和 1 MiB body cap 保护，并限定激活账号、验证素材归属及 content_version。`notes.video_path` 现有新旧库迁移和 Rust LocalDb 创建/编辑/读取，但旧字段端到端 HTTP fixture 与视频选择/发布仍待；`account_ref` 是创建/关联字段，不属于旧 NoteUpdate |
| 创作 `POST /api/content/draft`, `/draft/multi`, `/draft/generate` | 基于素材/榜样/知识的单篇、多篇和 AI 生成 | 共享 Rust prompt/service + Model API，Tauri/CLI/MCP 调用 | Rust HTTP 已覆盖三个旧路由：单素材 Prompt 支持可选保存，多素材 Prompt 原子保存有序关联，AI generate 使用本地默认 Provider、解析标题/正文/CTA/标签并原子写笔记；响应保持旧字段，AI 失败不会留下空草稿。素材/榜样/知识上下文限定激活账号，最多 9 张素材。隔离测试覆盖 Prompt 返回/存储顺序、解析和 Provider 缺 key 时不写入；rn 31 tests、strict Clippy 通过。真实 Provider 输出、逐字节旧 Python fixture、Web UI 调用切换和产品验收待完成 |
| 发布准备 `POST /api/content/{id}/stage-images`; `GET .../stage-images/{filename}`; `DELETE .../stage-images`; `POST .../open-stage-dir` | 暂存图片、HTTP 取图、清理、打开文件夹 | LocalDb stage + Tauri opener；Rust HTTP 为 Web 兼容入口 | Tauri 与 Rust HTTP 暂存/取图/清理/打开已实现；暂存和读取校验激活账号与笔记归属，拒绝路径穿越/符号链接并限制单图 50 MiB；隔离测试覆盖顺序、PNG 回读、跨账号、路径穿越及清理后 404。真实浏览器文件传输、操作系统文件管理器及各平台产品验收待完成 |
| 发布 `POST /api/content/{id}/publish-auto`; `GET /{id}/publish-status/{job_id}` | 旧 Python 子进程自动点击平台发布并轮询进程内状态；脚本可处理文字、图片和视频 | 已确认 D4：发布助手/outbox + 浏览器扩展差异预览与确认式填充，最终由用户提交；本地记录发布回执 | Rust adapter 对已退役路由返回 410；Python 自动提交子进程与状态轮询已移除。Tauri outbox 覆盖 prepared/submitted/unknown/confirmed；Web 发布助手可填文字、交付图片并由用户人工发布，结果不明不重试。视频路径契约已恢复，但视频选择、传输、页面填充与产品验证仍待 |
| 发布登录 `GET /api/content/xhs-login-status` | 旧 Python 脚本读取共享浏览器会话探测登录态 | 账号池受控浏览器 session lifecycle；用户手动完成并判断登录 | Rust adapter 对已退役路由返回 410；旧 FastAPI 在整体删除前曾返回 410。新会话由 Rust worker 隔离管理，不继承旧 Cookie/profile。worker status 只说明进程运行，不伪称已验证平台登录 |
| 榜样账号 `GET/POST /api/accounts/`; `GET/PATCH/DELETE /{id}` | 参考账号 CRUD | LocalDb reference account | Rust HTTP 已支持当前账号列表/详情及创建/Upsert、局部更新和删除；列表按均赞降序，局部更新保留未提交的统计、热门笔记与风格字段，写入验证激活账号作用域。真实 HTTP 和双账号 Web 验收待完成 |
| 榜样智能 `POST /{id}/analyze`; `GET /{id}/insights`; `POST /{id}/imitate` | 主页抓取、AI 分析/缓存、仿写 | 有界浏览器 worker + Model API + reference service | Rust HTTP 三条 AI 路由均已迁移：analyze 流式分析并账号范围写回风格；insights 保留缓存/refresh/SSE 并写回洞察；imitate 保留旧 JSON Prompt 响应。主页采集由共享 worker 提供并另见 crawler 行；未配置 Key / 缓存和账号隔离有 fixture，真实供应商与页面验收待做 |
| 当前人设 `GET/PATCH /api/profile/`; `GET /refresh-status`; `POST /refresh` | 账号人设读写和异步平台资料刷新 | LocalDb profile；扩展 Native Messaging 快照；共享 worker 任务状态 | Rust HTTP 已支持读取/完整字段 PATCH；Web `POST /refresh` 和 `GET /refresh-status` 已接共享 JSONL worker 并保留异步响应/状态字段，主页 ID 精确匹配本人绑定账号后同步资料与最多 30 篇去重笔记；桌面仍可用扩展主页快照和独立 worker。主页卡片最多滚动 16 次，遇登录/验证先停止；笔记保留手工标题/正文，部分加载不覆写汇总，完整且字段齐备才更新聚合。fixture 与隔离 DB/HTTP 测试通过，真实 DOM/Chrome/Edge 产品验收待做。旧 FastAPI refresh/status 在整体删除前曾返回 HTTP 410；目前没有 FastAPI 服务或 Python 子进程。 |
| 分析 `GET /api/analytics/summary`, `/notes`, `/insights`, `/notes-trend`, `/topics` | 运营统计、排序、洞察、趋势、话题 | LocalDb 查询 + Rust 聚合/AI 服务 | Rust HTTP 已支持五个读取路由并限定当前账号；`days_since_publish` 和趋势使用 SQLite 本地日期，隔离临时库 fixture 已覆盖排序、话题、洞察及空态。`topics` 直接按当前账号、ID 正序全量读取已发布笔记标签（不受 UI 快照 5000 条上限影响），并合并该账号最早 50 条 `crawl_logs.keywords`；SQLite 隔离回归验证行顺序、标签/关键词计数与同频先出现顺序。迁移后账号归属为空的日志不参与统计以避免错误归属或跨账号泄漏 |
| AI `POST /api/ai/chat`, `/inspire`, `/quick` | SSE 对话、灵感、快捷操作 | Rust Model API + 统一 prompt service / Tauri event | Rust HTTP 已覆盖三路：quick 调本地默认 Provider 并保留 JSON `{text}` / `{error}`；chat 与 inspire 返回兼容 SSE，断连取消上游；OpenAI / Anthropic 请求格式、输入和响应上限、密钥不回显。chat 拼装当前账号人设/素材/笔记上下文，inspire 使用当前账号素材/榜样/已发布洞察并保留旧 Prompt。MiniMax env / 项目 `.env` 仅过渡读取。rn 隔离 handler 测试覆盖错误契约；rn 31 tests、rn/services Clippy 通过。真实 Provider、真实 listener、Web 调用迁移及对话逐字段 fixture 待验收 |
| 浏览器 `POST/DELETE/GET /api/crawler/browser`; `POST /open-url` | 按账号启动/关闭/检测 MC 浏览器、发送 URL | Rust supervisor + Playwright JSONL worker；Web 外链由浏览器新标签处理 | Web `GET/POST/DELETE /api/crawler/browser` 已接账号隔离 worker：支持 account_id 指定/缺省激活账号、退休账号不可启动，状态只回 running 与账号 ID，不泄露旧 profile 路径；账号池 Web 端原有三个 API 调用可由 Rust 接管。worker 缺失明确返回 503；路由/参数隔离测试已通过。Web 普通外链已不再调用 `/open-url`；该路由暂无前端调用。旧 FastAPI 浏览器/open-url 路由在整体删除前曾返回 HTTP 410；目前由 Rust 维护仍需保留的 Web API，Tauri worker commands 另支持清除受管会话。release 流程在 ARM64 macOS Chromium fixture 和 `.app` bundle 通过（约 521 MiB worker resources）；Intel macOS/Windows/Linux release 未实跑。 |
| 采集 `POST /api/crawler/creator`; `crawler/xhs_search.py`（已删除） | 榜样主页 SSE；独立关键词脚本输出 JSON | PY04 worker + Rust 持久化/任务流 | Rust `/api/crawler/creator` 保留旧 SSE 事件形状和运营账号 428 风险确认，走账号隔离的共享 worker；只读取主页，不保留临时 query/fragment，ID 校验后按激活账号池保存榜样元数据与最多 30 篇笔记。旧 Python `xhs_creator.py` 与 `crawler/` 脚本已删除；旧 FastAPI crawler 路由在整体删除前曾返回 HTTP 410，目前无 FastAPI 服务。`search-notes` 与 `rn search` 已接手搜索页可见卡片与 JSON 输出，每次最多 50 篇、最多 5 个关键词，限制滚动并去重；输出覆盖下游分析使用的标题/描述/互动数/标签/笔记 URL，不复制 MediaCrawler CSV 未使用的扩展列。平台热度排序改为页面当前可见顺序，未使用私有接口模拟；真实 XHS 页面/排序及双账号验收待做。旧实现未采集评论，本次也未新增该能力。 |
| 设置 `GET/PATCH /api/settings/env` | 读取/写回旧 `.env` 配置 | Rust 应用配置和系统 keychain/受限配置存储 | Rust 兼容路由已保持旧 snake_case 字段、MiniMax API Key 掩码与 Base URL 行为；PATCH 更新 SQLite `model_api_settings_v1` 并记录迁移标志，不回写 `.env`；旧环境变量/`.env` 仅只读兼容至首次保存。仍待真实配置迁移说明、密钥存储升级评估与完整前端验收 |
| 提示词 `GET/POST/PUT/DELETE /api/settings/prompts` | 快捷 prompt CRUD | LocalDb app_settings/prompt configs + shared service | Rust HTTP 已支持账号隔离读取及带 Bearer/Origin 闸门的 POST/PUT/DELETE（1 MiB body cap）；隔离库覆盖新增、部分更新、删除与 snake_case 输出。前端令牌接入和旧键/默认值完整 fixture 待完成 |
| 知识 `GET/PATCH /api/knowledge/rules`; my-samples GET/PATCH; ref-samples GET/POST/DELETE; inspirations GET/POST/DELETE | 规则、自己的样本、参考样本和灵感 CRUD | Rust memory/knowledge/browser services | Tauri 的互动规律 key 与 Prompt 注入服务一致；本人已发布样本逐篇启停和榜样样本增删由本地 commands 提供，当前账号隔离。Rust HTTP adapter 已支持四组旧知识路由读写；ref-samples GET 原样保留旧 JSON 中的未知字段，POST 标题去重、DELETE 按索引；inspirations 保留旧字段并软删除；写入走 Origin/Bearer 闸门。隔离测试覆盖新 `top_notes`、旧 `ref_notes`、字段保留、增删、去重和账号边界；`rn serve` 现为浏览器启动脚本默认后端，42 项 rn tests、strict Clippy 与前端 build 通过。真实 Web 浏览器双账号和逐字段契约验收仍待 |
| 账号池 `GET/POST/PATCH/DELETE /api/account-pool/`; `/active`; `/{id}/activate`; `/{id}/mark-banned`; `/protection/status` | 账号池、激活、封禁、保护状态 | LocalDb accounts + Rust HTTP adapter | Rust HTTP 已支持兼容列表、激活读取、创建、局部更新、激活、封禁、退休和 protection status；写入经 Origin/Bearer 闸门，保护激活账号不被封禁/退休或停用，记录粉丝数、平台 ID、备注、封禁次数与最后使用时间。真实网络与浏览器端验收、前端令牌切换待完成；Web delete 在本地实现为保留数据的退休 |

`/api/crawler/search` 不是当前 router 暴露的路由；搜索脚本是直接 Python 入口，须纳入 worker 命令矩阵，不得虚构现有 HTTP 能力。

## 2. CLI 命令矩阵

旧入口曾来自 `pyproject.toml` 的 `rn = app.cli:cli`；`app/cli.py` 与该 console-script 已退役。基于隔离导出的旧 Click 参数 fixture，Rust CLI 帮助已自动核对所有选项名和别名；空 Python PATH 的真实子进程已检查 help/version、`mcp config`、非交互建库拒绝、主要本地 CRUD、列表和详情文本/JSON、完整 draft/topic Prompt、全数值参数非法值、值选项缺值、必填位置参数缺失、缺失对象、no-op、trash/restore/purge、搜索/采集/分析输出流。Unix 伪终端已覆盖数据库初始化、榜样账号删除和素材软删除的 y/n 确认；`library analyze` 缺凭据失败、`content topic` 分析文件缺失时普通/JSON 输出流和数据库不变也已由黑盒回归覆盖。Windows TTY 与其它尚未识别的边界仍待核验。Rust `rn` 由同一原生 binary 提供；数据库路径保持 `DB_PATH`/`data/app.db` 兼容，新库首次创建要求显式 `--yes` 或终端确认。

| 命令组 / 子命令 | 旧行为 | 替代实现状态 |
| --- | --- | --- |
| `rn db init` | 初始化/迁移数据库 | Rust LocalDb 已实现；缺失库时打印完整路径并要求 TTY `[y/N]` 或非交互 `--yes`，拒绝静默建库；隔离库黑盒 QA 已通过 |
| `rn library add IMAGE [--title] [--analyze/--no-analyze]` | 导入图片，可选 VLM 分析 | Rust CLI 支持 JPEG/PNG/WebP/GIF/AVIF，默认 VLM 调用 MiniMax `/v1/coding_plan/vlm`，`--no-analyze` 跳过；标题选项允许位于素材路径前，重复值取最后值，空标题回退文件名 stem；真实供应商请求待验证 |
| `rn library list [--tag] [--style]` | 过滤素材，created_at 倒序，默认最多 50 条 | LocalDb 当前账号 SQL 查询，复用 SQLite `LIKE` 的 tag/style 子串、ASCII 大小写与 `%`/`_` wildcard；文本/JSON 均只取一页 |
| `rn library show ID` | 多行素材详情；缺失时 stdout 提示并退出 1 | LocalDb 详情显示路径、风格/材质/颜色/场景/标签与可用分析卖点/搭配；代表性文本详情及缺失退出契约已核对 |
| `rn library analyze ID` | 对现有素材重新执行图片分析（与 Web analyze 路由同一行为） | Rust VLM 服务和 LocalDb 写回已实现；无 Python PATH CLI 子进程验证缺凭据错误流/退出码与失败原子性，services 本地 HTTP mock 验证 MiniMax 请求/响应契约；真实供应商请求待验证 |
| `rn library tag ID [--add TAG] [--remove TAG]` | 修改标签；Click 允许选项前置/后置、重复项取最后值、空值不触发操作 | Rust 账号范围元数据更新已对齐标签精确匹配与逐步文案；参数顺序、重复/空值及 no-op 有隔离进程契约，JSON no-op 返回原记录 |
| `rn library delete ID [--delete-file]` | 删除素材（旧 `--delete-file` 参数在实现中未实际删文件）；成功提示勾号文案，缺失对象提示后成功返回 | Rust `--yes` 软删除并保留文件；接受旧 flag 并提示其无删除效果，成功文案和缺失 ID 的 no-op 提示已核对 |
| `rn library trash`; `restore ID`; `purge ID --yes` | 回收站列表、恢复、永久删除 | Rust 已实现；账号边界、笔记引用阻断、仅清理由本图库管理文件复用 LocalDb 防护 |
| `rn content draft ITEM_ID [--account-id] [--extra] [--save]` | 根据素材+参考账号与经验库生成 prompt/草稿 | Rust service 的整篇旧 Python Prompt 已由静态 fixture 逐字对照；真实 CLI 子进程覆盖参数可在素材 ID 前后、长/短账号参数、重复 `--extra` 取最后值、连字符开头的要求、保存提示和缺参/类型/未知/多余参数 stderr/退出码；其它命令的全量输出/错误 fixture 仍待 |
| `rn content topic [--account-id] [--analysis-file] [--extra] [--item-ids]` | 话题/批量创作 | Rust CLI 已迁移素材、分析 JSON 热信号、参考账号和 extra 的 5 选题 Prompt；隔离子进程 fixture 核对空态 JSON、显式 ID 保序/重复/缺失过滤、空可选参数、5 hook/3 标题、标题 fallback、extra 和 stdout/stderr 告警分流；完整旧 Prompt 逐字 fixture 及榜样账号创建/选用已核对 |
| `rn content list [--status] [--item-id]` | 按状态/素材筛选笔记，按创建时间倒序 | LocalDb 账号范围 SQL 查询；真实 CLI 子进程跨两个素材混合 draft/ready，验证两组匹配与两组交叉空结果；文本列表/时间戳与 JSON 输出已有 fixture |
| `rn content show NOTE_ID` | 多行笔记详情；缺失时 stdout 提示并退出 1 | LocalDb 详情显示状态、素材/参考账号、标题、封面、正文和话题；代表性详情与缺失退出契约已核对 |
| `rn content edit NOTE_ID [fields...]` | 编辑标题/正文/封面/标签/状态；无字段也允许并刷新更新时间 | Rust optimistic version 更新及危险状态限制；无字段沿用账号范围 touch，不改内容版本；缺失对象提示/退出码已核对 |
| `rn content export NOTE_ID [--output]` | Markdown 导出；写文件时打印勾号成功提示，缺失时 stdout 提示并退出 1 | shared Markdown formatter；写文件成功与缺失对象退出契约已由隔离子进程核对 |
| `rn accounts list/add/show/delete` | 榜样账号 CRUD；show/delete 缺失时提示并成功返回；show 显示均赞/均评/均藏、结构化风格、高赞标题和录入时间 | Rust CLI 已迁移账号隔离 CRUD；`accounts add/show/delete` 成功与缺失对象文案已核对。非空 list 的 JSON/text fixture 验证 `crawled_at` 倒序、多行顺序、ID 24 字符截断、浮点统计和时间格式；`show` 验证均赞/均评/均藏、结构化风格/高赞标题/录入时间。其它参数组合仍待 fixture |
| `rn profile init/show/edit` | 人设初始化、分区详情、编辑；`edit` 无字段时成功提示“未指定任何字段，无变更”；`init --url` 抓取主页/笔记、AI 推断，手工字段优先，AI 失败继续保存抓取资料 | Rust CLI 手动 profile/统计字段与 `init --url` 已实现；临时 Node worker 子进程验证 JSONL 协议、完整主页/统计写入、无 Provider 时继续保存和 worker shutdown；普通文本的抓取进度、AI 失败提示、推断摘要/保存回执及 JSON stderr/stdout 分流均已核对。真实 DOM/登录态、Provider 及产品验收仍待 |

注意：参数/别名基准与帮助覆盖已自动核验；`content draft/topic` 完整旧提示词与主要 stdout/stderr 已由 fixture 和隔离子进程核验。Unix 伪终端已验证数据库初始化、账号删除和素材软删除的 y/n 确认；Windows 终端及其它低频分支仍需逐项对照。素材 AI 有本地 mock 请求/解析和缺凭据失败原子性覆盖，真实供应商验证另列待验收。

## 3. MCP tool 契约

迁移辅助：`rn mcp config [--db PATH]` 已输出含绝对 binary/database 路径的 `mcpServers` 配置片段，不写用户文件；README 提供构建与手工合并说明，用户配置切换待用户执行。旧 Python MCP 源及 `mcp[cli]` 第一方依赖已删除。旧 FastMCP 1.27 的完整 14 个 tool 定义 fixture（名称、说明、完整 inputSchema）与 Rust 输出的前 14 项精确对照；新增 8 项工具追加在末尾，原工具名称、说明和 schema 保持不变。工具调用文本序列化、成功错误对象、异常 `isError`、未知工具和未找到对象有 Rust 隔离测试。真实子进程覆盖 MCP initialize、初始化前拒绝 list、22 项 tools/list、null 参数错误、缺必填参数、素材不存在业务结果、授权目录导入与目录外拒绝；stdout 仅 JSON-RPC、stderr 为空。Schema 校验回归覆盖所有必填字段、null/数组/数字/字符串等非对象根参数、全部 `default: null` 可选属性的显式 null 输入、全部已声明属性的无效类型和字符串数组的无效成员；校验错误沿用 FastMCP 的 `Input validation error` 类别，旧可选 null 则进入工具执行。隔离数据库回归覆盖 Python falsey 空过滤值、style 子串、标签空值/大小写、有效/无效分析 JSON 及错误分类；软删除素材/笔记由列表和详情隐藏，tag/save/publish 拒绝写入，draft/export 返回旧“未找到”成功错误对象，同时 analytics 按 legacy 契约计入软删除行。双运营账号隔离测试证明素材/草稿列表与详情遵守当前激活账号边界，跨账号标签和笔记修改被拒绝且数据不变；全部 22 个 tools/call 在有效数据与参数下，遇到不存在/损坏/null 激活账号引用、assistant 角色及 banned/suspended/retired operation 账号时均 fail-closed，不回退到全库。新增记忆工具固定 `origin=pc`，经验工具显式限定 PC 来源，手机记忆缓存及经验源数据不可通过 MCP 写入；替代关系只能指向同账号 PC 记忆。`search_notes` 使用原账号内直接笔记查询，覆盖标题、正文、标签和封面文案，带 1–100 条结果上限，不改变旧 `list_notes` schema。记忆与经验更新遵循省略字段保留、显式 null 清空/恢复默认。RN 全量为 65 单测 + 23 子进程测试 = 88/88，strict Clippy、crate fmt 与 `git diff --check` 通过。隔离回归覆盖来源和账号边界、状态机、写作经验启停、替代关系目标、搜索及空值语义；不把自动测试表述为任意组合穷尽。Rust tool schema fixture 位于 `client/rn/tests/fixtures/python_mcp_tool_schemas.json`。

旧 MCP 为 Python `mcp` 包的 stdio server。Rust MCP 需保留 tools/list schema 与 tools/call 的名称、参数、结果和错误类别，stdout 仅 JSON-RPC，诊断到 stderr。所有操作使用旧语义的当前激活运营账号；新版本需明确账号 ID 和绑定校验，不能意外跨账号。

| tool | 参数 / 主要结果 | 目标 Rust 服务 | 注意 |
| --- | --- | --- | --- |
| `get_profile` | 无；人设对象 | profile / account | Rust 输出与旧 `my_profile` 行完整 32 字段一致（含 `created_at`）；缺 profile 保留旧 error object 结果分类；profile 查询尊重激活账号范围 |
| `update_profile` | tone/taboos/rhythm/hashtag pool；更新对象 | profile update | 参数均可选，保持未传字段 |
| `list_items` | tag/style；素材数组 | asset query | 账号过滤 |
| `get_item` | item_id；素材详情 | asset detail | 不返回任意磁盘路径的可读权限 |
| `add_item_from_path` | image_path/title/analyze；素材对象 | safe file import / AI | Rust MCP 已注册工具；导入要求配置 `AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR`。无 Python PATH 子进程验证授权 PNG 导入、空标题回退到文件名 stem、结果列表读取及目录外路径拒绝（`analyze=false`）；`analyze=true` 复用旧 MiniMax VLM 契约并于成功后导入/写分析，真实供应商链路待验证 |
| `tag_item` | item_id/tag/action；素材对象 | asset metadata | action add/remove |
| `draft_note_prompt` | item_id/account_id/save；prompt + optional saved draft | prompt builder / note create | account_id 是参考账号，不混淆账号池 ID |
| `list_notes` | status/item_id；笔记数组 | note query | 状态 draft/ready/published |
| `get_note` | note_id；笔记详情 | note detail | 当前激活账号 |
| `save_note` | note_id/title/body/tags/cover_desc；更新对象 | note update | 版本冲突错误保留 |
| `publish_note` | note_id/note_url；更新后的笔记 | note status | **仅标记本地 published 并存 URL；绝不触发平台发布** |
| `export_note` | note_id；Markdown 导出 | shared formatter | 同一导出格式 |
| `list_accounts` | 无；榜样数组 | reference list | 均赞降序语义 |
| `get_analytics` | 无；汇总对象 | analytics query | 图库数、状态、均赞评藏 |
| `search_notes` | keyword/status/item_id/limit；笔记数组 | account-scoped note query | 搜标题、正文、标签、封面文案；默认 20、最多 100 条 |
| `list_memory_entries` | kind/confirm_status/enabled；PC 记忆数组 | LocalDb memory query | 固定当前账号 + `origin=pc`，不读手机缓存 |
| `save_memory_entry` | memory_id/kind/content 与可选元数据；记忆对象 | LocalDb memory create/update | 新增固定 `origin=pc`；编辑只接受本账号 PC 记忆；省略保留、显式 null 清空/恢复默认 |
| `set_memory_entry_state` | memory_id + enabled 或 confirm_status；记忆对象 | LocalDb memory state machine | 每次一种状态变更；替代目标必须属于当前账号且为 PC 来源 |
| `delete_memory_entry` | memory_id；删除回执 | LocalDb memory delete | 仅本账号 PC 记忆；手机缓存拒绝操作 |
| `list_experience_prompts` | 无；PC 写作经验数组 | LocalDb experience query | 固定当前账号 + `origin=pc` |
| `save_experience_prompt` | experience_id/title/content/enabled/apply_scope/apply_target/source/sort_order；经验对象 | LocalDb experience upsert | 创建/更新/启停固定本账号 PC 来源；启用数量上限由 DB 校验 |
| `delete_experience_prompt` | experience_id；删除回执 | LocalDb experience delete | 固定本账号 + `origin=pc`，手机缓存拒绝操作 |

## 4. 直接脚本、运行时和分发依赖

| 入口 | 当前证据 | 目标 / 删除条件 |
| --- | --- | --- |
| `app/cli.py`（已退役） | 旧 Python Click 命令树由 `pyproject.toml` console-script 暴露 | Rust `rn` 覆盖原命令组；参数/别名、help/version、配置、CRUD、文本/JSON 输出、17 个 profile 编辑字段、参数错误、搜索/分析和 Unix y/n 确认已有空 Python PATH 的隔离子进程回归；`content topic` 缺分析文件的 JSON 输出流也已核验。当前 64 单测 + 24 子进程 = 88/88；Windows TTY 与其它边界仍待核验 |
| `crawler/` Python 脚本（已退役） | 搜索、作者与主页采集曾依赖 MediaCrawler 和 Python 子进程 | `rn search`、Rust HTTP creator/profile refresh 与独立 Node worker 承接有界可见页面采集；搜索字段、主页/笔记采集、账号隔离、任务恢复和进程清理有 fixture。真实小红书 DOM、登录与原生产品流程仍待验收 |
| `crawler/xhs_analyze.py`（已退役） | 读取采集 JSON、计算互动分数/钩子词和终端报告，可选记录 `crawl_logs` | Rust `client/services::search_analysis` + `rn analyze` 已替代统计、报告、终端输出和可选写库；旧脚本删除前以临时匿名输入生成 JSON 与 console 基准，Rust fixtures 核对别名、“万”、Python ties-to-even 均值、hook 顺序、Top 排序、字段过滤和全文报告。`crawl_logs` 新行增加 `account_pool_id`，旧行保留。Rust 按激活账号写入历史；Python 旧脚本对照期结束并已删除 |
| `crawler/xhs_publish.py` | 独立自动发帖脚本支持文本/图文/视频并自动点击最终提交 | 按 D4 退役自动提交，但迁移旧文本、图片、视频填充能力；最终提交由用户完成 | Python 文件及 API 子进程调用已删除；文字/图片/视频均可在用户确认后尝试填入，视频通过账号受管分块存储、outbox token 分块读取、签名与摘要校验和唯一 video input 回执；Rust/扩展 fixture 覆盖成功、失败、重试与不自动提交。真实 XHS 页面 DOM/登录验收仍待 |
| `crawler/_user_data_dir.py`、`app/processes.py`、`app/runtime.py`（均已删除） | Python 会话路径/进程管理、`MC_PYTHON`/`uv` 定位及 FastAPI 运行路径 | 第一方 Python 运行时代码已退役；Rust 数据、进程及配置服务承接仍受支持能力 |
| `scripts/start.sh`, `scripts/stop.sh` | 已改为构建/启动 Rust `rn serve` 与 Vite；检查端口后不接管未知服务，停止时校验命令身份 | Rust/frontend build、`bash -n` 和隔离 SQLite 上的 Web 双账号浏览器冒烟通过；真实桌面 WebView、文件选择和重启恢复验收仍待用户环境 |
| `scripts/prepare-tauri.mjs` | 检查 Rust/UI 输入；由 `beforeBuildCommand` 递归审计全部配置资源，拒绝 Python 源码/运行时/依赖元数据、退役目录、通配资源和逃出资源树的符号链接 | 隔离 resource guard 回归通过；release contract job 调用 guard；实际 arm64 `.app` Resources 用同一 guard 扫描零违规 |
| `client/src-tauri/tauri.conf.json` | Python-only bundle resources 已移除；随包 browser worker 含目标匹配的 Node/Playwright/Chromium | macOS arm64 release `.app` 约 728 MiB，约 316 MiB DMG 通过 checksum；DMG 只读挂载后的 Resources guard 零违规、符号链接 0 个，manifest 指向 Node/Chromium 文件存在，映像内 Chromium headless fixture 通过。Intel macOS/Windows/Linux 包与运行仍待检查 |
| `README.md`, Profile | README 与贡献指南已切换到 Rust CLI/MCP/Web；旧版运行说明明确标为历史资料。无调用的 `BackendGate.tsx` 已删除 | 活跃文档不再要求 Python/uv；历史架构内容保留并标明过时，用户 MCP 配置仍需按生成片段迁移 |
| `.github/workflows/release.yml` | release checkout 已取消 `submodules: recursive`；四平台 push/PR 门禁运行 core/services/rn/Tauri tests（services 含本地 mock）、前端 production build、四 crate fmt 与 strict Clippy、AI stream/browser-worker/resource guard；PATH shim 拦截常见及版本化 Python/PyPy/pip/uv，Node shim 预加载 child-process hook 拦截 Node 管理的绝对路径调用，Tauri action 单独加载 hook，并报告命中 | macOS arm64 本机合同、构建和包审计通过；新鲜临时 runner 环境下 PATH shim denylist/Vite build 零命中，workflow YAML 解析通过。远端矩阵尚未运行，Intel/Windows/Linux 干净构建、完整包检查和原生运行仍待 |
| 子模块 `tools/MediaCrawler` | 当前工作树带脏修改；不是本轮可清理对象 | 移除仓库打包/运行依赖，不覆盖或强制删除现存用户改动；历史第三方代码残留在验收中单独说明 |

## 5. Python 搜索结果分类规则

全仓 `python` 字符串不等于运行依赖：安装文档、语言名、代码示例和第三方文件可作为历史 / 文本残留；`node_modules` 里也包含带 `.py` 扩展名的 React Native 开发脚本。最终验收分为（a）项目执行 Python，（b）安装包带 Python runtime/source，（c）旧文档指向 Python，（d）历史或第三方源码留存，分别提供证据，不能只用 grep 零匹配断言完成。

Tauri 递归 resource guard 与 macOS arm64 release `.app` / DMG 已通过本机检查；应用包在 Python 命令拦截器开启时构建，拦截日志为零，DMG checksum 有效，映像内 `.app` Resources 使用同一 guard 扫描为零违规、零符号链接，Node/Chromium manifest 路径存在。`.app` 约 728 MiB，DMG 约 316 MiB；直接从 DMG 内的 app 启动 Node/Playwright/Chromium headless fixture 通过。Python CLI、MCP、crawler scripts、FastAPI、第一方 DB/业务模块、根 `pyproject.toml` / `uv.lock`、`MC_PYTHON` 与 MediaCrawler `uv` 启动边均已退役。主仓可执行源码范围内没有第一方 `.py` 文件；本地忽略的开发环境、依赖缓存、第三方 `tools/MediaCrawler` 子模块不属于主应用源码，子模块保持原样且不参与构建、运行或打包。Rust Web 的 HTTP 调用覆盖已静态核对，但 Web 全字段产品验收、多平台打包检查仍待完成。release checkout 不再拉取 MediaCrawler 子模块。

## 6. PY00 状态及下一步

本文件盘点已退役的 Python 路由、CLI、MCP tools、直接脚本和打包入口，并记录其替代归属。第一方 Python 源及根依赖/锁文件已删除；`rn mcp config` 可生成绝对可执行文件/数据库路径的配置片段，但不会改写用户配置。CLI/MCP 的参数、主要输出、账号隔离、软删除与失效资格边界已有隔离回归；Unix 伪终端覆盖主要 y/n 确认，低频 CLI 删除和 `content topic` 分析文件错误输出已补合同，但 Windows TTY 与其它未识别边界仍待核验，不能称所有 UI/终端路径已产品验收。外部验证包括：运行远端四平台 CI/发行包、用户手动切换现有 MCP 客户端配置、真实 Provider/XHS 与 GUI/Web 产品验收。完成后再按平台记录，不改正式数据库或用户配置。
