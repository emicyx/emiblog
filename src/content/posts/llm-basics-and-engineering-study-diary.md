---
title: LLM 基础与 AI 系统工程化学习笔记：是什么、为什么、怎么做
published: 2026-09-11
description: LLM 基础与 AI 系统工程化学习笔记：上半篇讲清模型本身——Transformer 架构组件的设计动机、KV Cache 与显存公式、解码参数的作用位置与场景化调优、SFT/RLHF/DPO 三阶段的分工与选型路线；下半篇讲清落地工程——推理加速的两阶段瓶颈诊断与手段分类、高并发下 Token 限流与成本控制、可观测性三大支柱、数据安全与隐私合规的纵深防御，每个主题都按「是什么 → 为什么 → 怎么做」展开。
image: ''
tags: [AI, LLM, 学习笔记, 工程化]
category: 开发
draft: false
lang: ''
---

# LLM 基础与 AI 系统工程化学习笔记：是什么、为什么、怎么做

> 记录日期：2026-09-11
> 学习方式：围绕七个高频问题（Transformer 架构、解码参数调优、SFT 与 RLHF/DPO、推理加速、Token 限流与成本控制、可观测性、安全与合规）调研了一批文章，按「LLM 基础 → AI 系统工程与部署」两个模块重新组织，每个主题沿「是什么 → 为什么 → 怎么做」展开，剥离具体项目细节，只保留可迁移的通用方法论。

把 LLM 相关的知识切成两个模块，分界线是"模型本身"和"让模型跑起来"。这不是两块并列的知识，而是一条因果链：**架构决定了资源画像**（权重固定、KV Cache 随上下文和并发线性增长），**资源画像决定了推理优化的方向**，**推理的成本结构决定了限流与成本控制的策略**，而这一切都要靠可观测性闭环、靠安全合规兜底。上半篇回答"这是个什么东西、为什么这样设计、怎么用好它的参数和训练方法"，下半篇回答"怎么让它便宜、稳定、安全地服务真实流量"。

## 一、LLM 基础：先看清机器本身

### 1.1 Transformer：组件不复杂，关键在为什么这么设计

Transformer 的组件清单其实不长：词嵌入与位置编码、多头自注意力（MHA）、前馈网络（FFN）、残差连接与归一化层，就这四样堆 N 层。原始论文是 Encoder-Decoder 结构（T5、BART 一脉），但今天的主流大模型几乎清一色是 **Decoder-only**（GPT、LLaMA、Qwen、DeepSeek）——结构简洁、训练效率高、扩展性好。Encoder-only（BERT 一脉）靠双向注意力做理解类任务，Encoder-Decoder 靠交叉注意力做翻译摘要这类序列到序列任务，三者各有所长，只是生成式浪潮选中了 Decoder-only。

真正值得记的是每个组件**为什么长这样**：

- **自注意力**是全局信息交换机制，核心就一行公式：`Attention(Q,K,V) = softmax(QK^T / √d_k) · V`。直觉上，Query 是"我想找什么"，Key 是"我是什么"（用来被匹配），Value 是"实际传递的信息"——**匹配（Q·K）与传值（V）是解耦的**。缩放因子 `√d_k` 防止点积过大把 softmax 推进饱和区导致梯度消失；多头机制让不同头自发分工（有的盯语法、有的盯语义、有的盯位置），代价是序列长度上的 **O(n²) 复杂度**，这是长文本一切瓶颈的源头。
- **位置编码**存在的原因只有一个：自注意力本身对位置不敏感（打乱输入顺序，注意力输出不变），必须额外注入位置信息。老方案是正弦编码与词嵌入相加，现代主流是 **RoPE（旋转位置编码）**——把向量拆成若干二维子空间各自旋转，数学上保证 Q·K 的结果只依赖相对距离，所以叫"相对位置编码"。一个常被问的细节：RoPE 只作用于 Q 和 K，不作用于 V，因为位置决定的是"哪些位置互相关注"（匹配环节），而不是"提取什么信息"（传值环节）。长上下文模型靠外推技术（NTK-aware 缩放、YaRN，或直接调大 base）把窗口撑到几十万 token。
- **FFN** 是参数量大头，占整个模型约三分之二，承担知识存储。现代模型普遍用 **SwiGLU**（门控激活）替换原始的两层 ReLU，三个权重矩阵，门控分支控制信息通过，LLaMA、Qwen、GLM 都是这一脉。
- **残差连接 + 归一化**决定深网络能不能训得动。原始 Transformer 是 Post-LN（先子层后归一化），深层训练不稳；GPT-2 起改 Pre-LN（先归一化再进子层），残差主干"干净"、训练稳定；LLaMA 起再简化为 **RMSNorm**（去掉均值中心化，只做均方根缩放），更快。现代主流组合就是 Pre-LN + RMSNorm。

