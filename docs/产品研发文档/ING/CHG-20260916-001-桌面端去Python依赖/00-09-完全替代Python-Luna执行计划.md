# 完全替代 Python：Luna 开发计划

任务：CHG-20260916-001；更新：2026-10-08；执行者：Codex（接续 Luna 计划）。

2026-10-08 PY10 debug 原生启动路径复验：发现 `browser_worker::create_for_app` 在 debug 启动也无条件解析只供打包应用使用的 `resource_dir`，使 `tauri dev` 在隔离测试 target 下启动时于 worker 初始化前 panic。现将该解析限定为 release bundle；debug 仍使用仓库内 worker 路径。修复后 Tauri 51/51、Tauri strict Clippy 与 rustfmt 通过；授权本机 loopback/socket 的服务/tauri fixture 共 23/23 与 51/51。Python denylist/resource guard、browser-worker 17/17、AI stream 4/4、Vite production build 2794 modules 通过。单独 QA release `.app` 使用编译期唯一 identifier `com.aichihongshu.qa.pyremoval.20261008`，实包 guard 零违规且无 libpython。debug QA 进程使用复制至 `/private/tmp` 并带 marker 的工作区，未报原 resource_dir 错误；CUA 未显示 QA 窗口，原生页面导航仍未验收。Windows/Intel/Linux runner、远端 workflow、MCP 用户配置迁移、Provider/XHS 与可见 GUI 验收继续待办。

2026-10-05 PY10 MCP stdio 生命周期合同：将此前 release smoke 覆盖的新增工具真实调用持久化为隔离子进程回归；无 Node/Python PATH 下逐请求验证 22 工具握手、PC 记忆新增/查询/启停/删除、PC 经验新增/查询/省略字段保留式更新/删除、笔记搜索以及非法经验来源拒绝。RN 65 单测 + 24 子进程 = 89/89，strict Clippy、fmt 与 diff check 通过。第一方 `.py` 源码扫描为 0；Cargo/npm lockfile 仅命中 `Python-2.0` 许可证文本，没有 Python/PyO3 运行依赖。当前机器无 rustup，只安装 macOS arm64 target；Windows/Linux/Intel runner、用户 MCP 配置迁移和真实 Provider/XHS/GUI 验收仍需原生环境或用户侧验证。

2026-10-05 PY10 当前源码全量复验与发行物检查：core 64/64、services 23/23、rn 89/89、Tauri 51/51；四 crate strict Clippy/rustfmt、browser-worker 17/17、AI stream 4/4、resource guard 和 Vite production build（2794 modules）通过。锁文件扫描无 Python runtime 命中。当前源码在 Python 命令 denylist 下构建 arm64 `.app`/DMG，构建零命中；实包递归 guard 零违规，主程序无 libpython，DMG checksum 有效；从 DMG app 的空 PATH/临时 HOME 运行随包 Node/Chromium 内存页 smoke 通过。Windows/Intel/Linux 原生 runner 与包、远端 workflow、用户 MCP 配置切换及真实 GUI/Web/Provider/XHS 产品验收仍待；本机 headless smoke 不替代这些验收。

2026-10-06 PY10 Web 合成双账号浏览器 E2E：临时副本中的 release `rn serve` + Vite 在 Python/uv/pip denylist PATH 下运行；Playwright 验证 health/profile/account-pool/library/content API 返回 200，概览、素材库、笔记、数据、账号池、设置均可导航，QA-A→QA-B 后 profile/素材/草稿账号隔离正确，浏览器无 page/console 错误或失败请求，Python command audit 零命中。测试 harness 使用 Python，不是应用运行进程；源 `.qa` 未修改。记忆中心在浏览器预览中提示需 Tauri，符合当前产品边界。

2026-10-06 PY10 原生启动隔离纠正：shell `open` 对系统 Calculator 也返回 `kLSNoExecutableErr`，不是产品包特有证据；通过 CUA 打开临时 app 副本后 Tauri 窗口可启动，但发现 Tauri app data 目录仍由编译期 bundle identifier 决定，副本 `Info.plist`/LaunchServices HOME 不足以隔离。用户 Application Support 的 `com.aichihongshu.app/app.db` 修改时间与测试启动相近；窗口中未执行 CRUD，应用已关闭，没有启动前快照所以未覆盖恢复。此轮不能作为原生隔离验收；后续必须用编译期 QA identifier 或 debug QA workspace 构建验证后再运行 GUI。

2026-10-04 PY10 跨 crate 当前状态复验：core 61/61、services 23/23（含本机 MiniMax mock）、rn 88/88、Tauri 48/48；services/Tauri 本地 loopback 与 Unix socket fixture 均通过。core/services/rn/Tauri strict Clippy、四 crate fmt 与 Tauri `cargo check --lib` 通过。strict lint 抓到并简化 `client/src-tauri/src/db/browser.rs` 两处冗余写法，不改变语义；Vite production build 起初发现素材剪藏详情中的引用管理处理未接到 UI，已接入关联添加/取消和作者主页加入榜样操作，重跑 production build 通过。第一方源码无 `.py`，Cargo/npm lockfile 未发现 Python runtime 依赖；`Python-2.0` 仅为许可证文本。针对当前源码重新构建 arm64 `.app` 和 DMG，Python command denylist 命中为零，实际包 resource guard 零违规、无符号链接、主程序无 libpython，DMG checksum 与包内 Node/Playwright/Chromium headless smoke 均通过。当前 `rn` 源码以 locked offline Cargo install 到临时根目录后，在无 Node/Python PATH 下通过版本、隔离数据库初始化和 JSON 列表冒烟。core target 两个 helper 的 dead_code warning 来自共享 DB 与 Tauri adapter 编译边界。Windows TTY、远端四平台、MCP 配置迁移和真实 Provider/XHS、GUI/Web 验收仍待。

2026-10-04 PY10 CLI 低频输出增量：补齐 `content topic --analysis-file` 在 JSON 模式下分析文件缺失时的黑盒契约。Rust CLI 忽略不可读分析文件并继续返回选题结果，stdout 保持纯 JSON，诊断在 stderr；rn 64 单测 + 24 子进程 = 88/88，全量 rn strict Clippy/fmt、Python denylist、Tauri resource guard 和 diff check 通过。仍待 Windows TTY、其它未覆盖边界及外部多平台/产品验收。

2026-10-04 PY10 CLI 低频分支收口：无 Python PATH 的真实子进程导入受管 PNG 后，以旧 `--delete-file` 参数软删除；验证仍可从回收站恢复且图片未被删，stderr 兼容提示与 stdout 成功文案均锁定。该语义对照旧 `app/modules/library/manager.py::delete_item`，本轮仅补测试，无生产代码变化。rn 64 单测 + 23 子进程 = 87/87、strict Clippy、fmt 与 diff check 通过。下一步仍是少量剩余边界和外部 Windows/四平台、用户配置及真实产品验收。

2026-10-04 PY10 安装后无系统 Node/Python 冒烟：对当前 Rust `rn` 运行 locked offline `cargo install` 到临时 root；PATH 仅保留其 `bin` 后，版本查询、隔离 DB 初始化和 JSON 素材列表成功。基础 CLI 数据库功能可脱离仓库与系统 Node/Python 运行；browser worker / 浏览器功能仍须按目标平台检查随包运行时。core 58/58、rn 87/87、core/rn/Tauri strict Clippy 和 Tauri lib check 通过。临时安装和数据库已清理。

2026-10-04 PY10 加固 Python-free 构建审计：PATH denylist 覆盖常见及版本化 Python、PyPy、uv/pip 命令；installer 另创建 `node` shim，用 runner 的真实 Node 预加载 `python-command-audit.cjs`。钩子把自身加入当前 Node 进程的 `NODE_OPTIONS`，以便子 Node 继承；GITHUB_ENV 只保存日志路径，Tauri 发布 action 用 step-level `env` 加载 hook。在 Node `spawn`/`exec`/`execFile` 同步和异步调用及 shell 命令运行前拦截绝对 Unix/Windows 路径。回归覆盖 API 与路径形式、版本化 PyPy 绝对路径、钩子传递至孙级 Node；本轮用全新临时 runner 目录模拟 `GITHUB_PATH`/`GITHUB_ENV`，PATH shim 下 denylist 回归、Vite production build 均通过且报告零命中，workflow YAML 解析通过。这个 hook 覆盖 Node 管理的子进程，非 Node 直接调用仍由 PATH shim、源码/依赖检查与资源 guard 约束；四平台 workflow 尚待远端执行。

2026-10-04 PY10 CLI 本机边界复验：无 Python PATH 的真实 `rn library analyze` 子进程在缺少 Provider 凭据时返回退出码 2、stdout 为空、stderr 给出配置提示，且素材记录在失败后逐字段保持不变；`profile edit` 黑盒子进程验证旧 CLI 17 个字段全部写入并经 JSON 读回，覆盖列表空项与井号处理；Unix 伪终端覆盖 `db init`、榜样账号删除和素材软删除的 y/n 确认及数据库结果。rn 当前 64 单测 + 23 子进程 = 87/87，strict Clippy、crate fmt 与 `git diff --check` 通过。源码盘点排除 MediaCrawler、依赖和构建目录后未发现第一方 `.py` 文件；启动、构建和 release 入口的 Python 命中仅为显式 denylist/resource guard 合同。四平台远端 runner/发行包、用户 MCP 配置切换，以及真实 Provider、XHS 和 GUI 验收仍未完成；全目标保持实施中。

2026-10-03 PY10 常规平台 CI 门禁扩展：push/PR 四平台现运行 services 本地 mock（包括 ignored 的 MiniMax HTTP 合同）、四 crate fmt、三 crate strict Clippy、Vite production build、Tauri library tests 与 strict Clippy；Linux 安装 Tauri system dependencies，Rust/npm 安装使用 lockfile。当前 macOS 本机对应检查全部通过：core 57、services 23、rn 84、Tauri 44，browser-worker 17、AI stream 4；denylist/resource guard、前端构建、Tauri check、fmt、Clippy 和 workflow YAML 通过。远端矩阵/发行包尚未执行，用户 MCP 配置切换和真实 GUI/Provider/XHS 产品验收仍待。

2026-10-03 PY10 CLI/MCP 隔离矩阵与跨 crate 收口：新增旧 CLI 全部数值参数错误、值选项缺值、必填位置参数缺失的隔离子进程合同，逐项锁定 Click 退出码与错误流；修复 library add/tag、content list、profile init/edit 及共享 option parser 的差异。CLI 工作流继续锁定 trash 列表、restore 文案、受引用素材拒绝 purge 和隔离无引用素材永久清理。MCP 双账号回归补测 profile/reference scope 与跨账号 draft/publish/export；CLI 授权图片列表检查按内容字段定位，避免插入时间并列的顺序假设。复验发现 Tauri 直接使用 `chrono::Local` 但 manifest 缺少依赖，在 core/Tauri manifest 显式补上 chrono；另修复部分 profile 快照错误覆盖旧互动均值的问题，仅完整且字段齐全的快照更新汇总。core 57/57、services 23/23、rn 64 单测 + 20 子进程 = 84/84、Tauri 44/44；四 crate strict Clippy/fmt、Tauri offline check 与 diff check 通过。MCP 14 工具的 schema 类型、空/缺失、软删除、账号资格与跨账号主要状态已有隔离覆盖；剩余远端四平台 CI/发行包、少数 CLI 输出/终端交互、用户 MCP 配置迁移、真实 Provider/XHS 和 GUI 产品验收仍待。

