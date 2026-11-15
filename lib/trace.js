/**
 * DSH trace 契约底座 —— 四包内联同源副本（TRC-R4/R5/R6/R7/R8/R9/R19/R25）。
 *
 * 为什么内联：四包 package.json 的 exports 是封闭白名单，跨包 import
 * `dsh-derive-watcher/lib/trace.js` 必抛 ERR_PACKAGE_PATH_NOT_EXPORTED。
 * 本文件由 D:/dsh/_b1scratch/trace-build/trace.js 复制到四包 lib/ 下，
 * 四份必须 sha256 一致；不得改成共享包。
 *
 * 写入路径：session.append("trace/<category>", data, { ignorable: true })。
 * 顶层只允许内核补的 ignorable / seq / time，所有业务字段进 data。
 * 三处内核补丁 marker 是未知 trace/* 能被写入/读出的唯一依据。
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 改字段模板、脱敏边界或指标口径时递增（TRC-R25）。 */
export const TRACE_VERSION = 1;

/** data 固定 12 键；payload 固定 8 键，unclassified 是唯一允许的第 9 键。 */
export const DATA_KEYS = Object.freeze([
  "traceVersion", "plugin", "pluginVersion", "runId", "groupId", "sessionId",
  "turn", "step", "sourceEventSeq", "ts", "configHash", "payload"
]);
export const PAYLOAD_KEYS = Object.freeze([
  "rule", "matched", "values", "thresholds", "inputHash", "inputRef",
  "comparedIds", "reason"
]);
export const CATEGORIES = Object.freeze([
  "scan", "decision", "action", "outcome", "invocation"
]);

/** evidenceSeq 四类语义 + 保留原有 step 命名，共 5 个枚举值（TRC-R7）。 */
export const SEQ_NAMESPACES = Object.freeze([
  "counter", "step", "session", "stall", "external"
]);

/** 宿主未提供 turn/step 时的显式哨兵：必填键不得为 null，也不伪造真实步序。 */
export const UNKNOWN_POSITION = -1;

const DEFAULT_CONFIG_ROOT = join(homedir(), ".dsh", "trace");
const SHA256_PREFIX = "sha256:";