对工程来说，这一节真正要带走的是 **KV Cache** 和两个显存公式。自回归生成时，历史 token 的 K、V 矩阵算一次就不再变，缓存起来避免每步重算，每步只追加新 token 的 K'/V'——这就是 KV Cache；Q 不需要缓存，因为只有当前 token 的 Q 参与当步计算。由此：

1. **权重显存 ≈ 参数量 × 每参数字节数**：FP16/BF16 每参数 2 字节，7B 模型约 14 GB，INT8 减半、INT4 再减半。
2. **KV Cache 显存 ≈ 2 × 精度字节数 × 层数 × 隐藏维度 × 序列长度 × 并发数**（2 是 K 和 V 各一份）。一个有说服力的实例：OPT-30B（bf16、48 层、7168 维）在 1024 上下文、batch=128 时，KV Cache 约 180 GB，而权重只有 60 GB——**缓存是权重的三倍**。

这两条公式是下半篇所有工程决策的出发点：量化省的是权重，PagedAttention 省的是缓存，并发上限卡的是缓存，长上下文贵也是贵在缓存。

### 1.2 解码参数：同一模型的性格旋钮

先定位作用环节：这些参数全部作用于**解码阶段每一步的 logits → 概率分布 → 采样**流水线上。模型前向输出整个词表的 logits 后，先做各类处理（重复惩罚改 logits、Top-K/Top-P 截断候选集、温度缩放分布），再 softmax 归一化，最后采样出下一个 token。理解了这条流水线，参数就不是孤立的知识点，而是流水线上的不同工位。按工位分三类：

| 类别 | 参数 | 作用 |
| --- | --- | --- |
| 分布整形 | temperature、top_k、top_p | 控制输出的随机程度 |
| 重复惩罚 | repetition_penalty、frequency_penalty、presence_penalty | 抑制复读机行为 |
| 硬约束 | max_tokens、no_repeat_ngram_size、停用词 | 直接裁剪输出 |

**Temperature 的数学含义**是 softmax 前把 logits 除以 T：T<1 锐化分布（高概率 token 更占优），T>1 平滑分布，T=1 保持原分布，T→0 退化为贪心（每步取 argmax）。所以要破除一个常见误解：**温度不是"创造力旋钮"**。有论文实测温度超过 1.0 后文本连贯性快速下降（约 1.6 时多选准确率归零），LLaMA-2 的实验也表明输出新颖性与温度只是弱相关、与连贯性负相关。真正该问的不是"多高更有创意"，而是"这个任务能容忍多大的随机性"。

**Top-K 与 Top-P 的区别**在于候选集怎么定：Top-K 固定取概率前 K 个，分布很尖时可能混进噪声 token，分布很平时又可能截掉好候选；Top-P（核采样）取累积概率达到 p 的最小集合，**候选集大小随分布形状自适应**——分布集中时可能只剩一两个，分布分散时可能保留几十个。这是 Top-P 更常用的原因。**三种惩罚的区别**：repetition_penalty（HuggingFace 侧，出自 CTRL 论文）对已出现 token 的 logits 做乘性惩罚，1.0 即无惩罚，LLaMA 系生成任务常用 1.1~1.2（社区经验值）；frequency_penalty（OpenAI 侧）按出现**次数**做加性惩罚，管"重复得太频繁"；presence_penalty 只看**是否出现过**（一次性），管"该换话题了"。

