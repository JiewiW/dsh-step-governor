/**
 * 单插件 trace 运行时胶水（四包同源；与 lib/trace.js 同为内联，不跨包 import）。
 *
 * configHash 取「实际生效配置」：由各插件在 settings 合并完成后调用
 * setTraceConfig(...) 注入（优先级 env > 持久化 settings.json > 默认值），
 * 每次注入即 append 一条配置变更史（TRC-R8）。
 */
import { readFileSync } from "node:fs";
import { createTraceSink } from "./trace.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let liveConfig = Object.freeze({ plugin: pkg.name, version: pkg.version, defaultsApplied: true });

/** 本插件唯一的 trace 出口；订阅回调与判定发射点共用同一实例。 */
export const trace = createTraceSink({
  plugin: pkg.name,
  pluginVersion: pkg.version,
  effectiveConfig: () => liveConfig
});

/** 注入生效配置并重算 configHash（写一条变更史，确定性去重）。 */
export function setTraceConfig(effectiveConfig) {
  liveConfig = Object.freeze({ ...(effectiveConfig ?? {}) });
  trace.recordConfigChange();
  return trace.configHash;
}