2026-10-03 PY07 MCP 回收站状态矩阵：隔离回归确认软删除素材/笔记不出现在列表和单条读取中，tag/save/publish 不会写入回收站对象，draft/export 保留旧“未找到”成功错误对象；analytics 则按旧兼容行为统计软删除行。新增断言纳入 rn 64 单测 + 17 子进程 = 81/81，strict Clippy/fmt/diff check 通过。

2026-10-03 PY07 MCP 账号资格状态矩阵：全部 14 个 MCP 工具在激活账号 ID 不存在、配置损坏/null、assistant 角色以及 operation 账号为 banned/suspended/retired 状态下逐一 fail-closed；授权目录内有效图片也不会被错误上下文导入。隔离账号状态通过 LocalDb API 设定，rn 全量 81/81、strict Clippy/fmt/diff check 通过。

2026-10-03 PY07 MCP schema 参数矩阵补缺：发现并修复 Rust pre-validation 拒绝 `default: null` 可选字符串/整数、而 legacy handler 接受 `null` 的契约差异；新增全部 14 个工具属性的无效类型、字符串数组错误成员和可空默认值的逐项 tools/call 回归，并扩展 profile null no-op 验证。rn 64 单测 + 17 子进程 = 81/81，rn strict Clippy、crate fmt 与 diff check 通过。额外数据库状态矩阵、用户 MCP 配置迁移、远端多平台 CI 与真实产品验收仍待。

2026-10-03 PY07 MCP 失效账号边界回归：隔离库为全部 14 个工具建立有效数据并故意令激活账号引用失效；含授权目录有效图片的导入调用在内，所有 tools/call 均 fail-closed，返回 `isError=true`，不回退到全库读写。RN 62 单测 + 17 子进程 = 79/79，strict Clippy、`mcp.rs` targeted rustfmt 与 diff check 通过。额外 MCP 参数/数据库状态矩阵、多平台 CI 与真实产品验收仍待；本机 Rust gates 已由下方 PY10 记录全部通过。

2026-10-03 PY07 账号选择损坏值修复：`active_account_id` 非数字、空字符串或显式 NULL 此前会被误当成缺省设置并自动切换到默认运营账号；现改为显式报错。MCP 全部 14 个工具分别在不存在 ID、这些损坏值及有效 assistant 角色 ID 下，以有效参数验证都 fail-closed，授权图片导入不例外。core 57/57、rn 79/79、rn strict Clippy、`db.rs`/`mcp.rs` targeted rustfmt 和 diff check 通过；当前工程门禁状态见紧随其后的 PY10 更新。

2026-10-03 PY10 门禁闭环（后续 CLI 参数矩阵扩展前计数）：收敛跨数据库模块多余的 `&mut`/`mut`，将收藏图片持久化参数改为具名结构，并修复剩余共享 DB/Tauri Clippy 项。core 57/57、services 23/23、rn 81/81、Tauri 43/43；四 crate strict Clippy、Tauri locked offline check、四 crate fmt、targeted rustfmt 与 diff check 均通过。services 的 ignored MiniMax 合同在本地 loopback mock 上已通过，无真实 Provider 请求。最新测试计数见本文件顶部。

2026-10-03 PY09/PY10 arm64 release 复验：在 PATH 前置 Python/uv/pip 阻断器后运行 `pnpm tauri build --bundles app`，当前 Rust/UI 重新生成约 728 MiB macOS arm64 `.app`；命令拦截日志零命中。对实际包 `Contents/Resources` 跑递归 Python 资源 guard 为 0 项，扫描包内 Python/环境/MediaCrawler 名称及符号链接无命中，主可执行 `otool -L` 无 Python 动态库；runtime manifest 与随包 Node、Chromium 二进制均匹配 `aarch64-apple-darwin`。直接从 `.app` 内 Node 启动随包 Playwright/Chromium，在隔离 headless 临时 profile 打开内存页面并断言 DOM 通过；未启动桌面 GUI/真实站点。其他平台 CI/安装包及用户真实验收仍待。

2026-10-03 PY09 macOS arm64 DMG 复验：Python 命令拦截 PATH 下完整 `pnpm tauri build --bundles dmg -vv` 成功，生成约 316 MiB `爱吃红薯_0.1.3_aarch64.dmg`；普通沙箱的 hdiutil 设备限制由只读范围的权限诊断确认。`hdiutil verify` 校验和有效，DMG 只读挂载后的 app 资源 guard 零违规/零符号链接，主程序和 Node 为 arm64；由映像内 Node/Playwright/Chromium 完成隔离 headless DOM smoke。构建无 Python/uv/pip 拦截记录；无 GUI、用户会话或真实站点访问。

2026-10-03 PY05 `profile init --url` 登录失败边界：临时 Node JSONL worker 返回 `login-required` 时，真实 CLI 子进程以退出码 2 结束，stdout 无污染、stderr 给出登录提示，profile JSON 前后保持一致且 worker 已收到 `shutdown`；成功路径也在同一回归中确认正常关闭。rn 全量 79/79、strict Clippy、两处 targeted rustfmt 与 diff check 通过；不连接真实 XHS/Provider。

2026-10-03 PY10 前次 gate 结果（已由上方更新取代）：当时 Tauri `collection_images.rs` 编译、core strict Clippy/fmt 和受沙箱限制的 services mock 未通过；同日后续已修正/重验，具体通过结果见上方最新检查点。

2026-10-02 PY06 视频契约闭环增量（当日门禁状态已由 2026-10-03 PY10 记录取代）：旧 `crawler/xhs_publish.py` 的 `--video` 分支已保留到 Rust SQLite/发布快照、账号隔离受管文件导入和扩展确认式分块填充。支持 MP4/MOV/M4V/WebM，最大 500 MiB；96 KiB 块经 Native Messaging 160 KiB 有界回执传输，插件校验签名与 SHA-256，只尝试写入唯一视频文件框，绝不点击最终提交。旧 HTTP/MCP/CLI 笔记构造点已补 `video_path: None`，旧内容更新保留已关联视频路径的回归通过。隔离数据库/扩展 fixture、core 55/55、rn 78/78、Vite build 和扩展契约检查通过。真实 XHS 创作页选择器/登录验收仍待。

2026-10-02 PY10 `rn search` worker 生命周期修复：真实 CLI 子进程在空 Python PATH 下连接临时 Node JSONL worker，覆盖双关键词编码、结果字段、JSON/普通文本输出流、搜索文件、历史与未登录错误；修复 `run_browser_search` 在所有返回路径显式关闭 worker。rn 61 单测 + 17 子进程 = 78/78，strict Clippy、fmt、diff check 通过。

2026-10-02 PY10 CLI 黑盒增量：为 `rn crawl history` 补空 Python PATH 的账号隔离、文本/JSON、倒序、limit 与错误回归；为 `rn analyze` 补旧报告 JSON/普通摘要、文件写入和账号采集历史端到端 fixture。rn 61 单测 + 16 子进程 = 77/77；services 23/23（含本地 mock），strict Clippy/fmt/diff check 通过。没有访问真实 Provider/XHS。

2026-10-01 PY10 本机增量验收：复用 Vite 并连接隔离 SQLite 的 Rust HTTP adapter，Playwright 实际切换一号/二号/一号，确认 dashboard、素材库、笔记保持账号隔离；无浏览器异常和失败 API。临时 listener 已停止，未访问正式库/Provider/XHS。rn CLI/MCP 合同测试 75/75；services 使用 `--include-ignored` 全量运行 23/23，包含仅连本地 mock 的 MiniMax 请求契约。真实环境验收、多平台 CI、完整 MCP 状态矩阵及用户 MCP 配置迁移仍未完成。

2026-10-01 PY08 历史边界与遗留格式收口：analytics、知识规律和 AI 灵感上下文改为完整账号范围聚合；单条笔记详情、导出、编辑与 AI 聊天不受 5000 条 UI 快照上限影响。5001 条隔离 HTTP 回归验证历史边界记录参与排名、均值、趋势、知识规则，并验证详情/导出/聊天/灵感上下文；灵感标签格式与均值并列的首次出现顺序保持旧 Python 行为。MCP 测试还核对有效/损坏分析 JSON 和未知标签 action 的旧分支。Rust CLI/MCP/Web 导出统一使用旧 Markdown 格式。core 52/52、services 22 passed / 1 sandbox-ignored、rn 61 单测 + 14 子进程 = 75/75、browser-worker 17/17、AI stream 4/4、denylist/resource guard、TypeScript/Vite build、Tauri check、strict Clippy、fmt 与 diff check 通过。远端多平台、Web listener、真实 Provider/XHS 与用户 MCP 配置仍待验收。

2026-10-01 PY08 analytics 全面补齐快照截断：榜单完整排序查询；summary 全量 SQL 统计/前十；insights 聚合标题、小时并累计全量标签；trend 聚合全部近 90 天记录后再自动选粒度。所有查询绑定并复核激活账号，过滤软删除数据。5001 条隔离 HTTP 用例覆盖边界外旧行在均值、前十、标签和趋势中的参与，另测跨账号隔离。验证 rn 60 单测 + 14 进程 = 74/74、core 52/52、services 22 passed / 1 sandbox-ignored、Tauri lib check、三 crate strict Clippy、fmt 与 diff check 通过。剩余跨平台 CI 和产品验收仍待。

2026-10-01 PY08 analytics 增量：Rust HTTP 榜单从最新 5000 条 UI 快照查询改为当前运营账号的全量已发布笔记 SQL 查询；sort 只接受固定 likes/collects/comments 列，封面只 join 同账号未删除素材。隔离回归覆盖 5001 条及三种排序；rn 74/74、Tauri lib check、strict Clippy、fmt 与 diff check 通过。远端 CI/多平台和产品侧验收仍待。

2026-10-01 PY10 本机全矩阵复验：core 52/52、services 22 passed / 1 ignored（沙箱限制本地 TCP listener）、rn 59 单测 + 14 进程测试 = 73/73；browser-worker 17/17、AI stream 4/4、denylist、resource guard、前端构建、三 crate strict Clippy / fmt、shell 语法与 diff check 通过。第一方运行入口复核无 Python/uv/pip 调用。隔离 Web 双账号冒烟因沙箱禁止 loopback listener 未能启动服务，本机只安装 arm64 macOS Rust target 且无 rustup，Intel/Windows/Linux 编译需原生 CI；release workflow 四平台合同矩阵待实跑。产品验收和整体目标保持未完成。

