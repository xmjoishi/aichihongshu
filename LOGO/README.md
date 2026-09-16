# 爱吃红薯 · Logo 资源索引

## 当前品牌方案

V2.8 是当前对齐的品牌设计方案，设计板和规范位于：

- [V2.8 设计板](v2.8/brand-board.png)
- [V2.8 品牌规范](v2.8/README.md)

V2.8 是当前设计和实现层的视觉 SOT。用户最新确认的图 3 原稿保存在 `v2.8/mark-image3-source.png`；`v2.8/mark.png` 与 `v2.8/mark-white.png` 是它的白底生产导出。Web favicon、网站 Logo 和 Tauri 多尺寸图标已经从图 3 生产导出生成，移动端资源尚未替换。

纯白底是桌面安装包与 Finder 图标的明确生产选择，避免透明 PNG 在系统图标容器中被渲染成灰色；更新前的透明版本已归档到 `legacy/`。

## 资源状态

| 目录 | 状态 | 说明 |
| --- | --- | --- |
| `v2.8/` | 当前方案 | V2.8 设计板、图 3 原稿、白底生产 PNG 和兼容 SVG |
| `official/` | legacy | 旧版紫红薯图形及其 Dock 图标，暂不删除、不继续扩展 |
| `brand/` | compatibility | `logo-favicon.svg` 是 V2.8 favicon 兼容路径 |
| `legacy/` | legacy | 旧版 favicon 备份，供历史构建和回滚 |

## 使用边界

1. 新增 Logo 相关设计、导出或实现，先以 `v2.8/README.md` 为准。
2. 不要把设计板直接当作生产 favicon 或 App icon；生产资源必须从 `v2.8/mark-image3-source.png` 导出到 `mark-white.png`，兼容引用可使用同内容的 `mark.png`。
3. 已同步的桌面/Web 资源必须继续追溯到 `v2.8/mark-white.png`；移动端资源待单独实现，避免不同端显示不同品牌版本。
4. 旧版资源保留用于历史构建和回滚，不覆盖用户数据、账号会话或其他业务资源。
