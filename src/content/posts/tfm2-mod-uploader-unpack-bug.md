---
title: 已知问题 · TFM2ModUploader「Unpack Base Bundle」解包不完整并报错
published: 2026-08-26
description: 给 Teamfight Manager 2 做 mod 的第一步就翻车：自带上传器 Unpack Base Bundle 静默漏写 180 个条目（含 berserker 等英雄精灵图、约 80 个音效），重试则报 asset path 'asset/base' has no file name。逆向 bundle.game_data 格式后定位到根目录标记条目这个确定性 bug，写工具补齐缺失文件，SHA-256 逐文件校验 2090/2090 通过。
image: ''
tags: [TFM2, Mod, 逆向, Python]
category: 开发
draft: false
lang: ''
---

# 已知问题 · TFM2ModUploader「Unpack Base Bundle」解包不完整并报错

最近准备开一个 Teamfight Manager 2（TFM2）的 mod 项目。做 mod 的第一步是把游戏的基础资源包解开当参考库——之后查英雄精灵图的标签名、音效文件名、UI 布局，全要靠它。结果游戏自带的上传器在这一步就翻车了：解包悄悄漏掉 180 个条目，重试则直接报错。这篇文章完整记录现象、排查、根因和修复，给同样在做 TFM2 mod 的人参考。

> [!IMPORTANT]
> 一句话结论：`bundle.game_data` 里有一个表示解包根目录的 `folder` 条目（路径就是 `asset/base` 本身，数据 0 字节），上传器把它转换成输出文件名时抛异常并中止整个解包流程。该条目之前（按存储顺序）的 1911 个文件已经写盘，之后的 179 个文件永远不会写出。官方修复前，不要再点 Unpack Base Bundle——它会把目录覆盖回不完整状态。

## 环境

| 项 | 值 |
|---|---|
| 游戏 | Teamfight Manager 2（Steam 打包版） |
| appid / buildid | 3009300 / 24830185（2026-08-26 更新） |
| 游戏目录 | `D:\steam\steamapps\common\Teamfight Manager2` |
| 问题组件 | `TFM2ModUploader.exe`（游戏自带上传器）、`bundle.game_data` |
| 状态 | 本地已修复（2090/2090 文件逐字节哈希校验通过）；官方工具未修复 |

## 1. 问题现象

点击 Unpack Base Bundle 后出现两种表现：

**静默不完整**：界面看似正常结束，但 `mods/base_unpacked/` 里只有 1911 个文件，而 bundle 实际含 2091 个条目——180 个条目没有被写出，且毫无报错提示。

**显式报错**（重试时）：

```text
Unpacking base bundle...
Unpack failed: Could not unpack bundle.game_data: asset path 'asset/base' has no file name
```

危害不只是「少几个文件」：不完整的参考库会误导开发——查英雄精灵图标签、音效名、UI 布局时会得出「游戏里不存在」的错误结论。本次缺失内容包括 berserker / priest / pyromancer 等英雄精灵图、约 80 个音效文件、整份 `other_setting`。如果没发现，几乎每个依赖资源查证的 mod 决策都会被带偏。

## 2. 排查过程

排查思路是分三层收敛：先验证磁盘上已解出的文件有没有写坏 → 再验证 bundle 源头有没有缺内容 → 最后逆向格式逐条目对照，把「缺 180 个」收敛成一个具体的截断点。

### 2.1 表层校验：全部正常

先怀疑解包器写坏了文件，结果是清白的：

- 目录布局符合约定（`text/ui.i18n` 等命名正确）
- 9 个 `.i18n` 与 50 个 `.sprite_sheet` 均为合法 JSON
- 332 个 PNG 文件头全部有效
- 无异常空文件（`.folder` 是 0 字节目录标记，属正常设计）

已写出的文件没有问题，排除「写坏」。

### 2.2 精灵图配对：暴露缺口

按命名约定检查配对关系（`X#data.sprite_sheet` ↔ `X#sheet.png`、`X#anim.fanim` ↔ `X#sheet.png`），发现 7 组孤立文件——比如 `inbox_list_buttons#data.sprite_sheet` 有 JSON 却没有对应的 PNG。孤立的「配偶」说明缺失不是随机的，而是一整段没有落地。

### 2.3 回到源头验证 bundle