**怎么调**——先给场景经验表，再给三条纪律：

| 场景 | temperature | top_p | 说明 |
| --- | --- | --- | --- |
| 代码、SQL、JSON 抽取、数学、RAG 事实问答 | 0 ~ 0.2 | 1.0 | 越低越可复现，格式越稳 |
| 日常对话、摘要、翻译 | 0.5 ~ 0.7 | 0.9 | 平衡自然与稳定 |
| 创意写作、头脑风暴、文案 | 0.8 ~ 1.2 | 0.95 | 接受随机性换多样性 |
| Agent / 工具调用 | 低温或 0 | 默认 | 输出格式与决策链路要可复现（社区共识） |

三条纪律：其一，**参数会互相打架**——T=0 时输出完全确定，Top-P 截断不再影响选词，此时应把 top_p 设回 1.0；高温配低 top_p（如 1.2 + 0.5）的结果不可预测。其二，**OpenAI 官方明确建议 temperature 与 top_p 二选一调整**，不要同时动。其三，实践顺序是先只调 temperature、top_p 保持 0.9~1.0、top_k 不设。另外各家模型有官方推荐值可以直接抄：DeepSeek-V3 建议 0.3，DeepSeek-R1 建议 0.6，Qwen3 思考模式 0.6 / 非思考 0.7（top_p 0.95/0.8、top_k 20）——**调参之前先看模型卡**，不同模型的"出厂性格"不同。

### 1.3 SFT 与 RLHF/DPO：从"会续写"到"对齐"

先立总纲，一句话框架：**预训练让模型会续写，SFT 让模型学会按指令回答，RLHF/DPO 让模型更符合人类或业务偏好**。三个阶段解决的是三个层次的问题，不是谁替代谁。

**SFT（监督微调）**本质和预训练一样是下一 token 预测，区别只在数据与损失掩码：数据换成高质量"指令-回答"对，损失只对回答部分计算（指令部分 mask 掉），模型学的不是新知识而是新的行为模式。它擅长的是**输出格式固定**的任务——JSON 结构化输出、工单分类、工具调用格式，也适合用小模型蒸馏大模型能力；它不擅长注入动态知识（价格、库存这类随时间变化的事实，该走 RAG）。SFT 最大的风险不是方法，是数据：脏数据不是资产，是污染源。

**RLHF** 要解决的问题是 SFT 教不了的："两个都对，哪个更好"这种**偏好信号**。完整链路六步：SFT 模型对同一 prompt 生成多个候选 → 人工标注优劣排序 → 训练奖励模型 RM → PPO 强化学习优化策略 → 评测防训歪。两个"为什么"是理解的关键：为什么需要 RM？因为人类没法对每条生成序列直接打出可微的连续分数，RM 的作用就是把"A 优于 B"这种离散比较学成一个可微的标量打分器，供 PPO 当 reward 用。为什么还需要一个冻结的 Reference Model 加 KL 约束？防止策略为刷高分训歪（reward hacking）——比如 RM 偏爱长答案，模型就学会堆废话。代价是 PPO 阶段**四个模型同时在线**：Actor、Critic 在训练，RM、Reference 冻结但仍占显存，总开销约为 SFT 的数倍，而且超参敏感、训练不稳定。

**DPO（Direct Preference Optimization）**的核心洞察一句话：**语言模型本身就是隐式奖励模型**。它通过数学变换把奖励重参数化为"策略与参考策略的对数比"，使最优策略可闭式求解，从而把 RLHF 的"RM + PPO"两步绕开，直接在偏好对（chosen / rejected）上算一个类似二元交叉熵的分类损失。论文实验里，摘要任务温度 0 下 DPO 胜率约 61%，超过 PPO 最佳的 57%，而且对采样温度更鲁棒。两者对比：