2026-10-01 PY07 `profile init --url` 隔离工作流：发现一次性 CLI 未向主页 Node worker 显式发送 shutdown，现保证采集成功、失败及交互重试结束时都关闭 worker。空环境/空 Python PATH 子进程通过临时 Node 22 JSONL worker 验证主页数据落库、无 Provider 时继续同步、普通模式进度/推断结果/失败回执、JSON stdout 纯净、stderr 诊断和 shutdown；rn 59 单测 + 14 进程测试 = 73/73，strict Clippy、fmt 和 diff check 通过。真实 DOM、登录态与 Provider 仍待产品验收。

2026-10-01 PY07 CLI 列表契约增量：非空 `accounts list` 隔离进程现在用两条数据验证 JSON 与普通文本的时间倒序、行序、24 字符账号 ID 截断、浮点统计和时间格式。`cli_process_contract` 13/13；本轮只加回归，未改生产逻辑。

2026-10-01 PY09/PY10 bundle 资源门禁与 arm64 实包：Tauri 现在递归拒绝全部配置资源中的 Python 源码/运行时/环境元数据、通配符及逃出资源树的符号链接；release contract job 执行资源 guard。浏览器资源打包器将 Chromium 树内绝对链接重定位为资源树内相对链接，并从复制后的目录通过 headless 启动 fixture。TypeScript/Vite build 与 arm64 `.app` app-only bundling 通过，实包约 727 MiB，扫描未发现 Python 文件、解释器或绝对链接。四平台远端 CI、其它平台包、签名、公证及真实 Web/Provider/XHS 验收仍待。

2026-10-01 PY07 `library add` 输出流契约：对照旧 Click/Rich 路径后恢复普通模式分析进度、分析成功/失败提示和导入回执的 stdout 顺序；JSON 模式诊断留在 stderr。无 Python PATH、无 MiniMax 凭据的隔离子进程确认分析失败会继续导入，普通输出兼容且 JSON stdout 保持纯净。rn 59 单测 + 13 进程测试 = 72/72、core 52/52、services 22 通过/1 受沙箱限制忽略；三个 crate strict Clippy、fmt、diff check、denylist 自测通过。运行入口静态扫描未发现第一方 Python 执行调用；MediaCrawler 子模块除外。旧工程说明已更新当前 Rust/Node 命令并将已退役架构章节明确标为历史资料。

2026-10-01 PY07 MCP 局部更新契约：隔离工具工作流现明确验证 `update_profile` 只改已传字段、空字符串/空数组可清除字段；`save_note` 空字段可写且未传字段保留；`publish_note` 不传 URL 保留原 URL。对照旧 Python `None` 过滤与 SQL `COALESCE`，实现行为一致。rn 59 单测 + 12 进程测试 = 71/71，strict Clippy、fmt、diff check 通过。

2026-10-01 PY07 CLI 错误契约：`library show/analyze/restore`、`content show`、`accounts show` 以及 `library delete`、`content edit/export`、`accounts delete/add` 统一按 Click 解析参数。缺参、无效整数/浮点数、未知选项、多余参数、缺失选项值及 add 必填 name 的 Usage/stderr/退出码由空 Python PATH 进程精确核验；rn 59 单测 + 12 进程测试 = 71/71，strict Clippy、fmt、diff check 通过。

2026-10-01 PY07 CLI Click 选项消费增量：Rust CLI 现在将值选项后的任意 token（包括 `-` 开头或貌似另一开关的值）作为参数值消费，避免误报缺参或把值再次识别为开关；双向 analyze 标志按最后一个实际出现的开关决胜。隔离 CLI 进程覆盖 profile、素材筛选、草稿、素材导入和标签路径。rn 59 单测 + 11 进程测试 = 70/70，strict Clippy、fmt、diff check 通过。

2026-10-01 PY07 CLI/MCP 契约增量：`library tag` 恢复 Click 的参数混排、重复 last-value、空值 no-op；通用 CLI 字符串选项按命令行顺序取最后值，支持 `content edit/export`、`accounts add/delete`、`library delete` 选项置于 ID 前后。补齐空 tags/status/output/style 和 profile init 必填字段的旧 falsey 行为。MCP analytics 恢复统计本账号的软删除素材/笔记，同时继续限定账号范围；整数 schema 接受 `1.0` 形式的整数值，拒绝小数值。无 Python PATH 进程与隔离 DB 回归覆盖输出、退出码和数据库状态；core 52/52，rn 59 单测 + 10 进程 = 69/69；core/rn strict Clippy、格式与 diff check 通过。

2026-10-01 PY07 CLI `db init` 输出增量：普通模式恢复旧 CLI 成功文案“✓ 数据库初始化完成”；无 Python PATH 真实进程 fixture 覆盖新库 `--yes`、已有库重复初始化和 JSON 输出中的绝对路径。rn 58 单测 + 9 进程测试 = 67/67；strict Clippy、fmt 与 diff check 通过。

2026-10-01 PY08 analytics/topics 兼容增量：补回旧接口合并采集关键词的行为，标签直接从激活账号已发布笔记按 id 正序全量查询，避免 UI 快照上限；采集词按账号过滤且只读最早 50 条日志。对并列词按首次出现顺序输出。未归属账号的旧行不显示，防止跨账号泄露。core/rn/Tauri 编译、隔离账号与排序测试通过。

2026-10-01 PY07 CLI `library add` 标题/参数增量：旧 Click 允许 `--title` 写在图片路径之前，Rust 原先可能把标题值误当路径；现按参数顺序解析并保留重复标题最后值。显式空标题按旧 Python `title or src.stem` 回退文件名，避免保存空标题。无 Python PATH 隔离子进程验证前置标题选项和空标题。rn 全量 58 单测 + 10 进程 = 68/68、strict Clippy 通过。

2026-10-01 PY07 MCP 图片导入契约增量：旧 `add_item_from_path` 将空标题按文件名 stem 回退；修正 Rust 对显式 `title=""` 错写为空标题的问题。无 Python PATH 的隔离 MCP 子进程验证导入对象及 `list_items` 结果；定向和 rn 全量回归通过，当前 rn 58 单元 + 10 进程测试 = 68/68，strict Clippy 通过。

2026-10-01 PY07 `content draft` 兼容增量：归档旧 Python `build_draft_prompt` 的完整输出固定为静态 fixture，Rust service 逐字匹配（含缺省人设、素材分析字段、补充要求及换行顺序）。修正 CLI 选项在素材 ID 前后的解析、重复 `--extra`/别名的 last-value 语义和 `-` 开头补充文本；缺参/整数/未知选项/多余位置参数的 stderr 与退出码按 Click 分类回归。隔离真实子进程覆盖榜样账号短选项、提示块、最终补充文本和错误矩阵。验证 rn 58 单测 + 10 进程测试 = 68/68；services 22 项通过、1 项受沙箱 TCP 限制忽略；rn/services all-targets strict Clippy、fmt 与 diff check 通过。

前序状态摘要（后续进展见本文顶部检查点）：PY00–PY09 的第一方替代代码已落地，主仓应用源码、根 `pyproject.toml` 与 `uv.lock` 已删除；`tools/MediaCrawler` 子模块保留且不参与构建、运行、打包。Rust 14 个 MCP tool 已与 Python FastMCP 1.27 完整工具定义逐项比较（名称、说明、完整 inputSchema）；真实子进程握手、初始化前错误、完整工具列表与纯 JSON-RPC stdout/stderr 检查通过。Schema 参数回归现覆盖所有必填字段、非对象根参数及代表性字段/数组成员类型错误。Rust CLI 以旧 Click 元数据 fixture 核对所有选项名与别名；素材、草稿、导出、账号、回收站等本地工作流在空 Python PATH 的子进程中通过。`content draft` 和 `content topic` 的完整旧 Prompt 都有静态 fixture 逐字比较；draft 另覆盖选项顺序、重复选项最后值、连字符开头文本和主要参数错误/stdio；topic 回归覆盖素材 ID 顺序/重复/缺失、空参数、分析 JSON 摘要和 JSON/plain stdout/stderr。`library add` 与 MCP 图片导入都恢复显式空标题的文件名回退，CLI 标题选项可置于图片路径前；本轮又恢复其普通模式分析进度/成功/失败提示和导入回执的旧 stdout 顺序，同时保持 JSON stdout 纯净。`library tag` 也恢复旧 Click 的选项顺序、重复 last-value、空标签 falsey 与无操作成功语义。进程契约也覆盖空列表/profile 引导、缺失对象退出码与 no-op 编辑。MCP profile 输出逐字段对齐旧 `get_profile` 32 个字段（包括原来遗漏的 `created_at`），其旧数据库缺列迁移和新账号插入有隔离回归。`list_items` 复用 SQLite `LIKE`、默认 50 条和创建时间顺序，`list_notes` 使用主素材筛选；MCP 单条素材/笔记使用账号范围 ID 查询，导入只取当前账号 ID，草稿不再加载整个 UI 工作区；analytics 查询保持账号范围且保留旧工具对软删除行计数的行为。彼时 rn 为 59 单测 + 13 进程测试共 72/72，完整现状见本文顶部最新检查点。远端四平台 CI、用户 MCP 配置迁移、真实 Provider/XHS 与 GUI 产品验收仍未完成；自动验证不代表产品验收。

2026-10-01 PY07 MCP 空态/缺失态矩阵：针对 14 个旧工具核对未初始化 profile、空列表、空 analytics、缺失素材/笔记和拒绝导入的 MCP `isError` 类别及结果形状；保持成功返回业务错误对象与真实工具异常的区别。rn 58 单测 + 8 进程测试 = 66/66，strict Clippy、fmt 和 diff check 通过。正常工作流、账号隔离与单条记录大数据回归继续通过；其它参数组合及 CLI 输出/错误 fixture 仍待。

2026-10-01 PY07 MCP 快照查询优化及 Rust DB API 收敛：MCP 素材/笔记单条操作按当前账号和 ID 直接查询，`add_item_from_path` 只读取当前账号 ID；`draft_note_prompt` 只加载 profile/reference 区段，`get_analytics` 只读取准确统计数而不构造 UI 列表。隔离 fixture 超过 5000 条并确认早期条目可读取和修改、analytics 返回真实总量。主页快照更新、Companion 进度更新、发布填充结果三个多参数方法改用具名结构体输入；顺手清理 4 条冗余 Clippy lint。rn 57 单元 + 8 进程 = 65/65、core 50/50；core/rn strict Clippy、Tauri lib check、Rust fmt 与 diff check 全通过。最新 arm64 `.app` 已重建，约 727 MB；主程序、随包 Node 均为 arm64，包名和动态库审计无 Python/uv/MediaCrawler。

2026-10-01 PY07 CLI 文本、查询与确认增量：非空 `library list` 增补笔记数与合计，`content list` 补旧字段（标题、主素材 ID、状态、话题、创建时间及合计），`accounts list` 补均赞/评/藏和抓取时间；普通 `library add` 恢复勾号文案及详情。`content draft` 补人设/榜样状态、提示框与保存回执，编辑指引改用 `rn content edit`；`content topic` 恢复旧提示框；`library tag` 恢复添加/删除文案顺序和区分大小写的精确标签匹配。CLI 素材列表在数据库侧恢复旧 SQLite `LIKE` 标签/风格筛选、创建时间倒序与 50 条默认上限，测试覆盖 wildcard 和 filter-before-limit。素材/榜样账号删除恢复旧终端确认提示，可用 `--yes` 跳过；取消不会删除数据，JSON 模式要求显式确认以保护 JSON stdout。真实子进程测试使用隔离数据库和空 Python PATH 检查文本字段、时间戳、输出流、提示框和取消后数据状态。验证 core 47/47；rn 56 单元 + 8 进程测试通过，strict Clippy、Tauri lib check、fmt 与 diff check 通过。其它 CLI 命令完整输出、退出码和交互仍待逐项核对。

