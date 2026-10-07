# dsh-step-governor

> ⚠️ **实验项目 · 未正式发布（Experimental, not released）**
> 版本 `0.0.1-experimental`，默认只观测不拦截。尚未经过真实长任务的零误杀验证，**请勿在生产 / 日常环境开启强制熔断**。本仓库用于存档设计与冒烟结果。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：当模型在长任务里"思考着思考但不推进"时，用宿主钩子在**步骤层面强制刹车**，而不是再靠提示词劝它自律。

它是姊妹项目 [dsh-cot-anchor](https://github.com/JiewiW/dsh-cot-anchor) 的补充：cot-anchor 在**单次生成内**做软切与结论回流；step-governor 在**跨步骤**层面做硬熔断，对准长任务账单的主要杠杆——步数 × 每步膨胀的上下文重读。

## 它解决什么

某些模型（典型如 DeepSeek-V4-Flash 系列）跑长任务时会：把同一结论在十几个步骤里反复重新推导；对同一个取证目标反复换路径尝试；连续多步既不交付也不改文件。实测这类会话的 token 账单中，缓存重读可占 95% 以上——每空转一步，就把不断膨胀的上下文整体重读一遍。提示注入与单流软切对此无效：模型知道自己在空转，却停不下来。

step-governor 的做法是**剥夺继续空转的执行权**，且判据全部是可机械计算的确定性信号（计数、指纹、错误码），不调用模型自评"是否在推进"。

## 两个熔断点

| 熔断 | 宿主钩子 | 返回 | 作用 |
| --- | --- | --- | --- |
| G1 步级 | `agent/pre-step` | `{kind:"reject"}` | 终止当前回合（落 `turn/end reason=blocked`），不再发本次请求 |
| G2 支线 | `tools/pre-execute` | `{kind:"deny"}` | 跳过该次工具调用，回喂一条错误文本，回合继续 |

G1 触发条件（默认值均为暂定，可配）：

- **G1-A** 连续 4 步无文本交付、无文件变更、工具结果全失败/为空；
- **G1-B** 同一段推理结论指纹跨 6 步重现且其间无文件变更（抓"每步都成功读到新东西、却在重推同一结论"）；
- **G1-C** 单回合步数达到 60 的硬上限（安全网）。

G2 触发条件：

- **G2-A** 同一调用目标（归一化后的文件 / URL / 命令）尝试超过 3 次；
- **G2-B** 同一目标连续失败 2 次（与"同命令失败最多重试 2 次"纪律对齐）。

## 工作模式

用环境变量 `DSH_GOVERNOR_MODE` 切换，默认 `shadow`：

| 模式 | 行为 |
| --- | --- |
| `off` | 完全透传，不观测 |
| `shadow` | 观测并写结构化日志，**永不拦截**（默认） |
| `g2b` | 仅 G2-B（连续失败）强制拦截 |
| `g2` | G2-A + G2-B 强制拦截，G1 仍只观测 |
| `g1g2` | G1 + G2 全部强制拦截 |

阈值环境变量：`DSH_GOVERNOR_G1A_N`、`DSH_GOVERNOR_G1B_K`、`DSH_GOVERNOR_G1C_MAX`、`DSH_GOVERNOR_G2A_M`、`DSH_GOVERNOR_G2B_F`。

**安全设计**：插件任何内部异常都 fail-open（放行），绝不因自身故障阻断正常任务；真实用户新消息会重置全部计数（插件自己的注入消息不会）。

## 能力边界（请先读）

- 判得出：调用是否重复 / 失败、推理指纹是否重复、有没有交付或改文件。
- 判不出：刚读到的新数据与任务是否相关。因此"每步都成功、内容也不重复、但整体在偏离任务"这种**语义级空转不在覆盖范围内**。
- G2 的目标键归一不了"换一种方法追同一个目的"（直连→token→cookie→本地缓存），那需要理解每步意图。
- 熔断只让模型更早带着已有证据停手，**不保证交付内容正确**。

## 安装（仅用于隔离实验）

不要装进日常使用的 profile。建议新建一次性 profile 并换端口：

```sh
dsh --profile govsmoke --from-default-profile web
dsh plugin --profile govsmoke add github:JiewiW/dsh-step-governor
DSH_GOVERNOR_MODE=shadow dsh --profile govsmoke --no-open --port 3099
```

host-only 插件，无客户端界面；加载成功时 stderr 打印：

```
[dsh-step-governor] {"mode":"shadow","at":"loaded","thresholds":{...}}
```

## 测试

```sh
node test/test-governor-logic.mjs   # 纯逻辑断言
node test/test-integration.mjs      # 伪内核钩子集成断言
```

在隔离 profile + 独立端口的真实 DSH 上做过 shadow / g2b / g1g2 三种模式启动冒烟，结果见 [SMOKE-REPORT.md](SMOKE-REPORT.md)。

## 尚未完成（为什么它还是实验版）

- 未在真实模型长任务上量化强制熔断实际省下的 token，也未跑"≥10 个正常任务零误杀"的影子期；
- 与 goal 自动续跑驱动（goal-round-driver）并存时，pre-step 钩子的注册顺序与 blocked 原因码仍是待核实项（设计提案有专节）。

完整设计、原理、灰度计划与验收标准见姊妹仓库设计提案 `dsh-cot-anchor/docs/governor-design-proposal.md`。

## 许可

MIT
