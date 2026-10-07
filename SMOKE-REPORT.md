# dsh-step-governor 冒烟测试结果报告

> 结论先行：**通过**。实验插件已作为独立副本实现，纯逻辑 17 条断言、伪内核集成 9 条断言全部通过；在隔离 profile `govsmoke` 上以 shadow / g2b / g1g2 三种模式于 3099/3097 端口真实启动 DSH，均干净激活、HTTP 200、零插件激活错误。测试全程未触碰 3080 端口的在用 DSH 服务，测试后实例已全部关闭，3080 始终在听。

## 1. 被测对象

| 项 | 值 |
| --- | --- |
| 插件目录 | 独立实验目录 `<repo>/dsh-step-governor`（由 dsh-cot-anchor 复制后重写，独立 identity，未改动正式插件） |
| 包名 / 版本 | `dsh-step-governor` / `0.0.1-experimental` |
| 形态 | host-only（无 client 半边），不改内核 |
| 挂载钩子 | `agent/pre-step`（G1 reject）、`tools/pre-execute`（G2 deny）、`session/event`（状态推进） |
| 设计依据 | dsh-cot-anchor `docs/governor-design-proposal.md` |
| 模式 | `off` / `shadow`（默认）/ `g2b` / `g2` / `g1g2`，经 env `DSH_GOVERNOR_MODE` 切换；阈值 env 可覆盖 |
| 失败策略 | 全组件 try/catch，异常一律 fail-open 放行 |

正式插件 `dsh-cot-anchor`（web profile）未被修改；本插件只装入一次性 profile `govsmoke`。

## 2. 隔离方式（保证不影响 3080）

1. 从出厂模板新建独立 profile：`dsh --profile govsmoke --from-default-profile web`。
2. 插件以 `dsh plugin --profile govsmoke add <本地 dsh-step-governor 路径>` 装入该 profile（pnpm 符号链接，仅 govsmoke 可见）。
3. 启动一律 `--no-open --port <3099|3097>`，独立工作目录。
4. 结束按端口精确停止（仅查 3097/3099 的监听 PID），未按进程名通杀。
5. 每步核验：测试前后 3080 监听数均为 1。

## 3. 测试一：纯逻辑单测（`test/test-governor-logic.mjs`）

命令：`node test/test-governor-logic.mjs`；结果：**17/17 PASS，退出码 0**。

覆盖：
- 目标键归一化：不同文件→不同键；同 URL 不同 query→同键；同命令不同参数后缀→同键；不同工具名→不同键。
- 失败签名：`isError`、HTTP 401/403、command-not-found 识别；正常结果不误判。
- G2-B：同目标连续失败 2 次后命中；出现成功结果后清零。
- G2-A：同目标第 4 次调用命中（M=3）。
- G1-A：连续硬零推进 4 步命中（N=4）；成功工具、真实用户消息后计数清零；插件 spliced 注入（source.kind≠user）不重置。
- G1-B：同一推理指纹跨 6 步重现命中（K=6）；文件变更后指纹清空不命中。
- G1-C：步数达硬上限命中。

## 4. 测试二：伪 cordis ctx 集成测试（`test/test-integration.mjs` + `integrity-runner.mjs`）

用最小伪 ctx（支持 `ctx.on` 与按序 waterfall `next` 链）装载真实 `apply()`，以真实 `session/event` 事件序列（tool/call↔tool/result 按 callId 配对、assistant/message 取 text/reasoning 块）驱动。结果：**9/9 PASS，退出码 0**。

| 模式 | 验证点 | 结果 |
| --- | --- | --- |
| shadow | 插件 loaded | PASS |
| shadow | G2 连续失败时不 deny（放行） | PASS（next） |
| shadow | G1 零推进时不 reject（放行） | PASS（next） |
| g2b | G2-B 连续失败返回 `{kind:"deny"}` 且 reason 含 G2-B | PASS |
| g2b | G1 仍保持影子放行 | PASS |
| g1g2 | G1-A 达阈值返回 `{kind:"reject"}`（G1A_N=2） | PASS |
| g1g2 | 坏 payload 致处理器抛错时 fail-open 放行 | PASS |

该层验证了**钩子回调的真实决策返回值**与异常容错。