2026-10-01 PY07 CLI 错误与 no-op 增量：旧 Python CLI 中素材/笔记缺失对象（含 draft 素材）提示到 stdout 并退出 1，榜样账号 show/delete 与确认后的素材 delete 对缺失对象成功返回；无字段 `profile edit` 是成功提示，已有笔记空字段 `content edit` 会刷新 `updated_at`。Rust 通过账号范围 LocalDb 查询/touch 对齐这些行为，并保持 JSON 错误为合法 JSON。隔离进程测试检查各输出/错误码、空 stderr、JSON 形状以及 no-op 不改内容版本。验证：rn 56 单元 + 8 进程 = 64/64，all-targets strict Clippy、fmt 和 diff check 通过。全 CLI 输出基准仍未穷尽。

2026-10-01 PY07 榜样账号 CLI 输出增量：对照旧 Rich CLI 文本，Rust `accounts show` 现在显示均赞/评/藏浮点格式、结构化风格描述、高赞标题、录入时间（截断至分钟），并隐藏旧版未展示的粉丝数；`add/delete` 同步旧勾号文案，添加时列出高赞标题。隔离 CLI 工作流逐字校验 add/show/delete stdout，并从同一账号 JSON 输出动态读取时间戳作为预期。rn 56 单元 + 8 进程测试、strict Clippy、fmt 与 diff check 通过；其它 CLI 输出仍待对照。

2026-10-01 PY07 CLI 详情/操作文案增量：素材详情与笔记详情改为旧 CLI 的多行字段布局；素材详情解析分析卖点与搭配字段，笔记详情呈现状态、素材/参考账号、标题、封面、正文和话题。`content export --output` 与 `library delete` 成功提示恢复旧勾号文案。隔离 CLI 工作流逐字检查代表性详情和成功操作输出；全 rn 56 单元 + 8 进程 = 64/64、strict Clippy、fmt 与 diff check 通过。其它 CLI 命令的完整输出仍待核对。

2026-10-01 PY07 profile CLI 展示/摘要增量：`profile show` 文本输出恢复定位、人设、账号统计、创作偏好和分钟级更新时间分区；手动 `profile init` 与 `profile edit` 现在显示旧版成功摘要，`profile edit` 不接受 init 专属 `--url`、`--account-id`。隔离进程逐字核对 show/init/edit；rn 全量验证仍为 56 单元 + 8 进程，strict Clippy、fmt 和 diff check 通过。所有 profile 参数/推断输出仍需完整核对。

2026-10-01 PY07 CLI 空状态增量：修正空图库、空榜样账号列表和无 profile 时的旧 CLI 提示/退出语义；以临时旧版归档取得基准，回归测试在隔离 SQLite 和空 Python PATH 的真实进程中校验 stdout、stderr 和退出码。已运行本地 PY10 合同：core 46/46、services 21/通过且 1 项受沙箱 TCP 限制忽略、rn 63/63、AI stream 4/4、browser-worker 17/17、Python denylist 自测；前端生产构建、Tauri lib check、普通与 macOS arm64 runtime release resource gate 通过。随后在同一 Python 命令拦截 PATH 下构建 macOS arm64 release `.app` 并审查包内容：无 Python/uv/MediaCrawler 文件名、无 Python 动态库依赖；包内 Node/Chromium manifest target 匹配 arm64。app 约 727 MB；未启动原生 UI/Chromium。第一方源（排除 node_modules 与 MediaCrawler）未发现 `.py` 文件。跨平台 CI 仍未运行。

2026-10-01 PY07 MCP profile 字段增量：旧 `get_profile` 返回整个 `my_profile` 行（32 个字段）；Rust profile summary 未投影 `created_at`。现补 schema 默认值、迁移时缺列回填（不覆盖已存在时间）、账号/profile 插入时间和完整 key-set 回归。core 迁移测试验证缺列旧表及迁移后新账号，MCP 工作流验证旧字段集合。core 46/46、services 21 passed/1 ignored、rn 63/63、Tauri lib check、rn strict Clippy 通过；同一 CI Python denylist 下的完整本地 Rust/Node/build 及 `.app` 产物再次通过，报告零命中。arm64 包无 Python runtime 文件或链接；其他平台、真实 UI/浏览器仍待。

2026-10-01 PY07/PY10 增量：对照旧 `content topic` 命令修正明确素材 ID 的输入顺序、重复 ID、缺失素材过滤，以及空 `--item-ids`/`--analysis-file` 的旧 Click 语义；分析 JSON 按最多 5 个 hook 与 3 个 TOP 标题格式进入选题 Prompt，并恢复标题字段回退。无 Python PATH + 隔离 DB 的真实子进程测试核对空图库 JSON、Prompt 顺序/数量/榜样数据/extra、分析缺失告警 stdout 与机器 JSON 的 stderr 分流；service fixture 另验证结构化榜样风格，保留旧手工自由文本字段的解析结果。core 46/46、services 21 passed/1 ignored、rn 55 单元 + 3 子进程 = 58/58；AI stream 4/4、browser-worker 17/17、denylist 自测、rn/services strict Clippy、fmt 和 `git diff --check` 通过，并修复一条 Clippy 1.94 非最小布尔表达式。完整旧选题 Prompt 静态 fixture 已与 Rust 输出逐字相等，覆盖换行和浮点值显示。release workflow 新增 push/PR 的 macOS arm64/x64、Windows、Linux contracts matrix，发布 job 等待该门禁；本机只验证 YAML 结构，远端矩阵未运行。

2026-10-01 PY07 MCP 输入/数据边界增量：对照旧 MCP 与 Python manager 查询/标签逻辑，Rust MCP 现在保留空字符串筛选参数、`item_id=0` 的 falsey 未筛选语义、style 子串过滤，以及空字符串标签和大小写敏感的标签增删；缺失或跨账号写入统一报告 ID 不存在，以保留 `isError` 类别并避免泄漏其它账号数据。隔离 DB 回归覆盖这些边界、缺失素材/笔记错误文本。rn 全量 55 单元 + 3 子进程 = 58/58，strict Clippy、fmt 和 diff check 通过。所有 MCP 状态组合仍需补齐；旧 `get_analytics` 未按账号过滤，Rust 版本现按当前账号统计以保护隔离边界，JSON 响应结构不变。

2026-10-01 PY07 MCP 查询/结果增量：`list_items` 改为账号内直接 SQLite 查询，保留旧 `LIKE` 通配/ASCII 大小写行为、按创建时间倒序与默认 50 条限制；`list_notes(item_id)` 只按主素材匹配。item/note tool result 投影回旧 Pydantic 字段（包含 account_pool_id、updated_at、video_path，隐藏内部版本字段）；无字段 `save_note` 保留旧更新时间副作用。隔离用例覆盖 51 条素材、filter-before-limit、多素材笔记主素材条件、字段集合及空更新。验证：core 46/46、services 21 passed/1 ignored、rn 56 单元 + 3 子进程 = 59/59；services/rn strict Clippy、Tauri lib check、services/rn Cargo fmt、改动 DB 模块 targeted rustfmt 和 diff check 通过。完整 Tauri crate fmt check 被既有未格式化的 `browser_capture.rs` 阻塞，本轮保留该共享文件原样；core strict Clippy 单独执行时报告 7 个既有 lint，未由本次增改引入。其余 MCP 状态组合仍待对照。

2026-10-01 PY07 CLI/MCP 列表与单条读取增量：Rust CLI 与 MCP 共用账号范围的直接 SQLite 笔记查询，保留旧 Python `list_notes` 的 `created_at DESC`、空 status/`item_id=0` 不筛选、仅主素材匹配语义，并移除工作区快照 5000 条限制；CLI `library trash` 恢复按当前账号及 `deleted_at DESC` 查询。素材 show/analyze/tag/delete 和笔记 show/edit/export 改用按 ID 的账号范围读取，不再因快照截断丢失旧记录。回归覆盖两账号隔离及 5005 条笔记/回收站素材完整结果、首条笔记按 ID 仍可读。core 50/50；rn 56 单测 + 8 进程测试 64/64；rn strict Clippy、Tauri lib check、fmt 与 diff check 通过。core strict Clippy 仍有 7 条已有 lint，未由本轮引入。

本计划下方带日期的执行增量是当时的阶段记录，若与本段状态冲突，以本段及 [最新恢复检查点](./00-03-实施与验证记录.md) 为准。

### 最新执行增量（2026-09-30）

2026-09-30 PY10 跨平台测试门禁扩展：release workflow 每个原生 runner 现分别执行 `client/core`、`client/services`、`client/rn` 的 locked Rust 测试；安装 Node 依赖后执行 AI stream 和 browser-worker fixtures。macOS 本机按 CI 的 locked 命令复验：core 46/46、services 20 passed/1 ignored、rn 57/57、AI stream 4/4、browser-worker 17/17；Ruby YAML parser 解析 workflow 成功。CI 还会把 `python/python2/python3/pip/pip2/pip3/uv/uvx` 安装为 PATH 拦截器并在 job 结束时报告调用；Node 自测验证拦截器非零退出与日志报告。CI 尚未运行，不能据此声明 Intel macOS、Windows、Linux 通过或零命中；各目标安装包和浏览器实际运行也仍待验证。

2026-09-30 MCP 契约与账号隔离补强：修复 `arguments` 根值不是对象时跳过 schema 校验的问题；根值为 null、数组、数字或字符串现在会返回 FastMCP 风格的 `Input validation error`，不再落入工具业务逻辑。新增回归覆盖各工具必填字段、整数/字符串/布尔及数组成员类型；无 Python PATH 的 MCP stdio 子进程测试真实发送根参数错误、必填字段错误和素材不存在的业务错误，确认 JSON-RPC/`isError` 分类、stdout/stderr 与退出码。另在双运营账号隔离 DB 中验证素材/草稿跨账号不可读不可写，切回原账号确认数据未变。定向测试、Rust 全量测试 57/57、strict Clippy `-D warnings`、fmt 与 `git diff --check` 均通过。tools/call 的剩余数据库状态组合、CLI 全参数输出 fixture 和跨平台/真实产品验收仍未完成。

