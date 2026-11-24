# Windows 桌面端启动手册

适用于从源码启动「爱吃红薯」Tauri 桌面端。Tauri 会启动 Vite，并在同一应用进程内运行 Rust 本地服务。手机端请看[移动端开发手册](../../mobile/README.md)。

## 首次准备

1. 安装 Node.js LTS 和 pnpm。
2. 安装 Visual Studio C++ Build Tools，选择「使用 C++ 的桌面开发」，包含 MSVC 和 Windows SDK。
3. 安装 Rustup 和 Stable MSVC 工具链。先在 PowerShell 中运行 `cargo --version`；若 Rustup 提示尚未配置默认工具链，则运行 `rustup default stable-msvc`。
4. 如果系统没有 Microsoft Edge WebView2 Runtime，安装 WebView2 Evergreen Runtime。[Tauri 的 Windows 环境准备说明](https://v2.tauri.app/start/prerequisites/#windows)

重新打开 PowerShell，检查命令并安装前端依赖。已有依赖且锁文件未变时，可直接启动。

```powershell
cd C:\Workspace\Project\Personal\aichihongshu\client
node --version
npm --version
cargo --version
pnpm install --frozen-lockfile
```

如果 pnpm 报 `ERR_PNPM_IGNORED_BUILDS` 且明确列出 `esbuild`，运行 `pnpm approve-builds`，仅勾选 `esbuild` 后重试安装。

## 日常启动

这台 Windows 机器曾遇到默认 WebView2 目录下窗口无法显示，也遇到过 1422 被占用。下面的命令同时指定独立的 WebView2 目录，并让 Vite 和 Tauri 使用同一个备用端口。命令会自行创建配置文件，可以在新克隆的工作区使用。

如果「爱吃红薯」已打开，继续使用现有窗口。需要重启时，先在原启动终端按 `Ctrl+C`，再运行下面的命令。

```powershell
cd C:\Workspace\Project\Personal\aichihongshu\client

$devPort = 1423
$devDir = Join-Path (Split-Path -Parent (Get-Location).Path) '.tmp\windows-tauri'
New-Item -ItemType Directory -Path $devDir -Force | Out-Null
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $devDir 'webview'
$devConfig = Join-Path $devDir 'tauri-dev.json'

@{
    build = @{
        devUrl = "http://127.0.0.1:$devPort"
        beforeDevCommand = "npm run dev -- --host 127.0.0.1 --port $devPort --strictPort"
    }
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $devConfig -Encoding ASCII

npm exec -- tauri dev --config $devConfig
```

首次 Rust 编译可能需要几分钟。看到「爱吃红薯」窗口后保留终端。结束时按 `Ctrl+C`。上述启动方式使用应用正常的数据库路径，只给内嵌 WebView 独立的配置和缓存目录。2026-11-24 已用隔离数据库验证原生窗口打开并响应，日常数据库仍待验证。

如果本机默认环境可以正常打开窗口，在 `client` 中也可以直接运行 `npm exec -- tauri dev`，默认地址为 `http://localhost:1422`。

## 启动故障

| 现象 | 处理 |
| --- | --- |
| `Port 1422 is already in use` | 使用上面的 1423 命令。若 1423 也被占用，改 `$devPort` 为其他空闲端口。 |
| 编译完成后窗口消失、无标题，或 setup 报 `os error 5` | 用上方独立 WebView2 目录重试。若仍失败，在运行最后一行前设置 `$env:RUST_BACKTRACE = '1'`，保留从 `Running ...aichihongshu.exe` 开始的终端日志。 |
| Cargo 报 `failed to remove file ...aichihongshu.exe` | 先关闭已有的「爱吃红薯」窗口，在旧启动终端按 `Ctrl+C`。若还残留进程，在任务管理器核对可执行文件路径，再结束本仓库的实例。 |
| Node 的 `DEP0205` 或 Rust 的 `dead_code` | 属于警告。继续查看后续是否出现 `error`，以及桌面窗口是否出现。 |
| 设置页提示浏览器扩展采集不支持 Windows | 当前分支的 Windows 桌面构建可以启动，浏览器扩展采集仍依赖 Unix 实现。 |

可用下面的命令核对 IPv4 和 IPv6 的监听者，以及已有的桌面进程：

```powershell
netstat -ano | Select-String ':142[23]\s.*LISTENING'
Get-Process aichihongshu -ErrorAction SilentlyContinue |
    Select-Object Id, MainWindowTitle, Path
```
