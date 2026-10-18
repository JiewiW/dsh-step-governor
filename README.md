# dsh-step-governor

DeepSeek Harness（DSH）插件：当模型在长任务里「想了很多步却不推进」时，在**步骤层面强制刹车**——不靠提示词劝它自律，而是直接剥夺继续空转的执行权。

- 默认 **shadow 模式**：只观测、写日志，永不拦截。
- 所有判据都是可机械计算的确定性信号（步数、指纹、错误码），不调用模型自评。
- 任何内部异常一律 fail-open（放行），不会因为插件故障卡住正常任务。

它是 [dsh-cot-anchor](https://github.com/JiewiW/dsh-cot-anchor) 的姊妹插件：cot-anchor 管**单次生成内**的软切，step-governor 管**跨步骤**的硬熔断。长任务账单的大头是「步数 × 每步膨胀的上下文重读」，步数治理对准的就是这个杠杆。

## 什么时候用它

某些模型跑长任务时会：把同一结论在十几步里反复重推；对同一取证目标反复换路径尝试；连续多步既不交付也不改文件。这类会话里缓存重读可占 token 的 95% 以上，模型往往**知道自己在空转却停不下来**。

step-governor 判得出：调用是否重复/失败、推理指纹是否重现、有没有交付或改文件。
判不出：刚读到的新数据与任务是否相关——语义级偏离不在覆盖范围内（见[能力边界](#能力边界)）。

## 两个熔断点

| 熔断 | 宿主钩子 | 动作 | 效果 |
| --- | --- | --- | --- |
| **G1 步级** | `agent/pre-step` | `{kind:"reject"}` | 终止当前回合（`turn/end reason=blocked`），不再发出本次请求 |
| **G2 支线** | `tools/pre-execute` | `{kind:"deny"}` | 跳过这一次工具调用，回喂一条错误文本，回合继续 |

**G1 触发条件**（括号内为默认值）：

- **G1-A 滑窗失速**：近 8 步滑窗（`g1aWindowSize`）内出现连续 4 步（`g1aZeroSteps`）无文本交付、无文件变更，且窗内成功工具占比 ≤ 0.25、reasoning 总量 < 160 字——后两个条件用来排除「安静干活」的正常步骤。
- **G1-B 指纹重现**：同一段推理结论的指纹跨 6 步（`g1bFingerprintSteps`）重现且其间无文件变更。专抓「每步都读到新东西、却在重推同一结论」。
- **G1-C 硬顶**：单回合 60 步（`g1cMaxStepsPerTurn`）安全网。

**G2 触发条件**：

- **G2-A**：同一调用目标（归一化后的文件 / URL / 命令 / 参数）尝试超过 3 次（`g2aSameTargetCalls`）。
- **G2-B**：同一目标连续失败 2 次（`g2bConsecutiveFailures`），与「同命令失败最多重试 2 次」纪律对齐。

**目标键归一化**（决定 G2 的「同一目标」到底是什么）：

| 工具 | 键体组成 |
| --- | --- |
| `read` | 文件路径 + `offset`/`limit`（分页即不同目标） |
| `grep` | pattern + path |
| `edit` / `write` | 文件路径 + 变更语料哈希（改内容即不同目标） |
| `pwsh` / `bash` / `sh` | 管道首段的全部参数 + 后续段哈希 |
| 其他工具 | 依次取 `file_path`/`path`/`url`/`command`/`pattern`/`script`/`query`/`name`；**这些字段一个都取不到时，回退到全参数规范化 JSON 的哈希** |

最后那行兜底很关键：若键体退化为空串，同一工具下的所有调用会塌成同一个目标键（FNV-1a 空串恒为 `0x811c9dc5`），G2-B 一旦命中就永久拦截，改参数也无法脱身。

**终态提交工具豁免**：工具名中含 `submit` / `report` / `finalize` / `finish` / `complete` / `deliver` / `accept` 词元的（如工作流编排的 `fusion_submit_result`），G2-A 与 G2-B **只观测不拦截**。理由是这类工具是外部工作流「本轮必须以它提交结果」的唯一出口，拦截它不会让模型换一条路，只会让外部编排永远读不到提交、进而判定该角色不可用、把一次可修正的参数错误升级成整任务死锁。防刷屏交给 G1-C 的回合步数上限。命中时仍写一条 `action:"exempt"` 的观测日志（无失败历史时不写，避免正常提交刷屏）。

真人用户发来的新消息会重置全部计数（插件自己注入的消息不会）。

## 工作模式

五档，灰度顺序 `shadow → g2b → g2 → g1g2`：

| 模式 | 行为 |
| --- | --- |
| `off` | 完全透传，不观测 |
| `shadow` | 观测并写结构化日志，**永不拦截**（默认） |
| `g2b` | 仅 G2-B（连续失败）强制拦截 |
| `g2` | G2-A + G2-B 拦截，G1 仍只观测 |
| `g1g2` | G1 + G2 全部拦截（**实验档**：零误杀影子期未达标，设置页中标记为 experimental） |

## 安装与配置

```sh
dsh plugin --profile <你的profile> add github:JiewiW/dsh-step-governor#v0.1.3
```

host + client 双半边插件：加载后在 DSH 设置页出现「步数治理」卡片，14 项配置可直接改并持久化；也可用 `GET/POST /plugins/step-governor/settings` 读写（GET 返回完整 schema）。

环境变量只作为**启动初始值**，且优先级最高（env 显式设置的键，设置页保存不会覆盖）：

| 环境变量 | 对应配置 | 默认 |
| --- | --- | --- |
| `DSH_GOVERNOR_MODE` | `mode` | `shadow` |
| `DSH_GOVERNOR_G1A_N` | `g1aZeroSteps` | 4 |
| `DSH_GOVERNOR_G1B_K` | `g1bFingerprintSteps` | 6 |
| `DSH_GOVERNOR_G1C_MAX` | `g1cMaxStepsPerTurn` | 60 |
| `DSH_GOVERNOR_G2A_M` | `g2aSameTargetCalls` | 3 |
| `DSH_GOVERNOR_G2B_F` | `g2bConsecutiveFailures` | 2 |

加载成功时 stderr 打印一行：

```
[dsh-step-governor] {"mode":"shadow","at":"loaded","thresholds":{...}}
```

> 实验期间建议用独立 profile + 独立端口运行，不要直接在日常 profile 开启强制档。

## 能力边界

- G2 的目标键归一化识别不了「换一种方法追同一个目的」（直连 → token → cookie → 本地缓存），那需要理解每步意图。
- 「每步都成功、内容不重复、但整体在偏离任务」属于语义级空转，本插件不覆盖。
- 熔断只让模型更早带着已有证据停手，**不保证已交付内容正确**。
- 与 goal 自动续跑驱动并存时，pre-step 钩子的注册顺序仍属待核实项。

## 测试

```sh
node --test test/services.test.mjs test/payloads.test.mjs test/settings.test.mjs \
  test/test-governor-logic.mjs test/test-integration.mjs
```

纯逻辑断言 + 伪内核钩子集成断言，共 21+ 用例。shadow / g2b / g1g2 三档真实启动冒烟结果见 [SMOKE-REPORT.md](SMOKE-REPORT.md)。

## 许可

MIT
