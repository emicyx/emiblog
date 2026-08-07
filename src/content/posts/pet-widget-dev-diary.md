---
title: 前端小宠物 pet-widget 开发日记
published: 2026-08-07
description: 给博客加上一个会眨眼、会打盹、还能被拎起来晃悠的小宠物。纯 CSS + 原生 JS 实现，记录从零开发到接入 Astro 博客的全过程。
tags: [开发, 前端, JavaScript, Astro]
category: 开发
draft: false
---

# 前端小宠物 pet-widget 开发日记

这两天给博客写了一个会动的"电子宠物"，就是你现在看到右下角那个小家伙——它会随机眨眼、发呆久了会坐下打盹、鼠标还能把它拎起来晃悠。这篇日记记录一下整个开发过程和踩过的坑。

## 起因

博客搭好之后总觉得页面上少了点"活物"。Fuwari 主题本身已经很完整了，但再精致的静态页面也少一点互动感。于是决定塞一个吉祥物进去，要求也很简单：

- 不用引框架，纯 CSS + 原生 JS，方便以后迁移
- 不挡页面操作（把宠物放角落，别碍事）
- 有几个小动作：眨眼、打盹、能被拖动

## 整体设计

### 四种状态

宠物本质上是一个**有限状态机**，四个状态来回切换：

| 状态 | 触发 | 表现 |
|---|---|---|
| `standing` 站立 | 默认 / 拖动放下 / 睡醒 | 上下漂浮 + 随机眨眼 |
| `sitting` 坐下 | 无操作超过 `idleTime`（默认 30s） | 轻轻摇晃 + 飘音符 |
| `lifted` 拎起 | 鼠标按住拖动 | 悬空左右摆动 |
| `dropping` 落下 | 松手 | 掉落回弹动画后回站立 |

所有状态都挂在 `body` 的 class 上，动画交给 CSS，JS 只负责"什么时候切换状态"。

### 图片资源

每张图都是 **2048×2048 的透明背景 PNG**，一个状态一张：

```
assets/
  standing.png   # 站姿
  blink.png      # 眨眼瞬间（闭眼）
  sitting.png    # 坐姿
  lifted.png     # 被拎起
```

图很大（单张 2~5MB），所以做了**预加载 + 失败兜底**：启动时用 `Promise.all` 把所有图先拉一遍，`onerror` 也 resolve（返回 `ok:false`），加载失败的图就跳过，不阻塞初始化。

### 动画全用 CSS

写轮播级粒子动画太奢侈，这种小宠物用 CSS keyframes 就够，还省 JS 主线程。核心几个：

- `petFloat`：站立时上下漂浮 + 轻微左右摇摆 + 弹性缩放
- `petShake`：坐下时的摇头晃脑
- `petDrop`：松手后的落地回弹（下坠 → 弹起 → 落定）
- `petSquash`：眨眼时身体压扁一下
- `petDangle`：被拎起时以头顶为轴心左右摆动
- `petNote`：坐下时头顶飘出的小音符

外加一个 `drop-shadow` 投影，宠物就"站"在页面上了。

## 几个关键实现

### 空闲坐下

```js
function resetIdle() {
  clearTimeout(idleTimer);
  if (state !== 'standing') return;
  idleTimer = setTimeout(function () {
    if (state === 'standing' && !document.hidden) enterSitting();
  }, cfg.idleTime);
}
```

每次有交互（睡醒、放下、鼠标靠近）都会重置这个计时器。**标签页切到后台时不触发坐下**，回到前台再重新计时——不然宠物在你看不见的时候偷懒就很出戏。

### 随机眨眼

```js
var delay = cfg.blinkMin + Math.random() * (cfg.blinkMax - cfg.blinkMin);
blinkTimer = setTimeout(blinkNow, delay);
```

间隔在 2.5s~6.5s 之间随机，避免像秒表一样机械。眨眼瞬间换 `blink.png`，150ms 后换回站姿；如果眨眼图没加载成功，就降级用 CSS 的 `petSquash` 压扁一下，体验也不至于断档。

