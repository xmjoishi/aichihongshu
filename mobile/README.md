# 爱吃红薯 Mobile 开发手册

本手册覆盖三件事：

- 日常 Debug（日志、热更新、常见报错）
- iOS 模拟器运行
- iOS 真机部署（Development Build）

> 当前项目基于 `Expo SDK 56`（`expo ~56.0.4`）。
> 建议优先使用 **Dev Client**，不要依赖旧版 Expo Go。
> 本项目移动端开发、联调、截图统一使用 **`iPhone 16 Pro iOS 26.5`**，不要混用 `iOS 18.x` 模拟器。

---

## 1. 环境准备

### 1.1 基础依赖

- Node.js（建议 LTS）
- `pnpm`
- Xcode（当前环境可用 `Xcode 26+`）
- iOS 模拟器（随 Xcode 安装）

### 1.2 安装依赖

```bash
cd mobile
pnpm install
```

> 项目统一使用 `pnpm`，不要混用 `npm`。

---

## 2. 快速启动（开发模式）

### 2.1 启动 Metro

```bash
cd mobile
pnpm exec expo start --clear
```

### 2.2 连接方式

- Expo Go：扫码或手动输入 `exp://<本机IP>:8081`
- Dev Client：运行后连接 `http://localhost:8081`

> 若提示 "Project is incompatible with this version of Expo Go"，是 Expo Go 版本不支持 SDK 56。请走第 5 节真机 Dev Client。

### 2.3 固定使用 iOS 26.5 模拟器

推荐固定流程：

```bash
cd mobile
pnpm exec expo start --clear
```

然后在 Simulator 中手动确认当前设备为：

- `iPhone 16 Pro`
- `iOS 26.5`

如果需要原生重编译，统一使用：

```bash
cd mobile
pnpm exec expo run:ios --device "iPhone 16 Pro iOS 26.5"
```

如果本机存在多个同名 `iPhone 16 Pro`，优先使用 UDID，避免 Expo 命中旧的 `iOS 18.x` Runtime：

```bash
xcrun simctl list devices available
pnpm exec expo run:ios --device "模拟器 UDID"
```

---

## 3. Debug 手册

## 3.1 常用命令

```bash
# 启动（清缓存）
pnpm exec expo start --clear

# TypeScript 检查
pnpm exec tsc --noEmit

# iOS 原生运行（需要已 prebuild）
pnpm exec expo run:ios
```

### 3.2 看日志

- JS/Metro 日志：看 `expo start` 的终端输出
- iOS 原生日志（可选）：

```bash
xcrun simctl spawn booted log stream --level debug --style compact
```

### 3.3 调试入口

- iOS 模拟器：`Cmd + D` 打开开发菜单
- 真机（Dev Client）：摇一摇打开开发菜单

终端快捷键（`expo start` 前台运行时可用）：

- `i`：打开 iOS 模拟器
- `j`：打开 JS 调试器（React Native DevTools，浏览器）
- `m`：打开开发菜单
- `r`：Reload

可用功能：

- Reload
- Toggle Inspector
- Performance Monitor

### 3.4 `expo start` vs `expo run:ios`

- `pnpm exec expo start --clear`：推荐日常开发方式，启动 Metro，按 `i` 进入模拟器
- `pnpm exec expo run:ios`：会走 Xcode 原生编译，适合装 Dev Client 或排查原生问题

如果你只是做页面开发，优先用 `expo start`。`run:ios` 更容易受 Xcode 运行时/目标设备影响。

### 3.5 常见问题

#### 问题 A：端口占用（8081/8082）

```bash
lsof -ti:8081 | xargs kill -9
pnpm exec expo start --clear --port 8082
```

#### 问题 B：Metro 卡死或缓存异常

```bash
pnpm exec expo start --clear
```

#### 问题 C：`expo-file-system` 提示 deprecated

项目已使用 legacy API，调用方式应为：

```ts
import * as FileSystem from 'expo-file-system/legacy';
```

#### 问题 D：`expo-media-library/legacy` 解析报错

项目已在 `mobile/metro.config.js` 做过兼容；若异常，先重启 Metro 并清缓存。

#### 问题 E：`xcodebuild` 报错 70，提示 destination 不可用

常见原因：

- Xcode 缺少对应 iOS Runtime（如提示 `iOS xx.x is not installed`）
- 命中了旧的模拟器 UDID（`Unable to find a destination matching id=...`）

处理步骤：

1. 打开 `Xcode > Settings > Components` 安装对应 iOS Runtime
2. 使用 `--device` 指定设备名或 UDID。若存在同名模拟器，优先使用 UDID

```bash
pnpm exec expo run:ios --device "iPhone 16 Pro"
```

3. 或直接回到推荐开发模式：

```bash
pnpm exec expo start --clear
```

#### 问题 F：`No script URL provided`

这表示 Development Build 已安装，但 Metro 没有运行。启动 Dev Client 对应的 Metro：

```bash
pnpm exec expo start --dev-client --clear
```

也可以重新运行原生构建命令，并确保没有添加 `--no-bundler`：

```bash
pnpm exec expo run:ios --device "设备名或 UDID"
```

#### 问题 G：`ExpoKeepAwake` 找不到 Swift 输入文件

如果 Pods 仍引用 `node_modules/expo/node_modules/expo-keep-awake`，但项目使用的是 pnpm 布局，需要重新生成 Pods 引用：

