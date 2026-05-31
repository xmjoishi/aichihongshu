# 爱吃红薯 Mobile 开发手册

本手册覆盖三件事：

- 日常 Debug（日志、热更新、常见报错）
- iOS 模拟器运行
- iOS 真机部署（Development Build）

> 当前项目基于 `Expo SDK 56`（`expo ~56.0.4`）。
> 建议优先使用 **Dev Client**，不要依赖旧版 Expo Go。

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
2. 改用机型名启动（不要用旧 UDID）

```bash
pnpm exec expo run:ios --simulator "iPhone 16 Pro"
```

3. 或直接回到推荐开发模式：

```bash
pnpm exec expo start --clear
```

---

## 4. iOS 模拟器运行

### 4.1 方式一：Expo 启动后按 `i`

```bash
pnpm exec expo start --clear
```

在交互终端里按 `i` 自动打开模拟器。

### 4.2 方式二：直接 run:ios

```bash
pnpm exec expo run:ios
```

如需指定机型：

```bash
pnpm exec expo run:ios --simulator "iPhone 16 Pro"
```

> `run:ios` 依赖原生工程，若缺失会触发 prebuild。

---

## 5. iOS 真机部署（推荐）

当 Expo Go 不兼容时，使用 Dev Client 真机部署。

### 5.1 生成 iOS 原生工程

```bash
cd mobile
pnpm exec expo prebuild --clean
```

### 5.2 Xcode 签名与安装

```bash
open ios/mobile.xcworkspace
```

在 Xcode 中：

1. 选择项目 target
2. 打开 `Signing & Capabilities`
3. `Team` 选择你的 Apple ID
4. `Bundle Identifier` 改为唯一值（如 `com.yourname.aichihongshu.mobile`）
5. 选择真机设备，点击 Run（▶）

### 5.3 连接 Dev Server

安装成功后，在项目目录执行：

```bash
pnpm exec expo start --dev-client --clear
```

真机打开已安装 App，会连接到本机 Metro。

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