2026-09-30 Python 替代进程验收与 AI Provider 默认目标修复：Rust `rn` 新增 CLI/MCP 子进程集成测试，`PATH` 仅含隔离空目录时，CLI 核对帮助、版本、配置片段与错误码，并以独立 SQLite 完成本地素材/草稿/导出/账号/回收站工作流；MCP 核对 initialize、initialized、初始化前 tools/list 错误、14 工具完整列表、stdout JSON-RPC 与空 stderr。前端 AI 面板此前只认已探测 CLI 且不读取 Settings 保存的默认目标，导致已连接 API Provider 不能解锁生成。现在按新会话默认 API/CLI 目标选择真实可用 Provider；当前会话显式选择优先，并由 API 或 CLI 任一可用状态解锁输入。验证：rn 单元 52 + 3 子进程共 55 项、strict Clippy、fmt、前端 production build、AI stream 4/4、browser-worker 17/17、`prepare-tauri.mjs` bundle 输入门禁、`git diff --check` 通过。release workflow 已安排在四种原生 runner 上先执行 CLI/MCP 契约测试。本机为 Apple Silicon 且没有 `rustup`，所以 Intel/Windows/Linux target 仍需由对应 CI runner 构建，矩阵尚未执行。真实 Provider 请求和原生界面验收仍待用户侧配置/操作。

2026-09-30 MCP / CLI 契约补强：在独立临时目录导出旧 FastMCP 1.27 的 14 个完整工具定义，全程将旧模块的 `init_db` 替换为 no-op，没有打开或创建项目/用户数据库；fixture 现在覆盖描述与完整 inputSchema（titles、nullable、默认值、数组成员及必填字段）。Rust `tools/list` 全对象精确对照通过。Rust `tools/call` 按旧 SDK 将 dict 序列化为缩进 JSON 文本、将 list 中每项分别转为 TextContent，并区分成功的错误对象和抛出异常的错误结果；未知工具与缺失对象错误测试通过。另从旧 Click 命令树导出所有参数名、选项与别名，Rust CLI help 自动覆盖核验通过。`cargo test --offline --manifest-path client/rn/Cargo.toml mcp::tests`（6/6）与 `command_help_preserves_all_legacy_click_options_and_aliases`（1/1）通过；全量回归待本轮完成。

旧 MCP 迁移阶段记录：先前只对照了 tool 名、必填参数、类型与非空默认值；最新完整 schema / 调用封装对照见本节第一项增量。删除 `app/mcp/` 与 `mcp[cli]` 第一方依赖，README/旧版运行说明改指向 Rust MCP；`rn mcp config` 只输出配置片段，用户现存配置尚未改动。根 `pyproject.toml` 与 `uv.lock` 已随第一方 Python 后端退役；所有数据库状态组合和真实客户端迁移仍需验收。

按已确认 D4 收敛发布边界：小红书平台最终提交必须由用户手动完成。Rust HTTP 与旧 FastAPI 的 `publish-auto`、`publish-status`、`xhs-login-status` 路由均返回 HTTP 410，FastAPI 不再启动 Python 发布/登录探测子进程；保护策略明确标记 `publish_auto` 已退役，并删除 `crawler/xhs_publish.py`。替代入口是发布助手：文字/图文/视频经确认式填充，outbox 持久化 prepared/submitted/unknown/confirmed 状态，结果不明不重试。视频选择、账号受管暂存、token 授权分块读取及扩展签名/SHA-256 校验和唯一文件框回执已有隔离测试；真实 XHS 创作页 DOM/登录验收仍未完成。

Rust `rn` HTTP 全量 42/42、strict Clippy、fmt、Python 路由函数 3/3 返回 410、Rust 可执行文件 build、前端 `npm run build --prefix client`、启动/停止脚本 `bash -n` 和 `git diff --check` 通过。以源码归并得到 63 种 Web API 调用形态并核对 Rust handler；`api.ts` 已取消 FastAPI 会话缺失时的无令牌回退，`scripts/start.sh` 已切换到 Rust `rn serve`，README 改用 Rust Web/CLI/MCP 入口。此阶段不等于总体替代完成：页面双账号验收、旧 FastAPI 其余入口、CLI/MCP 全契约、搜索/主页抓取旧源对照与退役、构建依赖和多平台无 Python 验收仍在计划内。下一步继续补齐 Web/CLI/MCP 参数、错误与输出契约 fixture，再按门槛清理第一方 Python 源和依赖。

2026-09-30 Web 开发入口迁移增量：`scripts/start.sh` 以 locked Cargo 构建/启动 Rust `rn serve` 与 Vite；端口冲突时不接管未知进程；`scripts/stop.sh` 只停止 PID 与记录命令路径都匹配的进程。`api.ts` 写请求必须获取 Rust `/api/session` Bearer token，已删除 FastAPI 404/405 无令牌回退。63 种前端 API 调用 method/path 形态已静态核对到 Rust handler 家族。`npm run build --prefix client`、rn 44 项、services 20 passed/1 ignored、strict Clippy、fmt、脚本语法检查通过；获本机 loopback 权限后已验证 Rust health、Vite 首页、允许 Origin 会话发放及 stop 释放端口。真实页面、双账号流程仍需产品验收。

2026-09-30 `rn analyze` 对照增量：旧 `crawler/xhs_analyze.py` 退役前以临时匿名 JSON 生成基准报告；Rust service/CLI fixtures 对齐互动字段别名、“万”解析、Python ties-to-even 均值、稳定 hook/Top 顺序、JSON 私有字段过滤与完整终端报告。services 20 passed/1 ignored、rn 44/44 通过；用户手册已改为 Rust 命令，旧分析脚本删除。

2026-09-30 搜索脚本退役增量：旧 `crawler/xhs_search.py` 无 FastAPI/CLI 导入方，仅 README、旧工程说明与用户手册保留入口；`rn search` 已由 Playwright worker 在账号隔离会话中读取可见结果，输出标题、描述、互动数、标签和规范化笔记 URL JSON，最多 5 个关键词、每词 50 篇，受限滚动并可选记录账号范围采集历史。对应 worker fixture 已覆盖字段读取、链接 token 清理、去重、边界和登录/验证状态。旧 MediaCrawler CSV 未消费的扩展列及 `popularity_descending` 排序不再仿造，现按页面已显示顺序返回；README、用户手册和历史工程说明已改写。主页 Python 源仍被旧 CLI/FastAPI 调用，暂不删除。真实 XHS DOM/排序与双账号体验待用户验收。

2026-09-30 Rust CLI 退役增量：`app/cli.py` 的 Click 命令树与 Rust `rn` 命令及主要参数别名逐项盘点。Rust CLI 在隔离临时数据库上完成 db init、profile init/edit/show、PNG 素材导入/列表/详情/标签、单篇 draft/save、笔记 list/show/edit/export、榜样账号 CRUD、素材软删/回收站恢复与引用素材 purge 防护；相同本地工作流新增 `client/rn` 回归测试。操作手册与贡献指南改用 Rust；删除 `app/cli.py` 和 Python console-script，`click`/`rich` 从第一方直接依赖移除。`uv lock` 因本机运行时访问受限缓存失败且另一次离线调用 panic，手工同步了 uv.lock 根 package 元数据，TOML/声明一致性待验证。全量 stdout/stderr、错误码和所有 flags fixtures 未完成；FastAPI 及主页旧脚本仍在。

### 前序执行增量（2026-09-29）

`rn profile init --url` 已接入账号隔离的 `collect-profile` worker 与默认 Model API Provider：主页 ID 必须匹配显式 ID、人设绑定和账号池绑定；最多读取 30 篇可见笔记，将主页资料及笔记写入当前账号；AI 推断失败仍保存采集资料并保留原有人设字段，手工字段优先，部分统计不写零值覆盖。手工初始化要求 `--name` 和 `--niche`。Rust HTTP 的 Web `GET/POST/DELETE /api/crawler/browser` 也已接到同一个受管 worker，按 account_id 管理状态/会话，不返回旧 profile 路径；Node/worker 缺失时返回明确 503。旧 MediaCrawler 明确 `ENABLE_GET_COMMENTS=False`，旧路由没有笔记详情/评论采集入口，不为替代而扩出新爬取能力。Rust profile 统计/解析与 Web worker 路由 fixtures、rn 41 项、strict Clippy、Tauri lib check 通过；真实小红书 DOM 与真实 Provider 未验收。下一步继续完成 Python 完全替代矩阵。

## 1. 目标与授权边界

将项目第一方运行链路中的 Python 全部替换：桌面、Web 兼容入口、CLI、MCP、AI、采集、发布准备、构建脚本和安装包。旧 D2“CLI/MCP 另行处理”由本计划扩展覆盖，保留功能与契约，不保留 Python 实现作为永久兜底。不能以隐藏入口、关闭 capability、删掉工具或只通过构建宣告完成。

沿用已确认 D4：剪藏和发布填充使用扩展 / Native Messaging；发布最后一步由用户手动提交；低频采集使用独立受控浏览器会话。发布结果未知不得自动重试或标记成功。不得扩展为定时批量抓取、绕过验证或自动互动。

本计划不授权提交、推送、发布版本、操作正式数据库或代用户向平台发帖。实施使用隔离 QA 数据；现有无关修改及 MediaCrawler 子模块脏状态必须保留。不卸载用户系统 Python，不清理用户虚拟环境、登录会话或浏览器配置。

## 2. 当前证据与阅读顺序

阅读根 AGENTS.md、文档导航、协作规则、本 CHG 确认卡和实施记录顶部检查点，再读本文件。历史 00-02 / 00-08 提供迁移约束，当前源码优先于历史进度描述。

2026-09-28 只读盘点基线：HEAD `77b32563`，工作区存在大量未提交改动，包含 Rust DB / Model API 拆分、前端收敛以及另一任务正在开发的浏览器插件。此哈希不是上述未提交成果的完整快照，执行前重新核对 `git status` 和 diff。

| 当前入口 | 已发现的剩余依赖 / 风险 | 本计划处理 |
| --- | --- | --- |
| `client/src-tauri/tauri.conf.json` | Python-only resources 已移除；本机 macOS debug 包只包含 plist、Rust 可执行文件与图标 | 已加入 beforeBuild Python-resource guard；真实产物与其它平台 release 仍需核验 |
| `client/scripts/prepare-tauri.mjs` | 已检查 Rust/UI 输入并拒绝 app/crawler/MediaCrawler/pyproject/uv lock resource | Native host / worker 资源纳入时按真实运行需求扩充白名单 |
| `client/src/lib/api.ts` | Web 继续使用兼容 HTTP 契约 | `scripts/start.sh` 现启动 Rust `rn serve`；写入必须取得 `/api/session` Bearer token，已移除 FastAPI 404/405 无令牌 fallback；逐领域验收剩余响应契约 |
| `client/src/lib/capabilities.ts` | collect、publish、library.analyze 等静态本地能力仍不可用 | 核实实际入口和运行时覆盖；接入验证后的能力，不能直接全改 true |
| `Profile.tsx`、`scripts/start.sh` | Profile Web 刷新走 HTTP worker；开发启动脚本已改为 Rust API + Vite；旧 FastAPI 服务已整体删除 | Rust worker 与 8765 健康检查已接入启动流程；真实 Web 产品验收仍待完成 |
| `app/`、`pyproject.toml`、`uv.lock`（已退役） | 历史 Python REST/CLI/MCP 与第一方依赖 | 已删除；Rust `rn` 提供 HTTP、CLI、MCP，完整调用错误与旧客户端配置迁移验收仍待 |
| `crawler/`、`tools/MediaCrawler` | 旧采集 / 分析 / 发布脚本链路 | 有界浏览器 worker 与扩展替代；不直接修改子模块 |
| `.github/workflows/release.yml` | 已取消递归子模块 checkout；本地 macOS debug bundle 无 Python 资源 | CI 干净检出构建、无 Python command 审计及各平台产物检查仍待完成 |