| 维度 | RLHF（PPO） | DPO |
| --- | --- | --- |
| 流程 | RM 训练 + PPO，两阶段 | 单阶段，直接在偏好对上优化 |
| 模型开销 | 4 个模型在线 | 2 个（策略 + 冻结参考），无采样循环 |
| 稳定性 | 不稳定、超参敏感 | 稳定、轻量、易复现 |
| 上限 | 在线 RL 上限更高，可利用环境反馈 | 受限于离线偏好对质量 |
| 适用 | 资源充足、有可验证 reward 的场景 | 有稳定偏好数据、追求性价比的团队 |

**怎么选型**——一条务实的递进路线：先 Prompt/RAG 解决 → 不够再 SFT → 有稳定偏好数据后 DPO → "任务大、反馈强、收益明确"才上完整 RLHF。判据是"**reward 是否清楚**"：单元测试通过、数学答案正确、任务完成率这类可验证信号清楚时，强化学习才有抓手；只有模糊的"人觉得哪个好"，先用 DPO 把成本降下来。数据格式的区别也对应工具链的区别：SFT 用 instruction-response，DPO 用同一 prompt 的 chosen-rejected 偏好对，RLHF 用人工对多候选的排序。顺带一个延伸：Agent 多步执行场景下静态偏好对不够用，需要环境反馈与轨迹级评估，DeepSeek-R1 用的 GRPO 就是这个方向的新答案。

## 二、AI 系统工程与部署：让模型便宜、稳定、安全地跑起来

### 2.1 推理加速：先诊断瓶颈，再选手段

推理加速最容易被当成"背方案清单"，正确的姿势是先理解**瓶颈在哪**。LLM 推理是自回归的，一个请求的生命周期分两阶段，资源画像完全相反：

- **Prefill（预填充）**：一次性并行处理整个输入，算出首个输出 token。计算密集型（O(n²) 注意力），决定 **TTFT**（首 token 延迟）。
- **Decode（解码）**：逐 token 串行生成，每步读全部 KV Cache 只算一个 token。**访存密集型**（卡在显存带宽上），决定 **TPOT**（每 token 耗时）。总延迟 ≈ TTFT + TPOT × 输出长度。

两阶段画像相反，这就是**为什么没有银弹**——所有手段都在分别回应"算力不够""带宽不够""显存不够"三个不同瓶颈。手段全景分两大类：

**模型侧压缩**省的是显存和计算量：量化（GPTQ 按列迭代最小化重构误差、AWQ 保护那约 1% 的关键通道，都是无需重训练的后训练量化）、剪枝（移除冗余权重）、蒸馏（大模型教原生小模型，训练贵但部署收益稳）。**系统侧优化**省的是浪费：PagedAttention（vLLM）借鉴操作系统虚拟内存分页管理 KV Cache，论文数据是传统系统显存浪费 60%~80%，分页后降到 4% 以下；Continuous Batching 把"等整批完成"改成迭代级调度，完成的立刻移出、排队的即时插入，提吞吐不改单请求延迟；FlashAttention 靠分块计算减少显存读写，加速 Prefill；投机解码让小模型先猜、大模型一次并行验证，理论上不改变输出分布（无损）但**降低单请求延迟**；Prefix Caching 缓存系统提示等公共前缀的 KV，新请求跳过 Prefill 直接降 TTFT。再往上是**PD 分离**：Prefill 和 Decode 部署到不同 GPU 池（因为合并部署时大批 Prefill 会阻塞正在 Decode 的请求，同时恶化 TTFT 和 TPOT），代价是跨节点传 KV Cache，DistServe、Mooncake（Kimi 的生产系统）是代表。

每类手段的收益来源不同，选型时按这张表对号入座：