```bash
cd ios
pod install
cd ..
pnpm exec expo run:ios --device "设备名或 UDID"
```

`pod install` 需要联网下载 React Native/Hermes 依赖。不要手工修改 `Pods.xcodeproj` 中的路径。

---

## 4. iOS 模拟器运行

### 4.1 方式一：Expo 启动后按 `i`

```bash
pnpm exec expo start --clear
```

在交互终端里按 `i` 自动打开模拟器。

> 若本机同时存在 `iOS 18.x` 和 `iOS 26.5` 的同名模拟器，`i` 可能打开旧 Runtime。此项目不建议依赖这种自动选择方式做联调或截图。

### 4.2 方式二：直接 run:ios

```bash
pnpm exec expo run:ios --device "iPhone 16 Pro iOS 26.5"
```

如需指定机型：

```bash
pnpm exec expo run:ios --device "iPhone 16 Pro iOS 26.5"
```

> `run:ios` 依赖原生工程，若缺失会触发 prebuild。

### 4.3 iOS SDK、最低版本与模拟器版本

以下三个版本含义不同：

- Xcode iOS SDK：编译时使用的 SDK，决定能否面向最新 iOS 构建
- Deployment Target：应用允许安装的最低 iOS 版本，不是最高版本
- Simulator Runtime：当前模拟器实际运行的 iOS 版本

例如 `IPHONEOS_DEPLOYMENT_TARGET = 16.4` 表示支持 iOS 16.4 及以上，不妨碍应用运行在 iOS 26.5。若命令启动了 iOS 18.2，通常是选中了旧 Runtime 下的同名模拟器。

本项目约定：

- 默认联调设备：`iPhone 16 Pro iOS 26.5`
- 默认截图设备：`iPhone 16 Pro iOS 26.5`
- 如果 `expo run:ios` 启动成 `iOS 18.x`，不要继续调试，直接切回 `26.5` 后再运行

### 4.4 创建最新 iOS 模拟器

1. 打开 `Xcode > Settings > Components`
2. 下载需要的 iOS Simulator Runtime
3. 打开 `Xcode > Window > Devices and Simulators`
4. 切换到 `Simulators`，点击左下角 `+`
5. 设置名称、Device Type 和 OS Version，例如：
   - Simulator Name：`iPhone 16 Pro iOS 26.5`
   - Device Type：`iPhone 16 Pro`
   - OS Version：`iOS 26.5`
6. 点击 `Create`

查看可用设备及 UDID：

```bash
xcrun simctl list devices available
```

使用 UDID 可以避免 Expo 命中同名的旧模拟器：

```bash
pnpm exec expo run:ios --device "模拟器 UDID"
```

---

## 5. iOS 真机部署（推荐）

当 Expo Go 不兼容时，使用 Dev Client 真机部署。

### 5.1 准备 iPhone

1. 使用数据线连接 Mac 和 iPhone
2. 在 iPhone 上选择“信任此电脑”
3. 打开 `设置 > 隐私与安全性 > 开发者模式`，启用后按提示重启
4. 建议让 iPhone 和 Mac 连接同一局域网

### 5.2 生成 iOS 原生工程（仅在需要时）

仓库已有 `mobile/ios` 时不需要每次执行 prebuild。仅在原生工程缺失或原生配置变化后运行：

```bash
cd mobile
pnpm exec expo prebuild --clean
```

`--clean` 会重新生成原生工程；签名、包名等需要持久化的配置应先写入 `app.json` 或 Expo config。

### 5.3 Xcode 签名与安装

```bash
open ios/app.xcworkspace
```

在 Xcode 中：

1. 左侧选择蓝色 `app` 项目
2. 选择 `TARGETS > app > Signing & Capabilities`
3. 勾选 `Automatically manage signing`
4. `Team` 选择你的 Apple ID
5. 将 `Bundle Identifier` 改为唯一值，例如 `com.yourname.aichihongshu`
6. 在 Xcode 顶部设备列表选择已连接的 iPhone
7. 点击 Run（▶）安装 Development Build

同时应将同一个 Bundle Identifier 写入 `app.json` 的 `expo.ios.bundleIdentifier`，否则以后 prebuild 可能恢复旧包名。

完成一次 Xcode 签名配置后，也可以通过命令选择并安装到真机：

```bash
pnpm exec expo run:ios --device
```

不要添加 `--no-bundler`，除非另一个终端已经启动 Metro。

### 5.4 连接 Dev Server

安装成功后，在项目目录执行：

```bash
pnpm exec expo start --dev-client --clear
```

真机打开已安装 App，会连接到本机 Metro。

如果 iPhone 提示开发者不受信任，打开 `设置 > 通用 > VPN与设备管理`，信任对应 Apple ID。免费 Apple ID 的开发签名通常需要定期重新安装；需要提供给其他测试人员时，使用 TestFlight 或 EAS Build。

---

## 6. 可选：EAS 云构建（团队分发）

如果需要给他人安装测试包，可用 EAS：

```bash
pnpm add -g eas-cli
eas login
cd mobile
eas build:configure
eas build --profile development --platform ios
```

---

## 7. 推荐日常流程

```bash
cd mobile
pnpm install
pnpm exec tsc --noEmit
pnpm exec expo start --clear
```

若出现 Expo Go 版本不兼容：

1. `pnpm exec expo prebuild --clean`
2. Xcode 真机 Run 安装 Dev Client
3. `pnpm exec expo start --dev-client --clear`