已完成的 Rust SQLite、本地 AI、发布 staging / outbox、扩展快照与部分文字填充应复用。历史 N00–N14 或 R01–R07 自动验证不等于完整 Python 功能对等。

必须衔接[浏览器插件完整计划](../CHG-20260926-008-扩展单篇快照采集/00-03-浏览器插件完整开发与优化-Luna执行计划.md)：该计划已有 P0–P7 实施记录，当前文字填充不等于图片 / 视频上传已完成，当前复制扩展目录不等于独立安装分发。先核对最新检查点，不能覆盖另一任务改动。

## 3. 目标结构

- Rust 领域服务统一负责数据库、账号隔离、文件、任务、AI、发布状态。Tauri command、CLI、MCP、Web HTTP 只是适配层，避免四套业务逻辑。先从现有模块抽取可复用服务边界，必要时增加 workspace crate，不为拆分而整体重写。
- 桌面直连 Rust；Web 兼容服务独立启动，不成为桌面启动前置条件。保留已使用的 HTTP 契约，取消 FastAPI 实现。
- 独立采集建议使用 Node Playwright worker，由 Rust 管理，运行时随包提供，用户不必安装 Node 或 Python。PY04 先验证跨平台体积、启动、浏览器安装和分发可行性；如改用 Rust CDP，先记录等价能力证据和方案调整。不能直接运行 Chromium 二进制替代现有受控会话流程。
- Native Messaging 优先独立 Rust 宿主，复用现有协议版本、ACK 和幂等机制；与插件 P7 共用交付，不另建协议。
- 所有入口显式绑定工作区 / 账号；长任务有 requestId、取消、超时、最终结果和有界日志。敏感配置不进入 stdout、测试 fixture 或发布物。

## 4. 分阶段实施

依赖主线：PY00 → PY01 → PY02/PY03/PY04 → PY05/PY06/PY07/PY08 → PY09 → PY10。斜线表示可独立推进的工作，不表示默认启动子代理。每阶段完成实现、针对性验证、检查点后继续可执行项；不能因真实平台验收待用户而停止所有独立开发。

### PY00：建立逐项契约和基线

交付 [`00-10-Python替代契约与验收矩阵.md`](./00-10-Python替代契约与验收矩阵.md)，枚举所有 Python 路由、CLI group/command、MCP tool、脚本及其实际调用方。该矩阵已完成静态入口与迁移归属盘点；CLI 参数错误矩阵、63 种前端 HTTP 调用形态到 Rust handler 家族映射、主要响应字段 fixture 和本机合成双账号检查已补齐。其它命令完整输出/交互及全量 MCP 状态组合仍有缺口。每行包含旧行为、输入 / 输出 / 错误、账号语义、目标服务、测试、删除条件、实际状态。记录无调用死代码的搜索证据，不能把未发现入口直接视为已废弃。

至少覆盖素材 CRUD / 分析 / 标签 / 修复、笔记生成 / 多版本 / 状态 / 导出 / 统计、账号池 / 人设、榜样 / 知识 / 记忆、设置 / 提示词 / 模型、采集任务 / 历史、发布 staging / outbox、CLI / MCP / Web。对旧实现有缺陷或历史行为冲突的项目单列决定，不固化错账号等缺陷。

退出条件：每个活跃 Python 入口有替代去向；现有支持平台和功能矩阵明确；隔离数据库和旧接口可复现基线建立。不得读取凭据或复制正式登录态制作 fixture。

### PY01：统一非 GUI 领域服务

Rust `db::LocalDb` 已抽为 `client/core` 共享 crate；`client/services` 承接 Prompt、Provider 请求与浏览器 worker supervisor，Tauri、独立 `client/rn` 复用这些领域能力。HTTP adapter 和 GUI 命令仍由 Tauri crate 提供，但 CLI/MCP 不依赖窗口进程。剩余以跨入口同契约和错误隔离为验收重点，不把 crate 拆分数量当作 PY01 完成标准。

从 `client/src-tauri/src/db/`、`model_api/`、现有任务模块抽取可由独立进程调用的服务。GUI AppHandle / 事件发射与业务解耦，CLI 和 MCP 不要求桌面窗口运行。统一数据目录解析、schema 版本、错误结构、并发写入和取消句柄。

退出条件：Tauri 与无 GUI 测试访问同一隔离数据库得到一致结果；账号切换、删除、过期上下文不会跨账号写入；错误可定位且不会泄露密钥。

### PY02：补齐数据与文件能力

按 PY00 矩阵补齐素材、笔记、账号、人设、榜样、知识、记忆、统计、设置和导出。复用已完成的迁移及导入安全工具。保留 `published_at` 与导入时间差异、图片顺序、相对路径、缺失文件语义、note_type 和历史字段。

文件复制 / 删除与数据库更新须处理失败恢复；迁移前备份、版本检查、恢复验证。只用 QA 副本测试，不重新导入正式库。

退出条件：契约样例对等；并发 / 错账号 / 缺文件 / 中断写入用例通过；升级失败可恢复；旧数据无静默丢失。

### PY03：补齐 AI 与分析链路

复用 Rust 异步 Model API、CLI Provider 及前端流生命周期，实现素材图片分析、人设分析、榜样分析、提示词拼装和各类生成。核对旧 Python prompt、结构化字段及持久化行为，避免仅迁移“聊天”。

文本、图像理解、图片生成按真实模型能力分别检测；例如旧 MiniMax VLM 路径不能未经验证改成普通文本兼容接口。模型配置、取消、流中断、请求上限和代理行为复用现有实现。

退出条件：mock 契约 / 错误 / 取消测试通过；真实供应商与 CLI 验证单列证据，未验证不宣称支持；不存在隐式回落 Python。

### PY04：独立受控浏览器 worker

定义版本化 JSON 协议及任务类型；参数按结构传递，禁止拼接 shell。Rust 管理进程树、启动握手、输出上限、超时、取消和退出清理。浏览器通过选定自动化库的受支持启动 API 管理。

建立独立用户数据目录、账号会话锁、用户可见登录 / 退出 / 清除入口。旧 MC_PYTHON 会话在迁移完成前保持原机制；不得自动复制 Cookie/profile 或假设旧目录可安全复用。必要时引导用户在新独立会话重新登录。

退出条件：无 Python 的 QA 环境启动并完成本地 fixture 浏览器任务；缺运行时、浏览器缺失、进程崩溃、取消和重启均有明确结果；桌面退出无孤儿 worker；跨平台分发方案有实测依据。

### PY05：替代采集与数据分析脚本

逐项替代旧搜索、作者 / 主页、笔记详情、已支持评论和统计、分析 / 历史入口。保持手动发起、低频、有界数量，遇登录失效 / 验证 / 限流停止并提示用户。只采当前授权及可取得内容，不扩大为全量抓取。

来源 URL、采集时间、原始证据、未知字段、摘要去重和账号归属进入统一服务。受控采集与扩展单篇快照共用数据规范；写入回执和重试幂等，未知指标不填 0。

退出条件：fixture 覆盖列表 / 详情 / 缺字段 / 重复 / 失败恢复；真实平台逐入口验证；旧脚本每个活跃能力有对照记录。历史上未支持的能力不凭空扩展。

### PY06：发布链路完整对等

与插件计划 P5/P7 合并实施，复用发布准备、排序暂存文件、打开文件夹、outbox 和最终 ACK。核对旧文本 / 图文 / 视频实际支持范围，分别登记验收，不能用已实现的文字填充代替全部发布能力。

对需要上传的媒体设计有界文件交付协议（任务绑定、有效期、大小 / 类型限制、路径约束和取消）；保留用户主动领取、预览差异、确认填充、人工最终提交。失败可恢复，过期任务拒绝，结果未知不自动重发；发布状态只按明确结果 / 用户确认更新。

退出条件：各支持类型完整走通准备→填充→人工提交→结果确认，账号错误 / 文件缺失 / 断连不误标成功；真实发帖只在用户明确授权时进行，否则保留待验收项。

### PY07：替代 CLI 与 MCP

PY07 初始实施记录（2026-09-28；旧测试计数及未纳入安装包的阶段结论已由下方当前状态取代）：Rust `rn` 独立二进制已覆盖 `db init`、素材分析/非分析 add、list/show/analyze/tag、软删除、回收站 list/restore/受保护 purge、单/多素材 draft Prompt、topic Prompt、笔记 list/show/edit/export、榜样人工 CRUD、人设 init/show/edit 及统计字段；支持 JSON、账号上下文、笔记版本校验、Markdown 导出及显式/环境/项目 DB_PATH。缺失数据库的非交互初始化要求 `--yes`，交互模式先显示完整路径确认。旧 `--delete-file` 实际仍只软删除；Rust 接受该参数并提示 purge 的明确确认流程。`client/core` 提供账号隔离的互动规律、我的高赞样本、榜样笔记、灵感上下文；Rust `client/services` 统一旧单/多/选题 Prompt 结构，人设、榜样、补充要求及知识来源由桌面单/多素材建稿、CLI 与 MCP 复用；Tauri 原子保存素材顺序、`account_ref` 和 `prompt_used`。旧 Python `ref_notes` 列保留时优先读取，否则使用新 `top_notes`。图片分析复用 MiniMax `/v1/coding_plan/vlm` 请求/响应契约，密钥优先读取桌面 `model_api_settings_v1`，开发过渡期仍兼容环境变量和 `.env`；写回检查素材账号、图片版本并保护手工标题。Rust `rn mcp` 暴露全部 14 个旧工具 schema；`add_item_from_path` 限定在 `AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR`，默认 `analyze=true` 调用 VLM。初始 LocalDb/service/CLI/MCP 测试及 Tauri library check、前端 build 当时通过；未调用真实 API，受限环境下的在线 mock 标为 ignored。

用 Rust 适配共享服务，实现原 `rn` CLI 的命令、参数、退出码、JSON / 文本输出及安装入口。MCP 使用非 Python stdio 服务，保留 tools/list schema、tools/call 结果与错误；stdout 只输出协议，日志走 stderr。执行时核验选定 MCP 库当前协议兼容性。

已发现 14 个 MCP tools：get_profile、update_profile、list_items、get_item、add_item_from_path、tag_item、draft_note_prompt、list_notes、get_note、save_note、publish_note、export_note、list_accounts、get_analytics。PY00 复核是否新增。特别注意：旧 `publish_note` 只是标记本地已发布并记录链接，不能迁成自动向平台发帖。