| 手段 | 省显存 | 提吞吐 | 降延迟 |
| --- | --- | --- | --- |
| 量化（权重 / KV Cache） | 强 | 中 | 中 |
| 剪枝 / 蒸馏 | 强 | 强 | 中 |
| PagedAttention | 强（去碎片） | 强（并发上去） | 弱 |
| Continuous Batching | — | 强 | — |
| FlashAttention | 中 | 强（Prefill） | 中 |
| 投机解码 | 负（更费） | 弱 | 强 |
| Prefix Caching | — | 中 | 强（TTFT） |
| PD 分离 | — | 强 | 强（TTFT + TPOT 双优） |

**落地路径**：从 vLLM 起步（PagedAttention + Continuous Batching，生态最全、新模型支持最快，论文口径下比原生 Transformers 吞吐高一个数量级，具体倍数依 benchmark 条件而定）；Agent、多轮对话这类前缀复用密集的场景评估 SGLang（RadixAttention 前缀缓存）；单一固定模型 + NVIDIA 新硬件 + 极致 SLA 时评估 TensorRT-LLM（换模型要重编 engine，灵活性换性能）；Ollama 面向本地个人场景，不是服务端方案。量化从 AWQ/GPTQ 的 W4A16 起步（对推理引擎兼容最好），对齐困难再考虑 W8A8 + SmoothQuant。别忘了开 vLLM 的 prefix caching 和 chunked prefill，多轮对话场景收益显著。

### 2.2 Token 限流与成本控制：LLM 服务的经济学

**为什么不能照搬传统 QPS 限流**？三个原因：请求长度差异巨大（几十 token 和几万 token 是完全不同的负载），所以计量单位是 **token 不是请求**，要用 TPM 而不只 RPM；并发上限受 **KV Cache 显存**约束而非 CPU 或连接数（呼应 1.1 的公式——每个活跃请求按其上下文长度持续占显存）；Decode 是串行长占用，一个请求占用资源的时间是整个生成过程，传统"请求进来-处理-返回"的短时占用假设失效。所以 LLM 服务的限流是**三维矩阵**：RPM（防请求过载）+ TPM（防配额耗尽）+ 并发会话数（防 KV Cache 撑爆显存），三者缺一不可。云厂商的实践也是如此，比如阿里云百炼实际是分钟级配额、瞬时频率、增速限制三层叠加。

**高并发下的排队与背压**，一套可落地的组合：服务端排队（请求带等待超时，适合突发限流，客户端同步放大超时）→ 客户端指数退避重试（1s/2s/4s，上限约 60s，重试五六次）→ 本地流控注意**先拿 RPM 令牌再拿并发信号量**（顺序反了会队头阻塞），TPM 用双令牌桶、**输入 token 预扣、输出事后结算** → 触发 429 时模型降级（大模型降级到更廉价的 flash 档）→ 异步任务用 MQ 削峰填谷 + 死信队列 + 背压传递。多实例部署时限流计数器要放 Redis 保证原子性。

**成本控制**按投入产出比排三板斧：**Prefix Caching**（改动最小，Anthropic 官方数据：长提示词场景延迟最高降 85%，缓存读取价格约为新输入的十分之一）→ **模型分级路由**（收益最大：简单任务路由小模型、复杂任务升级大模型，可加级联置信度判断，RouteLLM 论文口径成本节省最高 85%，具体依实验条件）→ **Prompt 瘦身**（长期习惯：删重复上下文、压缩历史对话、截断检索结果——输入 token 是多数场景的主要计费项）。再叠加输出长度控制（max_tokens、结构化输出约束、避免无意义重试循环）、Batch API（异步批处理不受在线限流约束且单价更低）、以及**治理层的配额体系**：网关层按用户/租户设日/月 token 配额 + 超额熔断（APISIX、Kong AI Gateway、LiteLLM 都支持），配额和成本看板放网关而不是散在业务代码里。

### 2.3 可观测性：非确定性系统只能靠观测闭环

