#!/usr/bin/env node
// Legacy Node Native Host registration was retired. The application now installs
// its channel-specific Rust launcher and browser manifest as one validated unit.
console.error(
  "此旧版 Node 宿主安装脚本已停用。请从爱吃红薯桌面端「设置 → 浏览器插件」安装或更新当前 DEV/正式通道。",
);
process.exit(2);