当前：关闭 GUI、空 Python PATH 下 rn CLI/MCP 均有隔离进程回归；CLI 已覆盖参数/别名、主要文本与 JSON 输出、错误码、工作流、Unix 伪终端确认、worker 收尾、profile edit 17 字段、人设完整详情、笔记编辑/封面/Markdown 导出、榜样账号统计与重复 ID 更新、旧 `library delete --delete-file` 软删除兼容，以及 `content topic` 分析文件缺失时普通/JSON 输出流。MCP 保留旧 14 个工具并扩展到 22 个，隔离覆盖 schema、结果类别、参数类型、主要账号/软删除状态，并用真实 stdio 子进程验证 PC 记忆/经验 CRUD、字段省略保留、笔记搜索和来源拒绝；`add_item_from_path` 默认分析且缺密钥失败时不导入的合同也已通过。当前测试：core 64/64、services 23/23、rn 65 单测 + 24 子进程 = 89/89、Tauri 51/51；四 crate strict Clippy/rustfmt、browser-worker 17/17、AI stream 4/4、Tauri resource guard 和 Vite production build 通过。第一方源码无 `.py` 文件，Cargo/npm 锁文件无 Python runtime 依赖；denylist 下当前源码构建的 arm64 `.app`/DMG 资源检查、checksum 与映像内 Node/Chromium smoke 通过。仍待 Windows TTY、Intel macOS/Linux/Windows runner 与发行物、远端四平台 workflow、用户手动 MCP 配置迁移、真实 Provider/XHS 和 GUI/Web 产品验收；本机合同与 headless smoke 不代表这些项目已验收。

退出条件：GUI 关闭且无 Python 时 CLI 和 MCP 均能工作；旧命令 / 工具契约测试通过；账号选择一致；提供原 uv / Python 启动配置到新可执行入口的迁移说明，不保留 Python shim。

### PY08：前端与 Web 兼容入口收敛

PY05 主页采集增量（2026-09-29）：扩展升级 Native Messaging v9 / 0.8.1。用户明确点击主页“更新数据”后，`profile-notes.js` 有界滚动 16 次 / 最多读取 30 篇，并读取卡片摘要与互动；登录/验证时在提交前停止，链接去掉 query/fragment。Rust 只将本人主页写入本人笔记，将已登记榜样写入榜样 raw_data/top_notes；部分加载不改汇总，完整采集且各互动字段齐全才更新互动总量/均值。超时回执经快照 requestId 持久化并可恢复。fixture、账号隔离、手动编辑保留及恢复测试已通过；真实小红书 DOM 与扩展宿主尚未产品验收。

PY05 独立 worker 本人/榜样主页刷新增量（2026-09-29）：新增 collect-profile，复用按运营账号隔离的可见 Playwright 登录会话，仅读取目标主页上已渲染资料及最多 30 篇笔记。登录/验证停下并提示用户在浏览器手动处理，不调用私有接口；小红书 URL、账号 ID、输出字段、笔记数量和 IPC 体积均校验。桌面 Profile“同步小红书”及 Accounts 榜样导入已接入该 worker，主页 ID 必须匹配本人绑定 ID 或当前池内已登记榜样；只把本人笔记写入本人列表，榜样数据写入其 raw_data/top_notes。Rust DB 44 项、worker 13 项、Tauri profile parser 3 项、前端构建、扩展契约与 ARM64 runtime manifest 检查通过。真实 DOM、独立浏览器登录和 Windows/Linux/macOS Intel 未验收。作者关键词搜索、Web refresh/status、笔记详情/评论及分析历史仍未迁移。

PY04 浏览器 worker 增量（2026-09-29）：Playwright 1.62.1 已独立锁定；JSONL 长驻进程 supervisor 已下沉 `client/services`，Tauri commands 与 `rn serve` 共用账号会话、超时和进程清理实现。CI 打包脚本在原生目标 runner 复制 Node 22、worker、Playwright 和可见 Chromium，验证 target triple 并启动 Chromium QA 页面；Tauri resources / release manifest 门禁已接通。当前 ARM64 macOS 真实 Chromium fixture 和 `.app` bundle 通过，worker 13 项与 Rust supervisor 测试通过。单平台 runtime 原始资源约 521 MiB。其他三类 target 尚待 release matrix 实跑；Linux 系统依赖、签名/公证和 Windows runtime 安装边界仍需发行验收。该 sidecar 已承接本人/榜样主页刷新；`rn serve` Web `/api/profile/refresh{,-status}` 也已接入，并在任务完成后返回状态；Rust `rn search` 与 `search-notes` 已接通有界可见页面搜索。不可调用或复制旧 MC_PYTHON/Chrome 会话。

PY05 搜索分析脚本增量（2026-09-29）：`client/services::search_analysis` 和 `rn analyze --input ...` 已迁移 `crawler/xhs_analyze.py` 的 JSON 统计核心、报告输出及可选数据库记录；“万”互动数、旧字段回退、稳定 Top 10 与 hook 计数有 fixture。Rust `crawl_logs` 新增可空 `account_pool_id`，旧表自动补列并保留既有日志，新记录要求激活账号匹配；core 46/46、services 17 passed/1 ignored、rn 37/37。可见页面搜索与 JSON 输出已由 `rn search` 接通；`rn crawl history` 提供按当前账号隔离的最近 1–100 条采集历史，旧的未归属账号记录不出现在任何账号列表；真实页面 DOM 和登录流程仍待用户验收，旧 Python 脚本暂时保留作迁移对照。



PY05 bounded keyword search 增量（2026-09-29）：worker 新增 `search-notes`，只导航到小红书搜索页并读取已渲染卡片，最多四次滚动、每关键词最多 50 篇；Rust `rn search` 最多接受 5 个关键词，保存 JSON，`--save-db` 写当前账号的 crawl_logs 计数和文件位置。URL 严格限制搜索路径和参数，结果按 note URL 去重并剥离追踪 query；登录/验证只暂停供用户人工处理。浏览器 worker 17/17、rn 37/37、services 17 passed/1 ignored、core 46/46、Tauri `cargo check --lib --offline`、fmt 与 `git diff --check` 通过。Fixture 覆盖页面字段映射、计数文本、token 清理、账号会话和登录/验证状态；真实 XHS DOM、排序表现及搜索登录态尚未产品验收。

2026-09-28 进度补充：经验库 rules、my-samples、ref-samples、inspirations 四组旧 HTTP 路由现均已由 Rust adapter 覆盖；Tauri 榜样样本编辑也已接入本地 SQLite。发布暂存 HTTP 路由现支持图片暂存、账号绑定的安全回读、清理和用户显式打开暂存目录；拒绝路径穿越/符号链接并限制单图 50 MiB。浏览器 `api.ts` 现支持 `VITE_API_BASE_URL`、内存 session token、403 后重取一次，并在旧 FastAPI 的 `/api/session` 返回 404 时沿用无 token 过渡请求。实际 Web 后端和启动脚本尚未切换；当时剩余 AI SSE、multipart 素材导入分析、采集任务等 FastAPI 契约。

2026-09-29 进度补充：Rust HTTP 现覆盖 `/api/ai/quick` JSON、`/api/ai/chat` 与 `/api/ai/inspire` SSE，复用 services crate 的兼容 Provider 请求/流解析；输入与响应受限，断连触发取消，错误不泄露密钥，账号上下文限定当前激活账号。素材 `multipart/form-data` 导入和 `/api/library/{id}/analyze` 已复用 Rust 图片签名/MIME/账号安全、MiniMax VLM 和版本条件写回；上传默认为立即返回并异步分析，单图上限 25 MiB。`/api/content/draft`、`draft/multi` 与 `draft/generate` 已迁移到 Rust Prompt/Provider，保持旧响应字段、素材关联与失败不留空草稿。`/api/settings/env` 保持旧字段契约但将 PATCH 写到 SQLite `model_api_settings_v1`，只读兼容旧环境变量 / `.env`，不会再回写 `.env`；profile PATCH 已补齐头像、平台简介、关注数、IP 地区、平台标签及风险确认字段。榜样 `analyze`/`insights`/`imitate` 路由均已由 Rust 接管，生成内容按账号校验持久化，保留 SSE delta、done/full、缓存与旧 JSON 错误形状。桌面本人主页与已登记榜样主页走现有扩展快照；主页 ID 与账号/榜样主键匹配时更新昵称、粉丝数、笔记数及抓取时间，头像/简介/关注/IP/标签也已由快照补齐；最近 30 篇主页笔记与互动统计尚未迁移，旧 HTTP refresh 仍为 503。普通 Web 外链改为当前浏览器新标签，Rust/Tauri 仍用系统 opener，`/api/crawler/open-url` 已无前端调用，待清理旧 crawler 路由。验证：core 39、rn 34 passed；rn strict Clippy、Rust fmt、Tauri cargo check、前端 build、Profile/浏览器采集契约脚本通过；Tauri lib tests 26 passed，4 项因沙箱禁止本地 TCP/Unix socket 绑定失败。Tauri strict Clippy 额外检出 9 条非本轮新增代码的 lint。services 10 passed / 1 ignored 为此前执行结果。真实 Provider、listener 与 WebView 仍未验收。

PY04 packaging 增量（2026-09-29）：release workflow 已改为 Node 22 和目标原生架构 runner，并执行 Chromium 安装、Node/Playwright/Chromium staging 与 target manifest 检查；ARM64 macOS 本地 app bundle 已验证资源布局。打包器去掉未用的 headless shell 与 ffmpeg 后，独立 worker resources 约 521 MiB，安装包体积需要作为产品决策与各 target 实际产物持续跟踪。此单 target smoke/build 不代表全平台发布包或用户登录验收。

逐调用方替换 api.ts、legacy-http、BackendGate、页面 Python 提示和启动脚本。纯浏览器开发 / 已支持 Web 用法由 Rust HTTP 适配器承接，保持既有契约；桌面保持直接 command 调用。2026-09-28 已新增 `rn serve [--port PORT]`，默认绑定 `127.0.0.1:8765`，校验 loopback Host，并只允许内置 Vite 与显式配置的 loopback Origin；当前覆盖 `/`、`/health`、激活账号资料/账号池/榜样读取与榜样 CRUD、提示词读取与 CRUD、素材列表/详情/回收站/图片及写入、笔记列表/详情/导出与 CRUD、账号池 CRUD 及 protection status、人设读取与完整可编辑字段 PATCH、四组知识读写、发布暂存图片安全 API，以及 analytics `summary`/`notes`/`insights`/`notes-trend`/`topics`。2026-09-29 又加入 `/api/ai/{quick,chat,inspire}`、素材 multipart 导入/异步 VLM 分析、内容单/多/生成草稿、设置 env 兼容路由及主页刷新/status worker 路由；worker supervisor 与 Tauri 共用。主页刷新只对绑定本人主页写入，笔记限制 30 篇并保留未知指标语义；需登录/验证则提示手工处理，缺 Node/worker 时返回任务错误。`/api/settings/env` 的 Rust PATCH 只保存应用 SQLite 配置，旧环境变量 / `.env` 仅在配置迁移前只读兼容，不再写 `.env`。知识规则按当前账号已发布笔记计算标题区间、时段、Top 3 标签、收藏率；规则写入 LocalDb 偏好并控制共享 Rust Prompt 上下文。Tauri 经验库本人样本逐篇管理和榜样样本增删也已接入 SQLite；旧 `ref_notes` 与 `top_notes` 均受支持，HTTP GET 保留旧样本的额外 JSON 字段。发布暂存读取限制当前笔记与账号、路径及图片大小。每进程随机 Bearer token 已作为写操作闸门，`GET /api/session` 仅向 allowlist Origin 发放；知识、提示词、素材、笔记、发布暂存、账号池、人设和榜样账号写入使用该闸门。JSON 写请求限制 1 MiB，multipart 图片上传单图上限 25 MiB；各领域写入均按当前运营账号验证。`api.ts` 默认指向本机 `rn serve` 的 8765 端口并为写请求获取会话令牌；`scripts/start.sh` 启动 Rust HTTP adapter 与 Vite。榜样 SSE 导入、关键词采集/历史、发布 worker/媒体/结果状态及剩余旧接口未迁移；话题统计当前账号已发布笔记标签和账号范围的 `crawl_logs.keywords`；旧的未归属账号记录不纳入。handler 有隔离 DB 单测，但未在沙箱启动真实 TCP listener；未完成页面兼容前暂不切换完整 Web 客户端或删除旧 FastAPI。不能因迁移放宽任意文件路径能力。