/** 按键名排序（递归）序列化，展开默认值后的生效配置才参与 hash。 */
function sortedClone(value) {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedClone(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

/** 脱敏：只写摘要，inputRef 恒为 null（TRC-R19 冻结）。 */
export function hashInput(text) {
  return SHA256_PREFIX + createHash("sha256").update(String(text ?? "")).digest("hex");
}

/** @returns {"sha256:<hex>"} 生效配置的确定性 hash（TRC-R8）。 */
export function computeConfigHash(effectiveConfig) {
  const canonical = JSON.stringify(sortedClone(effectiveConfig ?? {}));
  return SHA256_PREFIX + createHash("sha256").update(canonical).digest("hex");
}

function dayStamp(now = new Date()) {
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0")
    + "-" + String(now.getDate()).padStart(2, "0");
}

/** 按日分片 append-only JSONL（骨架复用 auto-memory/evidence-store.js）。 */
function appendJsonl(root, fileName, record) {
  try {
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, fileName), JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch (error) {
    try { console.warn(`[trace] append-jsonl-failed ${fileName}: ${error?.message ?? error}`); } catch { /* ignore */ }
    return false;
  }
}

/**
 * 创建单插件的 trace 出口。
 * @param {object} options
 * @param {string} options.plugin 插件 id
 * @param {string} options.pluginVersion 插件版本
 * @param {object|Function} [options.effectiveConfig] 生效配置（env > settings.json > defaults 合并结果）
 * @param {string} [options.configRoot] 变更史 / 降级 sidecar 落盘根
 * @param {Function} [options.log] 结构化日志行输出
 */
export function createTraceSink(options = {}) {
  const {
    plugin,
    pluginVersion,
    effectiveConfig = {},
    configRoot = process.env.DSH_TRACE_CONFIG_ROOT || DEFAULT_CONFIG_ROOT,
    log = (line) => console.warn(line)
  } = options;
  const resolveConfig = typeof effectiveConfig === "function"
    ? effectiveConfig
    : () => effectiveConfig;

  const runId = process.env.DSH_TRACE_RUN_ID ?? null;
  const groupId = process.env.DSH_TRACE_GROUP_ID ?? null;
  /** sessionId -> { session, lastSeq, lastTurn, lastStep }；只记录非 trace/* 的上游事件。 */
  const bindings = new Map();
  /** 最近一次 bind 的 sessionId：判定点未显式带 sessionId 时的唯一回退（多会话下仍以显式值为准）。 */
  let lastBoundSessionId = null;
  const recordedConfigKeys = new Set();
  let configHash = computeConfigHash(resolveConfig());
  let missingWarned = false;

  function warnMissing(detail) {
    if (missingWarned) return;
    missingWarned = true;
    try { log(`TRACE_CONFIG_MISSING ${detail}`); } catch { /* ignore */ }
  }
  if (runId === null || groupId === null) {
    warnMissing(`plugin=${plugin} runId=${runId} groupId=${groupId}`);
  }

  /** 变更史：启动时写一条，保证每条 decision 的 hash 可回溯（TRC-R8）。 */
  function recordConfigChange() {
    const current = computeConfigHash(resolveConfig());
    configHash = current;
    const key = `${dayStamp()}:${plugin}:${current}`;
    if (recordedConfigKeys.has(key)) return current;
    const ok = appendJsonl(configRoot, `config-history-${dayStamp()}.jsonl`, {
      ts: new Date().toISOString(), plugin, configHash: current, config: sortedClone(resolveConfig())
    });
    if (ok) recordedConfigKeys.add(key);
    return current;
  }
  recordConfigChange();

  /**
   * session/event 订阅回调里调用：登记会话句柄与上游事件 seq。
   * trace/* 自产事件不覆盖 lastSeq，否则 sourceEventSeq 会指向上一条 trace（自引用，join 失效）。
   */
  function bind(session, event) {
    if (typeof event?.type === "string" && event.type.startsWith("trace/")) return null;
    const sid = session?.id ?? event?.data?.sessionId ?? null;
    if (!sid) { warnMissing(`plugin=${plugin} session-id-unavailable`); return null; }
    const prev = bindings.get(sid) ?? { session: null, lastSeq: null, lastTurn: null, lastStep: null };
    if (session && typeof session.append === "function") prev.session = session;
    if (Number.isInteger(event?.seq)) prev.lastSeq = event.seq;
    const data = event?.data ?? {};
    if (Number.isFinite(data.turn)) prev.lastTurn = data.turn;
    if (Number.isFinite(data.step)) prev.lastStep = data.step;
    bindings.set(sid, prev);
    lastBoundSessionId = sid;
    return prev;
  }

  /** 缺失降级：完整落到 sidecar，不得只 try/catch 吞掉（TRC-R25）。 */
  function degrade(data, reason) {
    appendJsonl(configRoot, `trace-degraded-${dayStamp()}.jsonl`, {
      type: "trace/invocation",
      ts: new Date().toISOString(),
      reason,
      data: { ...data, payload: { ...data.payload, reason } }
    });
    warnMissing(`plugin=${plugin} ${reason}`);
  }

  /**
   * dsh-session.append 用 snapshotJsonValue 做无损 JSON 校验：undefined / NaN /
   * -0 / BigInt / 函数 / 异类对象一律整条拒收。判定逻辑已经跑完，values 与
   * thresholds 只是观测快照，这里统一走一次 JSON 往返把不可序列化值洗掉，
   * 保证事件能落盘；顶层 12 键与 payload 8 键由 emit 显式构造，不受影响。
   */
  function jsonSafe(value) {
    try {
      const text = JSON.stringify(value);
      return text === undefined ? null : JSON.parse(text);
    } catch { return null; }
  }

  function appendTrace(session, type, data) {
    const safeData = jsonSafe(data);
    if (safeData === null) {
      degrade(data, "append-failed: data-not-json-safe");
      return false;
    }
    try {
      session.append(type, safeData, { ignorable: true });
      return true;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes("cannot reenter")) {
        // dsh-session 的 publish 期间禁止再 append；延迟到 publish 结束后重发（TRC-R9）。
        queueMicrotask(() => {
          try { session.append(type, safeData, { ignorable: true }); }
          catch (retryError) { degrade(data, `append-retry-failed: ${String(retryError?.message ?? retryError)}`); }
        });
        return true;
      }
      degrade(data, `append-failed: ${message}`);
      return false;
    }
  }

  /**
   * 发一条 trace 事件。类别非法时按 TRC-R5 兜底成 invocation + unclassified。
   * @param {string} category scan|decision|action|outcome|invocation
   * @param {object} spec 判定上下文
   */
  function emit(category, spec = {}) {
    const known = CATEGORIES.includes(category);
    const resolved = known ? category : "invocation";
    const unclassified = !known || spec.unclassified === true;
    const sid = spec.sessionId ?? lastBoundSessionId ?? null;
    const binding = sid !== null ? bindings.get(sid) : null;
    const session = binding?.session ?? null;

    const values = { ...(spec.values ?? {}) };
    if (spec.evidenceSeq !== undefined && spec.evidenceSeq !== null) values.evidenceSeq = spec.evidenceSeq;
    if (spec.seqNamespace !== undefined && spec.seqNamespace !== null) {
      if (SEQ_NAMESPACES.includes(spec.seqNamespace)) values.seqNamespace = spec.seqNamespace;
      else {
        values.seqNamespace = null;
        try { log(`[trace] unknown seqNamespace ${spec.seqNamespace}`); } catch { /* ignore */ }
      }
    }

    const payload = {
      rule: spec.rule ?? null,
      matched: spec.matched === true,
      values,
      thresholds: spec.thresholds ?? {},
      inputHash: spec.inputHash ?? null,
      inputRef: null,
      comparedIds: Array.isArray(spec.comparedIds) ? spec.comparedIds : [],
      reason: unclassified ? "unclassified" : (spec.reason ?? null)
    };
    if (unclassified) payload.unclassified = true;

    const turn = Number.isFinite(spec.turn) ? spec.turn
      : (Number.isFinite(binding?.lastTurn) ? binding.lastTurn : UNKNOWN_POSITION);
    const step = Number.isFinite(spec.step) ? spec.step
      : (Number.isFinite(binding?.lastStep) ? binding.lastStep : UNKNOWN_POSITION);
    const sourceEventSeq = Number.isInteger(spec.sourceEventSeq)
      ? spec.sourceEventSeq
      : (Number.isInteger(binding?.lastSeq) ? binding.lastSeq : null);

    const data = {
      traceVersion: TRACE_VERSION,
      plugin,
      pluginVersion,
      runId,
      groupId,
      sessionId: sid,
      turn,
      step,
      sourceEventSeq,
      ts: new Date().toISOString(),
      configHash,
      payload
    };

    const type = `trace/${resolved}`;
    if (!session || typeof session.append !== "function") {
      // session 不可用：无法 append 时写 sidecar 并显式告警，绝不静默丢弃。
      degrade(data, "session-unavailable");
      return data;
    }
    if (sourceEventSeq === null) {
      // 上游 seq 缺失：仍要发 invocation 留痕，不得只 try/catch 吞掉。
      appendTrace(session, "trace/invocation", {
        ...data,
        payload: { ...payload, reason: "session-unavailable" }
      });
    }
    appendTrace(session, type, data);
    return data;
  }

  return {
    plugin,
    pluginVersion,
    runId,
    groupId,
    get configHash() { return configHash; },
    bind,
    emit,
    recordConfigChange,
    hashInput,
    getBinding: (sid) => bindings.get(sid) ?? null
  };
}
