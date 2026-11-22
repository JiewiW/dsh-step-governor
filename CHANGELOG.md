# 更新日志

本文件记录 dsh-step-governor 的所有重要变更。

## [0.3.0] - 2026-11-22

### 新增

- **止损链路健康告警（GUI 渠道）**：会话头部新增告警徽标，当 derive-watcher 心跳异常时显示，心跳恢复后自动消失。无告警时不渲染任何 DOM。
  - 新增只读路由 `GET /plugins/step-governor/watchdog`，返回当前告警、上次心跳时间与启动信息。
  - **启动检测**：插件加载后 120 秒内仍无任何心跳，且会话有活动时，判定 watcher 未运行并告警。补齐了原先「从未有过心跳就永不告警」的盲区——而这恰恰是最危险的失效形态（止损链路完全不在）。
  - 宽限期可用环境变量 `DSH_GOVERNOR_WATCHDOG_GRACE_MS` 覆盖。
- `traceThresholds()` 修复既有 bug：引用不存在的 `CONFIG.maxStepsPerTurn`，改为 `CONFIG.g1cMaxStepsPerTurn`。

### 移除

- **soft-cut 预算抑制升级**（原设计 §10.2 第 4 条）：删除对 `agent/soft-cut-suppressed` 事件的订阅、`SOFTCUT_HIGH_CONFIDENCE` 常量、`lastEscalatedTurn` 状态字段及对应测试。
  - 移除原因：内核 `p5-softcut-unlimited` 补丁已取消三类软切预算上限（`decideSoftCutBudget` 恒返回 `"take"`），「抑制」这一前提不复存在，订阅成为死代码。
- 待接线依赖从 3 项减至 1 项：
  - 移除 `5/softcut-suppressed-payload`（同上，前提已消失）。
  - 移除 `7/heartbeat-event-name`（事件名已由 `derive-watcher/lib/events.js` 证实一致，不再是未决项）。
  - 保留 `7/watchdog-outbound`（出站告警服务 API 仍未发布）。

### 变更

- **通知渠道收敛为仅 `GUI`**：`notifyChannels` 的可选项从 `GUI`/`board`/`webhook`/`IM` 收敛为只有 `GUI`，因为其余三个渠道从未实现。旧配置中的无效值会在保存时自动过滤。
- 设置项总数不变（15 项）。

### 验证

- 单元测试 22/22 通过，新增看门狗启动检测与 GUI 渠道用例。
- 隔离实例验证：路由返回 `startupGraceMs`/`startedAt`；`DSH_GOVERNOR_WATCHDOG_GRACE_MS=3000` 生效；客户端 bundle 包含徽标组件与槽位注册。

## [0.2.3] 及更早

早期版本变更见 git 提交历史。