能力矩阵从实际适配器及运行时探测获得，不再以“不是 Tauri 就全部可用”推断。检查账号、模型、采集和发布各入口无旧分支漏网。8765 数字本身不是 Python 依赖；若保留兼容端口，记录其新进程归属。

退出条件：桌面 / Web 关键操作通过；无 Python 启动文案或 fallback；Web 服务关闭不影响桌面；启动停止脚本只管理自己创建的进程。

### PY09：删除依赖并收敛交付物

前置：所有活跃入口已替代，契约矩阵无“靠 Python 才可用”项。清理第一方 app / crawler 旧实现、pyproject.toml、uv.lock、MC_PYTHON 等活跃引用；逐项验证后删除，保留必要历史文档并标注过时。

局部先行结果（2026-09-28）：Tauri bundle resources 已移除 Python / MediaCrawler 目录；`prepare-tauri.mjs` 检查当前 Rust/UI 构建输入并拒绝将 app/crawler/MediaCrawler/Python lockfile 再加回 bundle，且该门禁挂入 `beforeBuildCommand`；release workflow 不再递归 checkout 子模块。本机生成的 macOS debug `.app/Contents` 仅有 Info.plist、Rust 可执行文件和 icon.icns，未发现 `.py`、Python/uv runtime、lockfile 或 MediaCrawler 名称。其后 Rust HTTP/CLI/MCP、浏览器 worker 完成主要替代，第一方 `app/`、`crawler/` Python 源及根 `pyproject.toml`/`uv.lock` 已删除；此处仍不代表多平台产物和真实产品验收通过。

修改 tauri.conf.json、prepare-tauri.mjs、根 / client 脚本、release workflow、安装和问题模板；取消不再需要的递归子模块检出。Native host / worker / 浏览器资源具有清单、版本、完整性检查和升级恢复流程；清理不再需要的依赖时同步对应锁文件。

MediaCrawler 子模块当前有脏修改：本阶段必须消除构建 / 运行 / 打包对它的依赖，但不直接修改、强制 deinit 或删除其工作树。物理移除需先保护所有者修改并记录处理决定；不得用清理第三方目录破坏其他任务。历史归档中存在 .py 不等于运行依赖，验收报告必须区分残留种类。

源码与桌面 bundle 中的第一方 Python 应用/依赖已删除，release workflow 不初始化 MediaCrawler。macOS arm64 `.app` 与 DMG 已在 Python command denylist 下构建；DMG checksum、递归资源 guard 与包内 Node/Playwright/Chromium headless smoke 通过。PY09 仍待 Intel macOS、Windows、Linux 产物检查及用户 MCP 配置迁移；MediaCrawler 子模块作为未使用的第三方目录保留，不纳入应用产物。

### PY10：无 Python 验证与产品验收

在清洁检出和隔离环境运行，不能仅测试开发者已安装 Python 的机器。将 python/python3/uv/pip 调用设置为显式失败并记录命中；结合构建依赖审计、进程树和包内容检查，避免只改 PATH 漏掉绝对路径调用。区分系统工具链内部依赖与本项目直接依赖，发现前者需记录和验证支持范围，不能隐瞒失败。

覆盖开发启动、构建、安装、升级、桌面功能、CLI、MCP、Web、扩展宿主、独立采集、AI 和发布准备；无源码目录、无系统 Node 的最终用户环境也必须运行随包能力。外部 AI CLI 是用户选配能力，其自身依赖单列，不作为应用基础启动条件。

现有 release matrix 包含 macOS arm64/x64、Windows、Linux：arm64 macOS `.app`/DMG 已本机构建并审计；其余目标由原生 runner workflow 检查，但远端矩阵尚未运行。各声明支持的产物分别构建及检查，原生运行验证单列；不能将 macOS 通过写成全平台通过。没有验证的平台明确标待验证。

退出条件：下方 AC 全部有证据；自动验证与用户产品验收分别签收；产品事实 / 技术事实 / 发布说明 / 用户手册 / 完成记录同步后才标整体完成。

## 5. 最终验收清单

| 编号 | 验收内容 | 步骤 | 预期结果 |
| --- | --- | --- | --- |
| PY-AC01 | PY00 全部活跃 Python 契约均有替代、测试和删除记录，无隐藏功能代替迁移 | 对照旧路由/CLI/MCP/脚本调用方与 00-10 矩阵，再搜索当前源码和启动入口 | 未验收：第一方源码和运行依赖扫描为零，主要 Rust/Node 路径及矩阵已覆盖；完整逐条旧能力真实链路仍有 XHS/Provider/UI 待验收。2026-10-06，Codex；证据：00-10、00-03 |
| PY-AC02 | 无 Python 环境完成支持平台开发启动与构建；禁用 Python 命令无命中 | 在 Python denylist 下启动/构建各支持平台，并检查审计日志 | 未验收：macOS arm64 当前源码 `.app`/DMG 构建零命中；Windows、Intel macOS、Linux 原生 runner/workflow 未运行。2026-10-06，Codex；证据：00-03、release workflow |
| PY-AC03 | 解包检查无 Python 资源 / 依赖；无仓库、无系统 Node 可启动随包功能 | 扫描实际包资源和链接；空 PATH/临时 HOME 启动随包 worker；原生 UI 用编译期 QA 隔离构建 | 未验收：旧 arm64 DMG checksum、资源 guard、无 libpython、映像内 Node/Chromium 内存页 smoke 通过；本轮另构建唯一 QA identifier 的 arm64 `.app`，实包 guard 零违规、主程序无 libpython。debug QA 启动不再报 packaged-only `resource_dir` 错误，但 CUA 未显示窗口，原生交互仍待。2026-10-08，Codex；证据：00-03 |
| PY-AC04 | 旧库升级、素材与笔记顺序 / 时间 / 账号隔离正确，失败可恢复 | 跑迁移/恢复测试和合成双账号端到端素材、笔记查询/切换 | 未验收：core 64/64、Tauri 51/51 和 QA-A/QA-B Web 双账号隔离流程通过；用户旧库升级/恢复及原生 GUI 数据回读仍待。2026-10-08，Codex；证据：00-03、core/Tauri tests |
| PY-AC05 | 文本与图片分析等真实 Provider 能力逐项可用，取消 / 错误可见 | 先跑本地 mock，再用明确配置的真实 Provider 验证文本、图片、取消、错误 | 未验收：services 23/23（MiniMax 仅本地 mock）及 AI stream 4/4 通过；未使用真实 Provider 凭据或发出真实请求。2026-10-06，Codex；证据：00-03 |
| PY-AC06 | 独立采集登录、结果、去重、限流、退出清理均正确，不调用旧脚本 | 在 worker fixture 覆盖成功/缺字段/重复/登录验证/取消/退出，再由用户验真实站点 | 未验收：worker 与采集隔离合同已覆盖，未登录真实 XHS 或访问真实浏览器 profile。2026-10-06，Codex；证据：00-03、browser-worker tests |
| PY-AC07 | 发布各支持类型填充、人工提交和结果核查正确，未知结果不重发 | 逐类型验证 outbox、图片/视频传输、扩展填充、人工提交与回执；真实提交须用户授权 | 未验收：隔离 fixtures 覆盖确认式填充/outbox 状态；真实 XHS 页面、视频文件选择和回执未验收，未执行发布。2026-10-06，Codex；证据：00-03、publish/extension tests |
| PY-AC08 | GUI 关闭时 rn 和全部 MCP tools 可用，兼容契约及错误语义 | 关闭 GUI；空 Python PATH 启动 rn，按旧及新增 schema 执行 tools/list 与隔离 tools/call 状态矩阵 | 未验收：本轮复验 rn 65 单测 + 24 子进程 = 89/89；空 PATH 22-tool 握手与记忆/经验 CRUD/search 合同通过；更广数据状态组合和用户 MCP 配置切换仍待。2026-10-08，Codex；证据：00-03、00-10 |
| PY-AC09 | Web 兼容可用，桌面不依赖 Web 服务，启动 / 停止无误杀 | 隔离 DB 启动 rn serve+Vite，验证关键路由/账号切换；另验证桌面离线启动和服务停止 | 未验收：Web 合成双账号 Playwright 路由流程通过；debug worker 资源路径修复后隔离进程不再因 `resource_dir` panic，但 CUA 未显示窗口，桌面独立启动和原生关键流程仍待复验。2026-10-08，Codex；证据：00-03 |
| PY-AC10 | 用户文档无活跃 Python 安装步骤，剩余历史引用及子模块状态解释明确 | 搜索 README、贡献指南、用户手册、工程说明和发布流程中的安装/启动说明 | 通过：当前 README/贡献指南说明第一方链路不依赖 Python，用户手册无活跃 Python 安装步骤；旧架构和 MediaCrawler 均标明历史/第三方边界。2026-10-06，Codex；证据：README.md、docs/CONTRIBUTING.md、00-10 |

每条记录：操作步骤、预期、实际、证据路径、平台、执行者、失败 / 未验证原因。构建通过不能替代真实浏览器和原生验收；不以简单字符串零匹配作为唯一证据。

## 6. Luna 恢复与交付要求

启动先核对当前 diff 和其他任务的检查点，再从 PY00 开始；不将本文件的建议写成已经实现的能力。每阶段在 00-03 顶部更新：基线 / 脏状态、完成内容、具体文件、测试命令与结果、AC 状态、阻塞、下一项。共享文件出现并行编辑先协调归属，避免覆盖。

阶段提交物为可运行代码、契约 / 验收矩阵、相关测试和检查点。最终报告明确“Python 运行依赖是否归零”“包内是否残留”“历史 / 第三方保留项”“哪些平台及真实链路待验收”。不得将阶段交付或历史自动检查包装成全部完成。

给 Luna 的执行指令：读取上述入口后，按 PY00–PY10 完成非 Python 等价替代，复用当前 Rust / 扩展成果，保留功能、数据和授权边界；每阶段验证并更新检查点，继续独立可执行工作。遇真实平台或用户数据操作边界，完成其余实现并明确待验收事项，不以静默禁用功能收尾。