**为什么传统 APM 不够**：LLM 应用的调用链是树状且非确定的——一次用户请求背后是检索、工具调用、多次 LLM 调用的嵌套组合；**Prompt 和上下文本身就是变量**，同样代码不同 prompt 效果完全不同，不记录输入输出就无法定位问题；传统 APM 也没有 token 用量、成本、输出质量这些观测维度。调试方式从"翻日志"变成"看 trace 树"。

可观测性三大支柱：

1. **Tracing（链路追踪）**：trace 是一棵树，根节点是用户输入，子节点是检索调用、工具执行、每次 LLM 调用等 span，每个节点记录完整输入输出、token 数、延迟、成本；跨多轮对话用 session 串联。Prompt 作为带版本的受管对象，改了哪个版本要能在 trace 上对上账。
2. **Metrics（指标）**：token 用量与成本（按模型/用户/会话拆分）、延迟拆成 **TTFT**（首 token 延迟，流式场景决定"有没有反应"）与 **TPOT**（决定"读得顺不顺"）、错误率、缓存命中率。
3. **Evaluation（在线评测）**：三层打分来源——LLM-as-judge 自动质检、代码规则断言、用户反馈（显式的点赞点踩，隐式的重试、编辑、停留时长）+ A/B 测试。这是观测和评测两个领域的交汇点：线上差评的 trace 可以直接沉淀为评测集，反过来驱动 prompt 和模型的迭代（数据飞轮）。

**每次 LLM 调用至少记录**：prompt（含 system prompt）、completion、模型名称与版本、调用参数（temperature、max_tokens）、输入输出 token 数与成本、延迟（TTFT/TPOT）、trace_id / session_id / 用户标识、prompt 版本号，可选再记检索到的上下文与工具返回——记录这些时注意脱敏，直接衔接下一节。

**落地顺序**：先 tracing（看清链路）→ 再 metrics（建立成本与延迟看板）→ 最后 evaluation（用户反馈 + LLM-as-judge 闭环）。工具选型：Langfuse（MIT 开核、可自托管、OTel 原生）与 LangSmith（LangChain 官方、闭源 SaaS 为主、与 LangGraph 集成最深）是两大主流平台；标准化方向是 **OpenTelemetry GenAI 语义约定**（正在定义 chat / tool / agent 各类 span 的统一字段）和 OpenLLMetry。一个值得坚持的工程习惯：**埋点写成厂商无关的**（直接对接 OTel 端点导出），避免被单一平台锁定。

### 2.4 数据安全与隐私合规：纵深防御

先看风险面在哪。最本质的一条：**LLM 的指令和数据走同一个通道**——prompt 里既有你的指令也有你的业务数据，这与 SQL 注入同源，是提示注入（OWASP《LLM 应用 Top 10》2025 版的第 1 号风险）绕不开的根因；RAG 和 Agent 场景还新增了**间接注入**攻击面（被污染的检索内容、工具返回值里携带恶意指令）。其次是**数据外泄**：敏感数据进了 prompt 就离开了内网，发给第三方模型 API，传统 WAF/DLP 覆盖不到这条通路。再往外是训练侧的数据污染、被第三方 API 拿去训练的风险，以及输出侧的合规（国内还要求 AI 生成内容带显式与隐式标识）。

**防护怎么做**——核心原则是纵深防御：任何单层失效不导致整体失守。分三层：

- **网关层**：统一安全网关做 API 限流（防滥用）、输入侧 PII 识别与脱敏（NER/正则识别 → 掩码或假名化，敏感字段强制脱敏后才放行进 prompt）、输出侧内容合规检测、审计留痕。
- **应用层**：RBAC 与细粒度授权（Agent 的工具调用按用户身份收敛权限，防间接注入提权）、提示注入检测（攻击样本集 + 检测模型）、会话隔离。**关键认知：注入防御不能只靠 prompt 里写"请忽略恶意指令"**，要叠加检测模型 + 工具权限最小化 + 输出过滤。
- **模型层**：安全对齐与护栏、输出二次审核、链路加密、环境隔离、操作可审计。