直接在 `bundle.game_data` 二进制里搜索这些文件名，确认「缺失」的文件在 bundle 里都存在——不是游戏打包时就没给，而是解包器漏写。

### 2.4 逆向格式，逐条目对照磁盘

按下文 §4 的格式完整解析出 2091 个条目，恰好占满全部 1,128,948,688 字节，且 2091 个路径无重复——bundle 本身完好。顺带一提，「解析是否恰好耗尽整个文件」本身就是免费的 bundle 完整性自检。

再按 bundle 的存储顺序逐条对照磁盘：前 1911 个条目全部存在，之后 180 个全部缺失，截断点非常干净（offset 975,328,878，约 86.4% 处）。第 1912 个条目正是 `('folder', 'asset/base')`——与上传器报错信息 `asset path 'asset/base' has no file name` 完全吻合。

## 3. 根因

一句话：bundle 里有个「根目录标记」条目，上传器不认识它。

`bundle.game_data` 用一个类型为 `folder`、路径为 `asset/base`、数据 0 字节的条目来标记解包根目录。上传器把 `asset/base/<相对路径>` 转换成输出文件名，而这个条目的相对路径为空，于是抛出异常并中止整个解包流程：

- 存储顺序在该条目之前的 1911 个条目已写盘——所以「看起来解了大部分」；
- 之后的 179 个条目加上坏条目本身，共 180 个永远不会写出；
- 每次重试都死在同一位置，属上传器确定性 bug，与操作、磁盘空间无关。

## 4. bundle.game_data 格式（逆向结论）

既然都逆了，格式记下来。自定义二进制格式，全部小端，条目背靠背排列：

```text
u32  entry_count                          # 本次为 2091
entry_count × [
    u32 type_len,  bytes[type_len]        # 类型：png/mp3/ui/folder/sprite_sheet/...
    u32 path_len,  bytes[path_len]        # 路径：asset/base/ui/inbox/inbox_list_buttons#data
    u32 data_len,  bytes[data_len]        # 数据
]
```

路径映射规则：`asset/base/<rel>` → `mods/base_unpacked/<rel>.<type>`。该规则对前 1911 个条目 100% 验证成立，包括这些后缀转换：

| bundle 内路径片段 | 磁盘文件 |
|---|---|
| `...#data` | `...#data.sprite_sheet` |
| `...#sheet` | `...#sheet.png` |
| `...#anim` | `...#anim.fanim` |
| `folder` 类型条目 | `<rel>.folder` 标记 |

唯一的例外就是根条目 `asset/base`——它没有 `<rel>`，上传器死于此条。

## 5. 解决方法

写了个小工具直接解析 bundle 做补齐/校验（跳过根标记条目），放在 mod 项目的 `tools/` 下：

```bash
# 校验 base_unpacked 与 bundle 的一致性（SHA-256 逐文件比对）
python tools/base_bundle_tool.py check

# 补齐缺失文件
python tools/base_bundle_tool.py repair
```

`--game-dir` 可覆盖默认游戏目录。

本次修复结果：`check` 输出 `entries=2091 files=2090 missing=0 mismatched=0`。2090 = 2091 条目 − 1 个根标记——根标记在磁盘上没有对应物，跳过是正确行为。

## 6. 后续注意事项

1. **官方修复前不要重复点击 Unpack Base Bundle**：它会在同一位置再次报错，并把 `base_unpacked/` 覆盖回 1911 个文件的不完整状态；若误点，重跑 `repair` 即可恢复。
2. **游戏更新后可重试官方解包**：若成功且 `check` 通过，说明官方已修复，本记录可标记过期；若仍报同样的错误，继续用本工具。
3. **可向开发者反馈该 bug**：错误信息即 `asset path 'asset/base' has no file name`，由 bundle 内 `asset/base` 根 folder 条目触发——这句报错加上本文的定位，足够官方直接修。

## 结语

这次排障最有价值的一步是「逐条目对照磁盘」：它把「缺了 180 个文件」从一个统计事实，收敛成「第 1912 条起全缺、截断点正好是报错信息里那个条目」——根因自己浮了出来。这类「静默不完整」的问题最坑的地方就在于不报错，所以给解包流程配一个可重复执行的完整性校验（本文的 `check`），比记住任何个案都可靠。