### 拖动

拖动这块踩了点坑：

1. **平滑跟随**：不直接把元素钉在鼠标上，而是用 `requestAnimationFrame` 每帧朝目标位置插值 `+= (target - cur) * 0.32`，拖起来有"重力跟随"的黏滞感，而不是生硬地瞬移。
2. **惯性摇摆**：记录横向速度，拖动时让身体向运动方向倾斜，停下来还能回弹，手感立刻不一样。
3. **指针捕获**：用 `stage.setPointerCapture()`，防止拖太快时指针跑到元素外面导致 `pointerup` 丢失、宠物卡在"拎起"状态。
4. **边界钳制**：坐标 clamp 在可视区内，不会被甩到屏幕外。

### 图片切换的淡入淡出

直接换 `src` 会"啪"地一下变脸，很生硬。写了个 `swapImg(src, fade)`：先置 `opacity:0`，180ms 后再换图并淡入，过渡就自然了。

## 接入 Astro 博客（Fuwari 主题）

### 1. 静态资源放进 public

把 `pet-widget/` 整个目录拷到 `public/` 下，这样 Astro 会原样发布为 `/pet-widget/...`：

```
public/pet-widget/
  pet-widget.css
  pet-widget.js
  assets/*.png
```

### 2. 全站布局挂载

在 `src/layouts/Layout.astro` 的 `</body>` 前加入挂载点、样式和脚本：

```html
<div id="pet-widget"></div>
<link rel="stylesheet" href="/pet-widget/pet-widget.css" is:inline />
<script is:inline>
  window.PetWidgetConfig = {
    size: 200,
    idleTime: 5000,   // 测试用 5s，正式改回 30000
    dock: 'bottom-right',
    assets: {
      standing: '/pet-widget/assets/standing.png',
      blink:    '/pet-widget/assets/blink.png',
      sitting:  '/pet-widget/assets/sitting.png',
      lifted:   '/pet-widget/assets/lifted.png'
    }
  };
</script>
<script src="/pet-widget/pet-widget.js" is:inline defer></script>
```

### 3. `is:inline` 是关键

Astro 默认会把 `<script>` 收集起来打包，插件 `is:inline` 后脚本会**原样输出、不被 Astro 处理**。这很重要，因为：

- 配置脚本要在宠物 JS 之前执行，一旦被 Astro 重新排序就可能读到空配置
- 宠物脚本用的是全局状态，不需要被打包成模块

另外挂载点放在 body 里、**Swup 的容器之外**，页面切换时宠物不会被重新初始化、也不会有动画重放的闪断。

## 调试技巧

空闲 30s 太久，等起来很难受。做了两件事加速验证：

1. 支持 **URL 参数覆盖配置**：`?idle=5000` `?size=160` `?offsetx=100` 直接在地址栏改，不用改代码
2. 暴露 `window.__petWidget` API：控制台直接调 `__petWidget.sit()` / `wake()` / `blink()` 手动触发状态

## 可配置项一览

| 配置 | 默认 | 说明 |
|---|---|---|
| `dock` | `bottom-right` | 停靠位置：四角任意 |
| `size` | `220` | 宠物边长 px |
| `idleTime` | `30000` | 无操作多久后坐下 |
| `blinkMin/Max` | `2500/6500` | 眨眼随机间隔 |
| `returnToDock` | `false` | 拖放后是否飞回原位 |
| `hideOnMobile` | `false` | 小屏（<640px）隐藏 |
| `respectReducedMotion` | `true` | 尊重系统"减少动效"设置 |
| `humAudio` | `''` | 可选哼歌声效 URL |

## 还没做完的 TODO

- [ ] 眨眼 + 下蹲的组合动作
- [ ] `sitting-closed.png`：坐下后偶尔闭眼
- [ ] `standing.png` 换成更精美的正式立绘
- [ ] 更多可交互动作（点击摸摸头？）

总之，一个能陪你在写博客时发呆的电子宠物就上线了。如果你也在用 Fuwari/Astro，直接按上面的三步就能把它搬进自己的博客。