两条选型决策：**私有化部署 vs API 调用**的数据边界完全不同——私有化是数据不出内网、自控审计，但安全测试与合规责任自担；API 的边界在服务商合同，用之前核对三条：训练用途条款、数据保留期限、是否支持零保留模式。数据敏感性、成本、时延、运维能力放一起做决策矩阵。**合规框架**上，国内《生成式人工智能服务管理暂行办法》（2023 年 8 月施行）是根本法规：训练数据合法来源、涉个人信息需同意、面向公众的服务要做安全评估与备案；"双备案"要预留周期——算法备案在服务上线 10 个工作日内提交、周期约 2~3 个月，大模型备案周期约 6~8 个月，**面向公众的服务要把备案排期纳入上线计划**。欧盟侧 GDPR 管个人数据与跨境传输，AI Act 按风险分级对通用模型提供商施加训练数据透明等义务——把欧盟用户数据传回国内做模型迭代，可能同时踩中两部法规。

落地的默认动作总结成四条：数据最小化进 prompt（先分类分级，敏感字段网关强制脱敏）；注入防御靠架构不靠 prompt 模板；用第三方 API 前核对训练用途与保留期条款；备案周期提前排进项目计划。

## 三、一条主线收束

回头看，两个模块其实只围着两个概念转：**token** 和 **KV Cache**。Token 是计量单位——解码参数在控制它的生成方式，成本按它计费，限流按它配额，可观测性按它记账；KV Cache 是资源单位——架构决定它线性增长，推理优化在省它，并发上限卡在它，长上下文贵也是贵在它。把 1.1 的两个显存公式真正吃透，下半篇的每一个工程决策就都不再是孤立的知识点，而是同一组约束在不同层面的展开。

这也是"是什么、为什么、怎么做"这条主线的意义：是什么，是认清模型与系统能力边界的物理事实；为什么，是每个设计都在回应一个具体矛盾（排列不变所以要位置编码、偏好不可微所以要 RM、Decode 访存受限所以量化有效）；怎么做，是按瓶颈和投入产出比排序的工程决策，而不是方案清单的堆砌。

## 四、自测清单

- Transformer 三种架构形态各自的代表模型和擅长任务？为什么主流 LLM 选 Decoder-only？
- 自注意力 Q/K/V 的直觉含义？缩放因子 `√d_k` 为什么存在？长文本复杂度瓶颈在哪个环节？
- 为什么需要位置编码？RoPE 为什么只作用于 Q 和 K？
- Post-LN 到 Pre-LN 再到 RMSNorm 的演进动机是什么？
- KV Cache 是什么、为什么只缓存 K/V 不缓存 Q？两条显存公式分别怎么估？
- 解码参数作用在哪条流水线上？三类参数怎么分工？
- Temperature 的数学含义？为什么说它不是"创造力参数"？
- Top-K 和 Top-P 的本质区别？三种重复惩罚各自管什么？
- T=0 时 top_p 该怎么设？OpenAI 官方对 temperature 和 top_p 的建议是什么？
- 预训练、SFT、RLHF/DPO 三阶段各自解决什么问题？
- RLHF 为什么需要奖励模型？为什么需要 Reference Model 和 KL 约束？PPO 阶段几个模型同时在线？
- DPO 的核心思想一句话？与 RLHF 相比优劣在哪？SFT/DPO/RLHF 的数据格式分别是什么？
- Prefill 和 Decode 各自的计算特点？分别决定哪个延迟指标？
- 推理加速各手段的收益来源（省显存/提吞吐/降延迟）怎么对应？vLLM、SGLang、TensorRT-LLM、Ollama 的定位差异？
- 为什么 LLM 限流不能只看 QPS？三维限流矩阵是哪三维？
- 成本控制三板斧按 ROI 怎么排序？令牌桶的正确顺序是什么？
- 可观测性三大支柱是什么？TTFT 和 TPOT 分别对应什么体验？
- 每次 LLM 调用的日志最小记录集合包含哪些字段？
- 提示注入的本质原因是什么？为什么不能只靠 prompt 模板防御？
- 私有化部署和 API 调用的数据边界差异？国内"双备案"的时限和周期？

