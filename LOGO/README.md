# 爱吃红薯 · LOGO 资源

> 主创意：被咬一口的紫红薯。竖纺锤本体，右侧三段扇贝形咬痕露出亮黄瓤，顶部对称两片绿叶。
> **当前主推**：`official/logo.svg`（用户自制官方版，优先使用）

## 目录结构

```
LOGO/
├── official/          # ★ 主推方案（用户自制官方版）
│   ├── logo.svg
│   └── dock-icon.png
└── brand/             # 综合品牌资源
    ├── logo-favicon.svg     # favicon 优化版（去叶子/暗影，主体放大）
    ├── logo-with-text.svg   # 含「爱吃红薯」中文字标横版（720x256）
    └── logo-mono.svg        # 单色版，currentColor 控色
```

## 配色规范

| 用途 | 色值 | 说明 |
|---|---|---|
| 表皮主色 | `#A41E3A` | 深酒红（紫红薯） |
| 表皮暗影 | `#7A1428` (30~50%) | 体积感/凹陷 |
| 内瓤色 | `#F5C518` | 亮黄（红薯瓤） |
| 叶子 | `#3B8C3F` | 深绿 |
| 描边/暗色 | `#3F1820` | 深红褐（仅文字/单色版用） |
| 背景奶油色 | `#FAF7F2` | 文档/启动屏背景 |

## 使用建议

### Tauri App icon
用 `official/logo.svg` 作为源文件（推荐主推方案），跑：
```bash
cd client
pnpm tauri icon ../LOGO/official/logo.svg
```
会自动生成 `client/src-tauri/icons/` 下的多尺寸 PNG/ICO/ICNS。

### Web favicon
用 `brand/logo-favicon.svg`，HTML：
```html
<link rel="icon" type="image/svg+xml" href="/logo-favicon.svg">
```

### 启动屏 / About 页
用 `brand/logo-with-text.svg`，720x256 横版，自带产品名 + slogan。

### 深色模式
用 `brand/logo-mono.svg`，外层套 CSS：
```css
.logo-dark { color: #FFFFFF; }
.logo-light { color: #3F1820; }
```

## 设计逻辑

- **咬痕方向**：固定在右上 1-2 点钟位置，符合中文阅读视线。
- **瓤色对比**：紫红表皮 + 暖橙瓤构成强对比，识别度高。
- **叶子斜度**：左叶向左 35°、右叶向右 25°，中间弯须 5° 斜向，避免对称呆板。
- **拟人化（仅风格 B）**：眼睛是眯眼弧线（傲娇），不是圆点；嘴是单边翘起（嘴硬不服），呼应"虾薯"人设。
