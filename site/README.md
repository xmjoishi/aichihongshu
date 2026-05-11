# Site

`site/` 是产品官网源码目录，负责获客叙事、产品展示和 GitHub Pages 部署入口。

## 当前结构

```text
site/
  index.html          # 首页：价值主张 + 关键产品展示
  product.html        # 产品页：AI 在各节点的具体价值
  architecture.html   # 架构页：系统结构与部署方式
  shared.css          # 官网共享样式
  main.js             # 官网交互（预览切换、舞台缩放）
  assets/
    favicon.svg
    og-home.svg
  screens/
    shared.css
    dashboard.html
    library.html
    notes.html
    inspire.html
    data.html
    accounts.html
    settings.html
```

## 设计原则

1. 首页只负责价值主张和信任建立，不把所有信息堆进首屏。
2. AI 价值必须按节点讲清楚，避免把官网写成泛化的“AI 很强”。
3. 产品展示单独拆到 `site/screens/`，后续精修某个页面时不用重改整份官网。
4. 官网源码和部署策略分离：源码在 `site/`，部署交给 GitHub Actions。

## 部署

仓库已提供 `.github/workflows/site-pages.yml`。

启用方式：

1. 打开 GitHub 仓库设置
2. 进入 `Pages`
3. `Source` 选择 `GitHub Actions`

## 后续建议

优先继续做这三件事：

1. 给 `site/screens/` 补更接近真实客户端的截图级细节
2. 继续扩展成多页官网，比如加入 `guide.html` 或 `pricing.html`
3. 如果后续页面继续增长，再把 `site/` 迁到 Vite 或 Astro 管理