## 参考资料

**LLM 基础**

- [Transformer 与注意力机制：大模型的核心引擎（Datawhale Easy-Vibe）](https://datawhalechina.github.io/easy-vibe/zh-cn/appendix/8-artificial-intelligence/transformer-attention.html)
- [LLM Internals 4.3：旋转位置编码（yeasy.gitbook.io）](https://yeasy.gitbook.io/llm_internals/di-yi-bu-fen-ji-chu-pian/04_position_encoding/4.3_rope)
- [大模型中 KV Cache 原理及显存占用分析（CSDN）](https://blog.csdn.net/muyao987/article/details/140364179)
- [OpenAI API Reference：Completions Create（官方参数定义）](https://developers.openai.com/api/reference/resources/completions/methods/create/)
- [Hugging Face 文档：Text Generation / GenerationConfig](https://huggingface.co/docs/transformers/main_classes/text_generation)
- [大模型的参数：温度值、Top-P、Top-K 各场景下的调参建议（小林笔记）](https://xiaolinnote.com/ai/llm/temperature_top_p_top_k.html)
- [大模型常识篇——Temperature（腾讯云开发者社区）](https://cloud.tencent.com/developer/article/2537324)
- [DPO: Direct Preference Optimization 论文解读（李理博客）](http://fancyerii.github.io/2024/01/31/dpo/)
- [SFT、RLHF、DPO 微调方法全景认知（卡码笔记）](https://notes.kamacoder.com/llm/app/finetuning_sft_rlhf_dpo.html)
- [图解大模型 RLHF 系列：人人都能看懂的 PPO 原理与源码解读（知乎）](https://zhuanlan.zhihu.com/p/677607581)

**AI 系统工程与部署**

- [大模型推理到底在做什么？从 Prefill、Decode 到 vLLM，一次讲透（腾讯云开发者社区）](https://developer.cloud.tencent.com/article/2655522)
- [大模型基础设施工程 12：PagedAttention 与 Continuous Batching（quant67）](https://quant67.com/post/llm-infra/12-paged-continuous/12-paged-continuous.html)
- [大模型 Prefill-Decode 分离式推理架构解读（知乎）](https://zhuanlan.zhihu.com/p/1957513179971158240)
- [大模型量化领域梳理（二）：SmoothQuant、GPTQ 和 AWQ（知乎）](https://zhuanlan.zhihu.com/p/1971154754953523608)
- [限流应对最佳实践（阿里云百炼官方文档）](https://help.aliyun.com/zh/model-studio/rate-limiting-best-practices)
- [LLM 降本增效，省钱才是硬道理（知乎）](https://zhuanlan.zhihu.com/p/2057487880986048422)
- [Token 限流与配额管理（API7 AI 网关文档）](https://docs.apiseven.com/api7-gateway/3.9.x/ai-gateway/use-cases/token-rate-limiting-and-quota-management)
- [Langfuse 和 LangSmith：LLM 可观测性两大平台怎么选（博客园）](https://www.cnblogs.com/itech/p/22896448)
- [一篇看懂 OpenTelemetry GenAI：LLM、Agent、MCP 怎么做可观测性（Greptime）](https://greptime.cn/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)
- [Langfuse 官方文档：LLM Observability & Application Tracing](https://langfuse.com/docs/observability/overview)
- [生成式人工智能服务管理暂行办法（中国网信网）](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm)
- [生成式 AI 服务监管热点："双备案"实务新观察（君合律师事务所）](https://junhe.com/law-reviews/2974)
- [提示词注入攻击的检测和数据集介绍（安全内参）](https://www.secrss.com/articles/78754)
- [大模型安全权威指南 8.1：纵深防御原则（yeasy.gitbook.io）](https://yeasy.gitbook.io/ai_security_guide/di-san-bu-fen-fang-yu-pian/08_architecture/8.1_defense_depth)
