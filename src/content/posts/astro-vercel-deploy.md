---
title: 从零上线：用 Vercel 部署 Astro 博客并绑定阿里云域名
published: 2026-08-15
description: 记录本站从域名注册、Vercel 部署、DNS 解析到 Git 自动化拉取文章的完整上线流程，踩过的坑一并整理。
image: ''
tags: [Vercel, Astro, 部署, 域名]
category: 开发
draft: false
lang: ''
---

# 从零上线：用 Vercel 部署 Astro 博客并绑定阿里云域名

博客写好了，下一步就是让它真正跑在互联网上。本站基于 [Astro](https://astro.build/) 构建，托管在 [Vercel](https://vercel.com/) 上，域名则在阿里云注册。这篇文章完整记录了从"一个本地仓库"到"一个可以访问的网站"的全过程，一共五个阶段：

```
注册域名 → 连接 Vercel → 配置 DNS 解析 → Git 自动化拉取文章 → 收尾验证
```

## 1. 域名注册

首先需要一个属于自己的域名。打开阿里云的**域名控制台**，进入 **域名管理 → 信息模板**，先创建一个信息模板并完成**实名认证**——这是注册域名的前置条件，模板审核一般需要**一个小时左右**，可以趁这段时间先把后面的步骤看完。

> [!NOTE]
> 信息模板实名认证通过后再购买域名注册服务，流程会更顺畅；如果模板还没生效就下单，域名会一直卡在"审核中"状态。

认证完成后购买域名注册服务，随后在**域名管理 → 域名列表**中就能找到对应的域名，状态显示为**已认证**，即可进入下一步。

## 2. 将博客仓库连接到 Vercel

本站以 Astro 博客为例。

首先将代码上传到 GitHub 仓库，然后打开 [Vercel](https://vercel.com/)，使用 GitHub 账户登录。登录完成后点击 **Add new → Project**，在仓库列表中找到对应的项目，点击 **Import** 导入。

导入时有两个地方需要确认：

- **Root Directory**：确认配置是否正确。如果仓库根目录本身不是一个 Astro 项目（比如项目嵌套在子目录里），就需要填写对应的目录作为 Root Directory；
- 下拉到 **Build and Output Settings**，确认构建配置：

| 配置项 | 推荐值 |
| --- | --- |
| Build Command | `npm run build` 或 `astro build` |
| Output Directory | `dist` |
| Install Command | `yarn install` / `pnpm install` / `npm install` / `bun install` 任一 |

> [!TIP]
> 大多数情况下 Vercel 会自动识别出 Astro 项目并填好以上配置，只需要逐项核对一遍即可。

确认无误后点击 **Deploy**，稍等一两分钟，Vercel 会自动完成构建并分配一个 `xxx.vercel.app` 的临时域名——此时博客其实已经可以访问了，只是还没有一个正式的"门牌号"。

## 3. 配置 DNS 解析

接下来把第 1 步注册的域名指向 Vercel。

在 Vercel 控制台进入 **Domains**，点击 **Add Existing**，输入你注册的域名，依次选择 **Connect to an environment → Production → Save**。

> [!IMPORTANT]
> 添加完成后域名此时是**无法访问的**，这是正常现象——还差最后一步解析记录。点开该域名的 **DNS configuration**，可以找到 Vercel 提供的 CNAME 记录值（value），将其记下来。

打开阿里云域名工作台，找到对应域名点击**解析**，选择**添加记录**，添加以下两条：

| 记录类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| CNAME | `www` | 上一步记下的 value |
| A | `@` | Vercel 提供的 IP 地址 |

> [!TIP]
> CNAME 的记录值也可以直接使用 `cname.vercel-dns.com`（Vercel 官方 DNS），效果相同。

添加完成后回到 Vercel 控制台，可以看到对应域名的解析状态已经变为正确，DNS 生效通常只需几分钟。此时通过域名已经能访问博客了。

## 4. Git 自动化拉取文章

如果文章和博客框架分开存放（比如文章在独立的 `blogs` 仓库中，以子模块的形式引入），就需要一点额外配置，让文章仓库的更新也能触发 Vercel 重新部署。

**第一步：创建 Deploy Hook。**

打开 Vercel 项目的 **Settings → Git → Deploy hooks**，在 **Name** 一栏随便输入一个名字，选择要 hook 的分支（默认 `main`），点击 **Create Hook**，会得到一个 URL。

**第二步：在文章仓库配置 Webhook。**

打开文章的远程仓库 `blogs` 的 **Settings → Webhooks → Add Webhooks**，将上面获得的 URL 填入 **Payload URL** 一栏，**Content type** 选择 `application/json`。等待添加的 hook 变为 **Last delivery was successful** 即可。

**第三步：让构建时拉取最新文章。**

回到 Vercel 项目 **Settings → General**，找到 **Build & Development Settings → Install Command**，开启 **Override**（覆盖），输入以下命令：

```bash
git submodule update --init --recursive --remote && pnpm install
```

这样每次部署时都会先拉取子模块（文章仓库）的最新内容，再安装依赖进行构建，文章更新即可自动发布。

## 5. 收尾工作

回到 Vercel 控制台，点击 **Deployments**，在最新一栏点击右侧的三个点，选择 **Redeploy** 重新部署一次，让前面的所有配置生效。

等待部署完成后，访问你的域名，确认网站、样式、图片都正常加载——至此，博客正式上线。

> [!NOTE]
> 之后的日常写作只需要推送代码 / 文章到仓库，Vercel 会自动构建发布，不再需要任何手动操作。

## 结语

整套流程下来，最花时间的其实是等待：域名实名审核、DNS 生效、构建部署，每一步都要几分钟到一个小时不等。配置本身并不复杂，理清"域名 → 解析 → 托管 → 自动化"这条链路后，以后再部署新站点就是轻车熟路了。

如果你也在搭建自己的博客，希望这篇记录能帮你少走一点弯路。

ps：上周去贵州旅游了一个星期，人挤人好累。。。（再也不旺季出去玩了。。。）