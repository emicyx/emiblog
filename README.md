# emicyx blog 🍥

我的个人博客，基于 [Fuwari](https://github.com/saicaca/fuwari) 主题 + [Astro](https://astro.build) 构建。

## ✨ 特性

- 基于 **Astro** + **Tailwind CSS**，纯静态站，构建快
- 明暗双模式 + 可自定义主题色
- 平滑的页面切换动画（Swup）
- 搜索功能（Pagefind）
- Markdown 增强语法：警告框、GitHub 仓库卡片、Expressive Code 代码块、数学公式
- 目录（TOC）、RSS、站点地图
- 🐱 自定义的右下角**桌面宠物组件**（站 / 眨眼 / 坐下 / 被拎起，可拖拽）

## 🚀 本地开发

需要 **Node.js >= 20** 和 **pnpm >= 9**。

```bash
pnpm install        # 安装依赖
pnpm dev            # 启动开发服务器 → http://localhost:4321
pnpm build          # 生产构建到 ./dist/
pnpm preview        # 本地预览构建产物
pnpm new-post 文件名  # 新建一篇文章
```

## 📝 写文章

文章存放在 `src/content/posts/`，使用 Markdown，Frontmatter 示例：

```yaml
---
title: 我的第一篇文章
published: 2026-08-07
description: 文章简介
image: ./cover.jpg
tags: [随笔]
category: 生活
draft: false
---
```

## ⚙️ 个性化配置

- **站点信息 / 头像 / 横幅 / 社交链接**：编辑 `src/config.ts`
- **文章**：编辑 `src/content/posts/`
- **关于页**：编辑 `src/content/spec/about.md`
- **宠物组件**：源码在 `public/pet-widget/`，配置在 `src/layouts/Layout.astro`

## 📄 致谢

- 主题：[Fuwari](https://github.com/saicaca/fuwari)（MIT License）