## 5. 测试三：真实宿主启动冒烟（隔离 profile + 独立端口）

客观通过信号统一为：进程存活 + stdout 打印 token URL + 带 token 请求 HTTP 200 + stderr 出现 `[dsh-step-governor] {... "at":"loaded" ...}` + 无 `did not activate / failed to import / EADDRINUSE / startup failed`。

| 模式 | 端口 | 进程存活 | HTTP | loaded 日志 | 激活错误 |
| --- | --- | --- | --- | --- | --- |
| shadow（默认阈值） | 3099 | 是 | 200 | 是（G1A4/G1B6/G1C60/G2A3/G2B2） | 0 |
| g2b | 3099 | 是 | 200 | 是 | 0 |
| g1g2（G1A_N=2） | 3097 | 是 | 200 | 是（G1A=2 生效） | 0 |

loaded 日志实例：`[dsh-step-governor] {"mode":"shadow","at":"loaded","thresholds":{"G1A":4,"G1B":6,"G1C":60,"G2A":3,"G2B":2}}`。

这一层证明：插件被真实 DSH 内核成功 import，三个 `ctx.on` 注册在加载期无异常（否则报 did not activate），env 配置注入与模式切换在真实宿主中生效。

## 6. 过程中发现并修复的问题（实现自测，非正式插件）

1. **事件接线缺口**：初版只在钩子里读状态，未把 assistant 步骤与工具结果接进状态机，G1-A/G2-A 实际不会计数。已改为：step/start 结算上一步推进；tool/call 建 callId→目标键映射；pre-execute 放行时计 calls；tool/result 按 callId 关联并更新 consecutiveFail。
2. **计数双计**：曾在 tool/call 事件与 pre-execute 两处都累加 calls，已统一为只在 pre-execute 放行时计一次。
3. **启动姿势**：`--patch` 用目录名作 insert name 导致首次 failed to import；改用 `dsh plugin add` 正式装入隔离 profile 后正常。
4. 一次残留进程占用 3099（EADDRINUSE），已仅按 3099 端口精确清理；3080 全程未动。

## 7. 已验证 / 未验证边界（诚实标注）

- 已验证：逻辑判定、阈值、重置、归一化；shadow/g2b/g1g2 下钩子的 deny/reject/放行决策；fail-open；真实宿主加载与三种模式激活；HTTP 可用性；对 3080 零影响。
- 未验证（需真实模型长任务，属计划书 AC6/AC7 范畴，本次不做）：
  - 真实空转会话中 reject/deny 的**端到端触发率与节省的 cacheRead 上界**；
  - 计划书未决项 8.2——goal-round-driver 与本插件 pre-step 的 waterfall 注册顺序、reject 被记为 `prompt-rejected` 的问题（本次 govsmoke 未启用 goal 驱动）；
  - ≥10 个正常任务的零误杀影子期（AC9）。
- 因此本插件状态维持 `0.0.1-experimental`，默认 shadow（只记录不拦截），不具备在正式环境直接 enforce 的验收条件。

## 8. 复现步骤

```sh
# 逻辑 + 集成测试（在仓库根目录）
node test/test-governor-logic.mjs
node test/test-integration.mjs

# 真实宿主冒烟（隔离 profile；端口可换；严禁用日常 profile 与在用端口）
dsh --profile govsmoke --from-default-profile web
dsh plugin --profile govsmoke add <本仓库本地路径>
$env:DSH_GOVERNOR_MODE="shadow"   # PowerShell；或 g2b / g2 / g1g2
dsh --profile govsmoke --no-open --port 3099
# 客观信号：stdout token URL；带 token 请求 HTTP 200；
# stderr 出现 [dsh-step-governor] ... "at":"loaded"；无 did not activate。
# 收尾：仅停止监听 3099 的 PID；确认在用端口仍在听。
```

## 9. 清理状态

- 测试实例（3099/3097）已全部关闭；测试端口释放、在用端口（3080）始终在听。
- 保留物：实验插件目录、一次性 profile `govsmoke`、本报告（含临时 token 的 smoke-*.log 不入库，已删除）。
- 未合并、未安装进日常 profile、未作为正式版发布；正式插件 dsh-cot-anchor 未改动。
