/**
 * dsh-step-governor — 确定性步数治理（实验插件，源自 governor-design-proposal）。
 *
 * 两个硬决策钩子（均为 waterfall，不改内核）：
 *   - agent/pre-step     → {kind:"reject", ...} 终止当前 turn（G1 步级熔断）
 *   - tools/pre-execute  → {kind:"deny", ...}   阻断单次工具调用（G2 支线熔断）
 *
 * 全部判据只用确定性信号（计数/指纹/错误签名），不调用 LLM 自评。
 * 组件自身任何异常一律 fail-open（放行），绝不阻断正常任务。
 *
 * 模式（env DSH_GOVERNOR_MODE / 设置卡 mode，默认 shadow）：
 *   off   = 完全透传，不观测（不装配任何钩子与服务）
 *   shadow= 观测+结构化日志，自身判据永不拦截
 *   g2b   = 仅 G2-B（连续失败）enforce
 *   g2    = G2-A + G2-B enforce，G1 仍影子
 *   g1g2  = G1 + G2 全部 enforce
 *
 * “阻断之后”（计划书 §2.2 / 设计 §9.3-9.4 / §10.2）：
 *   - 阻断载荷带计划书 §5.8 冻结枚举码（禁止自创码，禁止可重试码如 prompt-rejected）；
 *   - ctx.provide("stepGovernor") 暴露 denyToolCategory / rejectStep 两服务
 *     （L3 watcher 经 ctx.get 使用；显式调用即显式意图，服务在 shadow 亦生效）；
 *   - governor 只发 governor/category-denied 与 governor/step-rejected 两个事件；
 *     governor/auto-resume、governor/paused 由 driver 单一发射，本插件禁发；
 *   - 订阅 agent/soft-cut-suppressed 实现预算抑制升级（§10.2 第 4 条）；
 *   - 监听 watcher 心跳，静默超限发告警（§10.2 第 7 条）。
 */

import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = "dsh-step-governor";

// ── 计划书 §5.8 冻结阻断码（本插件使用的子集；禁止自创码）────────────────
// g1a-zero-delivery / g1b-fingerprint-repeat / g1c-turn-limit → 可走 G1 限次续跑
// g2a-same-target / g2b-consecutive-failure → deny，不终止 turn
// semantic-stall-2（watcher→governor，deny ttl 限定）
// semantic-stall（watcher→governor，L3 语义终判，不可重试，不走 G1 续跑）
const BLOCK_CODES = {
	G1_A: "g1a-zero-delivery",
	G1_B: "g1b-fingerprint-repeat",
	G1_C: "g1c-turn-limit",
	G2_A: "g2a-same-target",
	G2_B: "g2b-consecutive-failure",
	STALL_2: "semantic-stall-2",
	STALL_3: "semantic-stall"
};
/** 语义契约：阻断码禁止使用可重试码（如 prompt-rejected）。 */
const FORBIDDEN_RETRY_CODES = new Set(["prompt-rejected"]);

// ── 工具名 → 类别映射表（计划书 §5.8：read/grep 及 browser 只读类）────────
const CATEGORY_BY_TOOL = new Map([
	["read", "read"],
	["grep", "grep"],
	// browser 只读类归入 read（只读取证不产出文件）
	["browser_open", "read"],
	["browser_snapshot", "read"],
	["browser_a11y", "read"],
	["browser_content", "read"],
	["browser_scrape", "read"],
	["browser_screenshot", "read"],
	["browser_wait", "read"],
	["browser_history", "read"],
	["browser_visited", "read"],
	["web_fetch", "read"]
]);
/** denyToolCategory 首期类别枚举（未知类别拒绝调用）。 */
const DENY_CATEGORIES = new Set(["read", "grep"]);

// ── 设置 schema（设计 §9.3，共 10 项）────────────────────────────────────
const SETTINGS_ROUTE = "/plugins/step-governor/settings";
const SETTINGS_FILE = "step-governor.json";
const NOTIFY_CHANNELS = new Set(["GUI", "board", "webhook", "IM"]);
const SETTINGS_SCHEMA = [
	{ key: "mode", label: "拦截档位", type: "select", options: ["off", "shadow", "g2b", "g2", "g1g2"], group: "拦截",
		hint: "灰度顺序 g2b→g2→g1g2；off 完全透传，shadow 永不拦截。", experimentalOptions: ["g1g2"],
		experimentalNote: "g1g2 为实验强制档：零误杀影子期未达标前不得启用，白盒验证通过前默认保持 shadow。" },
	{ key: "g1aZeroSteps", label: "G1-A 连续无交付步数", type: "number", min: 2, max: 20, group: "G1 阈值" },
	{ key: "g1aWindowSize", label: "G1-A 滑窗步数", type: "number", min: 2, max: 20, group: "G1 阈值",
		hint: "近 N 步滑窗判定（覆盖隔步空转）" },
	{ key: "g1aSuccessRatioMax", label: "G1-A 窗内成功工具占比上限", type: "number", min: 0, max: 1, step: 0.05, group: "G1 阈值",
		hint: "近窗内成功工具占比≤此值才计入滑窗失速" },
	{ key: "g1aReasoningMin", label: "G1-A 窗内 reasoning 最小总字数", type: "number", min: 0, max: 2000, group: "G1 阈值",
		hint: "近窗内 reasoning 总字数<此值且成功率低才判滑窗失速" },
	{ key: "g1bFingerprintSteps", label: "G1-B 指纹重现步数", type: "number", min: 2, max: 30, group: "G1 阈值" },
	{ key: "g1cMaxStepsPerTurn", label: "G1-C 单回合硬顶", type: "number", min: 10, max: 500, group: "G1 阈值" },
	{ key: "g2aSameTargetCalls", label: "G2-A 同目标调用次数", type: "number", min: 1, max: 20, group: "G2 阈值" },
	{ key: "g2bConsecutiveFailures", label: "G2-B 连续失败次数", type: "number", min: 1, max: 10, group: "G2 阈值" },
	{ key: "g1MaxAutoResume", label: "G1 自动续跑上限", type: "number", min: 0, max: 10, group: "G1 续跑",
		hint: "G1 触发后自动续跑上限；0=触发即暂停。" },
	{ key: "g1AutoResumeSwitchAction", label: "续跑强制切换动作类别", type: "boolean", group: "G1 续跑",
		hint: "续跑 turn 是否经 G2 强制切换动作类别。" },
	{ key: "notifyChannels", label: "通知渠道", type: "multi-select", options: [...NOTIFY_CHANNELS], group: "通知",
		hint: "续跑耗尽后的通知渠道（driver 消费）。" },
	{ key: "maxSessions", label: "治理状态最大会话数", type: "number", min: 10, max: 2000, group: "高级" }
];
const SETTINGS_DEFAULTS = {
	mode: "shadow",
	g1aZeroSteps: 4,
	g1aWindowSize: 8,
	g1aSuccessRatioMax: 0.25,
	g1aReasoningMin: 160,
	g1bFingerprintSteps: 6,
	g1cMaxStepsPerTurn: 60,
	g2aSameTargetCalls: 3,
	g2bConsecutiveFailures: 2,
	g1MaxAutoResume: 3,
	g1AutoResumeSwitchAction: true,
	notifyChannels: ["GUI"],
	maxSessions: 200
};

// ── 阈值（env 作启动初始值；设置卡保存后覆盖并持久化，§9.3 兼容约定）──────
function intEnv(name, fallback) {
	const raw = process.env[name];
	const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MODES = ["off", "shadow", "g2b", "g2", "g1g2"];
/**
 * P0-6 配置优先级 env > 持久化 json > 默认：记录哪些 schema 键由 env 显式提供。
 * resetConfigFromEnv() 每次装配重建本集合（重复装配/测试互不污染）；
 * applySettings 对集合内键跳过持久化覆盖，保证 env 不被 json 全键覆盖。
 */
const envOwnedKeys = new Set();
/** 每个 schema 键对应的 env 名（与 resetConfigFromEnv 读取一致）。 */
const ENV_BY_KEY = {
	mode: "DSH_GOVERNOR_MODE",
	g1aZeroSteps: "DSH_GOVERNOR_G1A_N",
	g1bFingerprintSteps: "DSH_GOVERNOR_G1B_K",
	g1cMaxStepsPerTurn: "DSH_GOVERNOR_G1C_MAX",
	g2aSameTargetCalls: "DSH_GOVERNOR_G2A_M",
	g2bConsecutiveFailures: "DSH_GOVERNOR_G2B_F",
	maxSessions: "DSH_GOVERNOR_MAX_SESSIONS"
};
/** 运行时配置：由 resetConfigFromEnv()/applySettings() 原地更新，钩子与纯函数全部直读本对象。 */
const CONFIG = {};
/**
 * 从 env 重置 CONFIG 为启动初值（每次 apply() 开头调用）：
 * env=启动初值、设置卡=运行期覆盖；重复装配（测试/多实例）互不污染。
 */
function resetConfigFromEnv() {
	envOwnedKeys.clear();
	for (const [key, envName] of Object.entries(ENV_BY_KEY)) {
		if (process.env[envName] !== undefined && process.env[envName] !== "") envOwnedKeys.add(key);
	}
	CONFIG.mode = (process.env.DSH_GOVERNOR_MODE || "shadow").toLowerCase();
	if (!MODES.includes(CONFIG.mode)) CONFIG.mode = "shadow";
	CONFIG.g1aZeroSteps = intEnv("DSH_GOVERNOR_G1A_N", SETTINGS_DEFAULTS.g1aZeroSteps);
	CONFIG.g1bFingerprintSteps = intEnv("DSH_GOVERNOR_G1B_K", SETTINGS_DEFAULTS.g1bFingerprintSteps);
	CONFIG.g1cMaxStepsPerTurn = intEnv("DSH_GOVERNOR_G1C_MAX", SETTINGS_DEFAULTS.g1cMaxStepsPerTurn);
	CONFIG.g1aWindowSize = intEnv("DSH_GOVERNOR_G1A_WINDOW", SETTINGS_DEFAULTS.g1aWindowSize);
	CONFIG.g1aSuccessRatioMax = SETTINGS_DEFAULTS.g1aSuccessRatioMax;
	CONFIG.g1aReasoningMin = intEnv("DSH_GOVERNOR_G1A_REASONING", SETTINGS_DEFAULTS.g1aReasoningMin);
	CONFIG.g2aSameTargetCalls = intEnv("DSH_GOVERNOR_G2A_M", SETTINGS_DEFAULTS.g2aSameTargetCalls);
	CONFIG.g2bConsecutiveFailures = intEnv("DSH_GOVERNOR_G2B_F", SETTINGS_DEFAULTS.g2bConsecutiveFailures);
	CONFIG.g1MaxAutoResume = SETTINGS_DEFAULTS.g1MaxAutoResume;
	CONFIG.g1AutoResumeSwitchAction = SETTINGS_DEFAULTS.g1AutoResumeSwitchAction;
	CONFIG.notifyChannels = [...SETTINGS_DEFAULTS.notifyChannels];
	CONFIG.maxSessions = intEnv("DSH_GOVERNOR_MAX_SESSIONS", SETTINGS_DEFAULTS.maxSessions);
}
resetConfigFromEnv();

/**
 * 校验并应用一组设置（设置卡 POST / 持久化加载共用）：数值 clamp 到 schema
 * 范围、非法回退默认、未知键丢弃、布尔严格判型、渠道过滤。原地更新 CONFIG。
 * @param {unknown} raw 任意输入（可损坏）
 * @returns {object} 归一化后的设置快照
 */
function applySettings(raw) {
	const incoming = raw && typeof raw === "object" ? raw : {};
	const warn = [];
	for (const spec of SETTINGS_SCHEMA) {
		const key = spec.key;
		if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
		const v = incoming[key];
		if (spec.type === "select") {
			const next = typeof v === "string" ? v.toLowerCase() : "";
			if (envOwnedKeys.has(key)) {
				if (spec.options.includes(next)) warn.push(`${key} 由 env 固定，忽略持久化值 ${JSON.stringify(v)}`);
			} else if (spec.options.includes(next)) CONFIG[key] = next;
			else warn.push(`${key} 非法值 ${JSON.stringify(v)} 回退 ${CONFIG[key]}`);
		} else if (spec.type === "boolean") {
			if (envOwnedKeys.has(key)) {
				if (typeof v === "boolean") warn.push(`${key} 由 env 固定，忽略持久化值`);
			} else if (typeof v === "boolean") CONFIG[key] = v;
			else warn.push(`${key} 非布尔回退 ${CONFIG[key]}`);
		} else if (key === "notifyChannels") {
			const list = Array.isArray(v) ? v.filter((c) => NOTIFY_CHANNELS.has(c)) : [];
			if (list.length > 0) CONFIG[key] = [...new Set(list)];
			else warn.push(`${key} 非法回退默认`);
		} else {
			// P0-6 配置优先级 env > 持久化 json > 默认：env 显式设过的键
			// （resetConfigFromEnv 已吃进 CONFIG），持久化 json 一律不得覆盖。
			// 设置卡 POST 前无 env，保存仍即时生效；测试无 env，同语义。
			if (envOwnedKeys.has(key)) warn.push(`${key} 由 env 固定，忽略持久化值`);
			else {
				const n = Math.round(Number(v));
				if (Number.isFinite(n)) CONFIG[key] = Math.min(spec.max, Math.max(spec.min, n));
				else warn.push(`${key} 非数值回退 ${CONFIG[key]}`);
			}
		}
	}
	if (warn.length > 0) logStatic({ at: "settings-invalid", warnings: warn });
	return settingsSnapshot();
}
/** 当前设置快照（10 项）。 */
function settingsSnapshot() {
	const out = {};
	for (const spec of SETTINGS_SCHEMA) {
		const v = CONFIG[spec.key];
		out[spec.key] = Array.isArray(v) ? [...v] : v;
	}
	return out;
}
/** 尽早可用的静态日志（apply 之前也可能告警设置回退）。 */
function logStatic(payload) {
	try { console.warn(`[${PLUGIN_ID}] ${JSON.stringify(payload)}`); } catch { /* ignore */ }
}

function enforces(rule) {
	// rule: "G1-A" | "G1-B" | "G1-C" | "G2-A" | "G2-B"
	if (CONFIG.mode === "off" || CONFIG.mode === "shadow") return false;
	if (rule.startsWith("G2-")) {
		if (CONFIG.mode === "g2b") return rule === "G2-B";
		return true; // g2 / g1g2
	}
	return CONFIG.mode === "g1g2";
}

// ── 纯逻辑：目标键归一化 ─────────────────────────────────────────────────
/**
 * 归一化一次工具调用为"目标键"。只能识别同一调用目标，无法把
 * "换方法追同一目的"归一（这是设计上已知的能力边界）。
 *
 * P1-14 提参要点（评估报告 §6）：
 *   - read：offset/limit 翻页是"同一目标"，并入键体（offset 变 = 不同键）；
 *   - grep：带 path 时 pattern 才是目标（path 并入键体），无 path 时 pattern 即目标——
 *     旧 ?? 链把 pattern 排在 path 之后，带 path 时 pattern 被丢弃导致不同检索同键；
 *   - pwsh：split(/[|;&]/)+首词把同脚本不同 -Filter/参数并成一键（事故 §3.1 六笔
 *     误杀主因），改为脚本体规范化哈希 + 保留管道首段 head 语义；
 *   - Windows 路径（C:/x、D:\x）会被 new URL 解析成 scheme=c:、origin 恒 "null"、
 *     跨盘符归一成同键——非 URL（无 scheme://）一律不走 URL 分支。
 * @param {string} name 工具名
 * @param {unknown} args 工具参数（对象或 JSON 字符串）
 * @returns {string}
 */
function targetKey(name, args) {
	let a = args;
	if (typeof a === "string") {
		try { a = JSON.parse(a); } catch { a = {}; }
	}
	a = a && typeof a === "object" ? a : {};

	// 逐工具取参（per-tool param picking）。
	let raw;
	if (name === "grep") {
		const pattern = typeof a.pattern === "string" ? a.pattern : "";
		const path = a.path == null ? "" : String(a.path);
		// 带 path：pattern + path 都进键体；无 path：pattern 即目标。
		// 分隔符用 `::`（而非 \n）：\n 会被下方 replace(/\s+/g," ") 塌成空格，
		// 致 pattern 与 path 不可分（pattern="a b" 与 path 组合可碰撞）。
		raw = path ? `${pattern}::${path}` : pattern;
	} else if (name === "read") {
		// 分页键：offset/limit 决定读的是文件的哪一段（limit 缺省视为读到底）。
		const offset = Number.isFinite(Number(a.offset)) ? Number(a.offset) : 0;
		const limit = a.limit == null ? "" : String(a.limit);
		raw = `${a.file_path ?? a.path ?? ""}::@${offset}:${limit}`;
	} else if (name === "pwsh" || name === "bash" || name === "sh") {
		raw = a.command == null ? "" : String(a.command);
	} else {
		raw = String(
			a.file_path ?? a.path ?? a.url ?? a.command ?? a.pattern ?? a.script ??
			a.query ?? a.name ?? ""
		);
	}

	let key;
	if (name === "pwsh" || name === "bash" || name === "sh") {
		key = normalizeCommandKey(raw);
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		// 仅真 URL（scheme://）走 URL 分支去 query；Windows 盘符（C:/…）不满足该形状。
		try {
			const u = new URL(raw);
			key = u.origin + u.pathname; // URL 去 query
		} catch {
			key = raw.replace(/\s+/g, " ").trim();
		}
	} else {
		key = raw.replace(/\s+/g, " ").trim();
	}
	// P0/P1-14：保留完整归一键体，禁止再截断。旧实现 `cmdHead` 只留首段
	// 可打印字符，把 `#hash`/`@offset:limit` 全砍掉 —— 不同 offset/grep
	// pattern/pwsh -Filter 被并成同键（事故误杀主因，评估 §3.1）。
	// 空格塌缩已在上方分支完成；此处整体小写后作为键，head 仅作可读前缀。
	const head = (key.match(/^([A-Za-z0-9_.\\/-]+)/) || [])[1] || "";
	const digest = fnv1aHex(key);
	return `${name}::${head}#${digest}`.toLowerCase();
}

/**
 * 命令类（pwsh/bash/sh）目标键归一：保留"管道首段 head"语义（换管道后缀仍算
 * 同一目标），但整段脚本参数全部进键——同脚本不同 -Filter/参数 = 不同键。
 * 旧实现 split(/[|;&])[0] + 只取首词，把所有参数丢进同一个键（事故误杀主因）。
 * @param {string} raw 原始命令串
 * @returns {string}
 */
function normalizeCommandKey(raw) {
	const collapsed = String(raw).replace(/\s+/g, " ").trim();
	const firstSegment = collapsed.split(/[|;&]/)[0].trim().replace(/^(?:"|')|(?:"|')$/g, "").trim();
	// head = 首段去掉开头的调用算子/引号后的可读首词（保持旧键的可读前缀）。
	const head = (firstSegment.match(/^(?:[>&;]*\s*)*([A-Za-z0-9_.\\/-]+)/) || [])[1] || firstSegment.slice(0, 40);
	// 语料 = 首段全部参数（含 -Filter 等命名参数）+ 被切断的后续段（||、; 分隔的
	// 第二条命令也算同一目标的"换方法"变体，整串进哈希）。
	const corpus = firstSegment;
	const digest = fnv1aHex(corpus);
	return `${head}#${digest}`;
}

/** FNV-1a 32 位哈希（命令语料指纹；确定性、无依赖）。 */
function fnv1aHex(text) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * 失败签名：只认结构化错误。isError===true 或存在 error 对象才算失败；
 * 错误码只从 error.code / error.info.code 取。绝不扫成功结果全文——
 * 正文含 "401"/"not found" 但 isError=false 的成功结果不得判失败（P0-4）。
 * @param {unknown} result 工具返回
 * @returns {{error:boolean, code:string}}
 */
function failureSignature(result) {
	if (!result) return { error: false, code: "" };
	const r = typeof result === "object" ? result : { content: String(result) };
	if (r.isError === true) return { error: true, code: structuredErrorCode(r.error) };
	if (r.error) return { error: true, code: structuredErrorCode(r.error) };
	return { error: false, code: "" };
}

/** 错误码只从 error.code / error.info.code 结构化取值；缺失回退 "error"。 */
function structuredErrorCode(error) {
	if (error && typeof error === "object") {
		if (typeof error.code === "string" && error.code) return error.code;
		const infoCode = error.info?.code;
		if (typeof infoCode === "string" && infoCode) return infoCode;
	}
	return "error";
}

/**
 * 结果是否为本插件自阻断（G2-B 自我强化排除）。
 * 真实事件契约（亲验）：
 *   - dsh-tools/lib/index.js:3241-3263 deny 后构造 {isError:true, error:{message, info:denialErrorInfo}}；
 *   - agent-loop lib/index.js:763-779 appendToolResult 把 result.error.info 提升为
 *     tool/result 事件 data 的顶层 error（`...result.error?.info ? {error: result.error.info}`）；
 *   - message 本体（dsh-llm lib/types/message.js:92-100）只有 role/source.callId/toolCallId/
 *     content/isError，没有 error/info 字段。
 * 故 deny 标记位于「事件 data 顶层」而非 message 内。旧实现读 d.message.error?.info 恒 undefined，
 * 自我强化熔断链自 fccaa12 起从未生效（评估报告 §3.2）。
 * @param {unknown} data tool/result 事件的 data（整个事件 data，不是 d.message）
 * @returns {boolean}
 */
function isSelfDenialResult(data) {
	if (!data || typeof data !== "object") return false;
	const d = data;
	// 顶层 error = agent-loop 从 result.error.info 提升的 deny 载荷：
	//   形状 {message, info:{plugin,rule,...}}，plugin 在 error.info.plugin；
	//   兼容少数旧版本把整个 info 平铺在 error 顶层（error.plugin）。
	// 不读 message 层：真实 message（dsh-llm message.js:92-100）没有 error/info，
	// 历史 bug 即读 message 层导致恒 false；负对照即验证此行为。
	const info = d?.error?.info ?? d?.error;
	return info?.plugin === PLUGIN_ID;
}

// ── 纯逻辑：结论指纹 ─────────────────────────────────────────────────────
/**
 * 对一段推理取稳定指纹：取规范化后的前 48 个字母数字字符。
 * @param {string} reasoning
 * @returns {string}
 */
function reasoningFingerprint(reasoning) {
	if (typeof reasoning !== "string") return "";
	const norm = reasoning.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
	return norm.slice(0, 48);
}

// ── P1-15：语义指纹（分句 MinHash/Jaccard）─────────────────────────────
/**
 * 对 reasoning 做词级 N-gram shingle（窗口=3 词），每个 shingle 取固定种子 FNV-1a 哈希。
 * 相同文本 → 相同集合；共同前缀规避（事故 "Actually/Hmm 后实质不同"）会被
 * 词窗口差异拆开，集合相似度如实反映语义接近度而非前缀重合度。
 * @param {string} reasoning
 * @returns {Set<string>}
 */
function shingleSet(reasoning) {
	const set = new Set();
	if (typeof reasoning !== "string") return set;
	const norm = reasoning.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ");
	const words = norm.split(/\s+/).filter(Boolean);
	if (words.length === 0) return set;
	const N = 3;
	for (let i = 0; i + N <= words.length; i++) {
		set.add(fnv1aHex(words.slice(i, i + N).join("")));
	}
	return set;
}

/**
 * Jaccard 相似度（两 shingle 集合交集/并集）。
 * @param {Set<number>} a
 * @param {Set<number>} b
 * @returns {number}
 */
function jaccardSimilarity(a, b) {
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter += 1;
	return inter / (a.size + b.size - inter);
}

/** P1-15：语义指纹命中阈值——与库内已有指纹 Jaccard 超过该值即视为"同结论重现"。 */
const FINGERPRINT_JACCARD_MIN = 0.8;

// ── 纯逻辑：per-session 状态机 ───────────────────────────────────────────
function createSessionState() {
	return {
		turn: 0,
		stepInTurn: 0,
		globalStepSeq: 0,            // 会话级 step 边界计数（ttl/pending 的时间轴）
		lastBoundaryKey: "",         // (turn,step) 去重键：step/start 与 pre-step 只计一次
		lastSettledStep: 0,          // 已结算的最后一个 turn 内步号（两入口结算幂等）
		consecutiveZero: 0,          // G1-A（连续硬零推进）
		recentSteps: [],             // G1-A 近 N 步滑窗：[{successfulTool, reasoningLen}]（P1-15 覆盖隔步空转）
		fingerprintSteps: new Map(), // fp|s:* -> Set(step)  G1-B（前缀指纹桶 / 语义 shingle 桶）
		fingerprintShingles: new Map(), // s:* 桶键 -> shingle Set（P1-15 语义指纹比对源）
		currentTurnChangedFiles: false,
		toolTargets: new Map(),      // key -> {calls, consecutiveFail}  G2
		pendingKeyByStep: new Map(), // step -> targetKey（tool/call→tool/result 关联）
		stepHadSuccess: new Map(),   // step -> 是否出现过成功工具结果
		categoryDenials: [],         // semantic-stall-2：[{evidenceSeq,ttlSteps,expiresAtStep,category}]
		pendingReject: null,         // semantic-stall 待消费项 {evidenceSeq,reason,code,source}
		lastEscalatedTurn: null,     // soft-cut 抑制升级每 turn 至多一次（null=尚未升级）
		lastActiveAt: Date.now(),    // 上次活跃时间戳（P2-24 LRU 活跃判断）
		watchdog: { eventsSinceHeartbeat: 0, alerted: false } // P2-24 会话级看门狗
	};
}

function blocksOf(message) {
	const c = message?.content;
	return Array.isArray(c) ? c : [];
}

/**
 * 推进会话级 step 边界计数。step/start 事件与 agent/pre-step 钩子会对同一
 * 边界各触发一次，用 (turn,step) 键去重；缺编号时按“每次调用即新边界”计。
 */
function advanceStepBoundary(state, turn, step) {
	if (typeof turn === "number" && typeof step === "number") {
		const key = `${turn}:${step}`;
		if (key !== state.lastBoundaryKey) {
			state.lastBoundaryKey = key;
			state.globalStepSeq += 1;
		}
	} else {
		state.globalStepSeq += 1;
	}
	return state.globalStepSeq;
}

/**
 * 处理一次会话事件，推进状态机。
 * @param {object} state
 * @param {object} event 形如 {type, data}
 */
function noteEvent(state, event) {
	if (!state || !event || !event.type) return state;
	const d = event.data || {};
	switch (event.type) {
		case "turn/start":
			state.turn = d.turn ?? state.turn + 1;
			state.stepInTurn = 0;
			state.lastSettledStep = 0;
			state.currentTurnChangedFiles = false;
			// P1-17：G1 连续零推进/指纹重现账目按 turn 清零——旧账不跨 turn
			// 带入（评估报告 §3.1/img 误杀根因之一：上一 turn 的累计在下一 turn
			// 继续滚，加上重启词规避指纹，导致非空转会话被 G1-B 拦下）。
			// 选择"重置"而非"保留跨 turn"：空转治理按 turn 口径对齐；若需跨 turn
			// 累积语义，另开配置开关。
			state.consecutiveZero = 0;
			state.fingerprintSteps.clear();
			state.recentSteps = []; // P1-15 滑窗同口径：账目不跨 turn 带入
			break;
		case "step/start": {
			// 结算上一步（幂等且顺序安全，见 settleLastStep）。
			settleLastStep(state, typeof d.step === "number" ? d.step : state.stepInTurn + 1);
			advanceStepBoundary(state, d.turn, d.step);
			state.stepInTurn = d.step ?? state.stepInTurn + 1;
			state.stepHadText = false;
			state.stepReasoning = "";
			state.stepChangedFile = false;
			break;
		}
		case "turn/end":
			// turn 结束（正常/blocked/aborted）清除未消费 pending 项（计划书 §2.2）。
			state.pendingReject = null;
			break;
		case "assistant/message": {
			for (const b of blocksOf(d.message)) {
				if (b.type === "text" && typeof b.text === "string" && b.text.trim()) state.stepHadText = true;
				if (b.type === "reasoning" && typeof b.text === "string" && b.text.length > (state.stepReasoning?.length || 0)) {
					state.stepReasoning = b.text;
				}
			}
			break;
		}
		case "tool/call": {
			// 仅建立 callId→目标键 映射供结果关联；调用计数由 pre-execute 钩子
			// 在放行时维护，避免钩子与事件两条路径重复计数。
			const key = targetKey(d.name, d.arguments);
			state.pendingKeyByStep.set(d.callId ?? `${d.step}:${key}`, key);
			break;
		}
		case "tool/result": {
			// callId 真实形状（dsh-llm lib/types/message.js:92-100）：message 无顶层
			// callId，标识在 source.callId 与 toolCallId。旧实现 d.message?.callId 恒
			// undefined → pendingKeyByStep 永不命中、永不删除（评估报告 §3.3）。
			const msg = d.message;
			const callId = msg?.source?.callId ?? msg?.toolCallId ?? msg?.callId;
			let key = callId != null ? state.pendingKeyByStep.get(callId) : null;
			if (callId != null) state.pendingKeyByStep.delete(callId);
			if (key == null) {
				const keys = [...state.pendingKeyByStep.values()];
				key = keys.length ? keys[keys.length - 1] : null;
			}
			const err = failureSignature(msg);
			if (d.step != null) state.stepHadSuccess.set(d.step, !err.error);
			// G2-B 自我强化排除：governor 自己 deny 产生的错误结果既不计入
			// 连续失败也不清零（跳过维护，绝不自证循环）。deny 标记在事件 data
			// 顶层 error（见 isSelfDenialResult 文档），故传整个事件 data。
			if (isSelfDenialResult(d)) break;
			if (key) {
				const rec = state.toolTargets.get(key) || { calls: 0, consecutiveFail: 0, recentCalls: [] };
				rec.consecutiveFail = err.error ? rec.consecutiveFail + 1 : 0;
				// P1-18：G2-A 恢复靠滑窗（recentCalls 按 globalStepSeq 滚动，
				// 见 evaluateG2），此处只维护连续失败计数 G2-B；不再硬清零 calls。
				state.toolTargets.set(key, rec);
			}
			break;
		}
		case "workspace/changes":
		case "file/change":
			state.currentTurnChangedFiles = true;
			state.stepChangedFile = true;
			state.consecutiveZero = 0;
			state.fingerprintSteps.clear();
			break;
		case "user/message":
			// 真实用户介入重置全部计数并清除 pending（插件 spliced 注入不算）。
			if (d.source?.kind === "user") {
				state.consecutiveZero = 0;
				state.fingerprintSteps.clear();
				for (const v of state.toolTargets.values()) v.consecutiveFail = 0;
				state.pendingReject = null;
			}
			break;
		default:
			break;
	}
	return state;
}

/**
 * 记录一次助手步骤结束后的"是否有推进"，供 G1-A/G1-B 判定。
 * @param {object} state
 * @param {object} stepInfo {{step:number, hasText:boolean, reasoning:string, successfulTool:boolean, fileChange:boolean}}
 */
function noteAssistantStep(state, stepInfo) {
	const progressed = stepInfo.hasText || stepInfo.successfulTool || stepInfo.fileChange;
	state.consecutiveZero = progressed ? 0 : state.consecutiveZero + 1;

	// P1-15：G1-A 近 N 步滑窗（覆盖隔步空转：单步看似有 reasoning 但整体失能）。
	state.recentSteps.push({ successfulTool: stepInfo.successfulTool === true, reasoningLen: (stepInfo.reasoning || "").length });
	if (state.recentSteps.length > CONFIG.g1aWindowSize) state.recentSteps.shift();

	// P1-15：语义指纹——先用 shingle 集做 Jaccard 命中（抗共同前缀规避），
	// 未命中任何既有桶再回退到原前缀指纹桶计数（兼容既有记录与负例语义）。
	const shingles = shingleSet(stepInfo.reasoning || "");
	const fp = reasoningFingerprint(stepInfo.reasoning || "");
	let fpSteps = 0;
	if (!stepInfo.fileChange) {
		// 阶段一：语义相似（Jaccard≥阈值）的文本归入同一"结论重现"桶。
		let bucketKey = null;
		if (shingles.size > 0) {
			for (const existing of state.fingerprintSteps.keys()) {
				if (existing.startsWith("s:")) {
					const j = jaccardSimilarity(shingles, state.fingerprintShingles?.get(existing) || new Set());
					if (j >= FINGERPRINT_JACCARD_MIN) { bucketKey = existing; break; }
				}
			}
			if (!bucketKey) {
				// 新语义桶键：s:<首个 shingle 哈希>（与既有 "fp" 前缀桶区分）。
				bucketKey = "s:" + ([...shingles][0] || "0");
				if (!state.fingerprintShingles.has(bucketKey)) state.fingerprintShingles.set(bucketKey, shingles);
			}
		} else if (fp) {
			// 阶段二：无可分句 → 回退原前缀指纹（如旧记录继续可命中）。
			bucketKey = fp;
		}
		if (bucketKey) {
			if (!state.fingerprintSteps.has(bucketKey)) state.fingerprintSteps.set(bucketKey, new Set());
			state.fingerprintSteps.get(bucketKey).add(stepInfo.step);
			fpSteps = state.fingerprintSteps.get(bucketKey).size;
		}
	}
	return {
		g1a: state.consecutiveZero >= CONFIG.g1aZeroSteps,
		g1b: fpSteps >= CONFIG.g1bFingerprintSteps,
		fingerprint: fp,
		fpSteps,
		consecutiveZero: state.consecutiveZero
	};
}

/**
 * 结算"最后一步"（幂等且顺序安全）：把最后一个已开始且未结算的步的交付
 * 证据交给 noteAssistantStep。beforeStep = 即将开始的步号——只结算严格早于
 * 它的步：pre-step(S) 先到时结算 S-1（第 S-1 步已完整结束）；step/start(S)
 * 先到时它已结算过 S-1，pre-step(S) 不得提前结算第 S 步（结果未到）。
 */
function settleLastStep(state, beforeStep) {
	const target = state.stepInTurn;
	const isNewBoundary = typeof beforeStep === "number" ? target < beforeStep : true;
	if (target > 0 && isNewBoundary && target > state.lastSettledStep) {
		// P1-18：stepHadSuccess 只在结算当步读取一次，读取后即删，
		// 避免 Map 随会话总步数单调增长（长跑后无界，评估报告 P1-18）。
		const hadSuccess = state.stepHadSuccess.get(target);
		if (state.stepHadSuccess.has(target)) state.stepHadSuccess.delete(target);
		noteAssistantStep(state, {
			step: target,
			hasText: state.stepHadText === true,
			reasoning: state.stepReasoning || "",
			successfulTool: hadSuccess === true,
			fileChange: state.stepChangedFile === true
		});
		state.lastSettledStep = target;
	}
}

/** G1 规则 → 冻结阻断码。 */
function g1Code(rule) {
	if (rule === "G1-A") return BLOCK_CODES.G1_A;
	if (rule === "G1-B") return BLOCK_CODES.G1_B;
	if (rule === "G1-C") return BLOCK_CODES.G1_C;
	throw new Error(`unknown G1 rule ${rule}`);
}

/**
 * G1 判定（pre-step 上依据当前计数）。
 * @param {object} state
 * @returns {{hit:boolean, rule:string|null, detail:object}}
 */
function evaluateG1(state) {
	if (state.stepInTurn + 1 >= CONFIG.g1cMaxStepsPerTurn) {
		return { hit: true, rule: "G1-C", detail: { nextStep: state.stepInTurn + 1, max: CONFIG.g1cMaxStepsPerTurn } };
	}
	if (state.consecutiveZero >= CONFIG.g1aZeroSteps) {
		return { hit: true, rule: "G1-A", detail: { consecutiveZero: state.consecutiveZero, n: CONFIG.g1aZeroSteps } };
	}
	// P1-15：G1-A 近 N 步滑窗双判据（覆盖事故 step28-30 隔步空转）。
	// 窗内成功工具占比≤阈值 且 reasoning 总字数<阈值 → 判滑窗失速。
	if (state.recentSteps.length >= CONFIG.g1aWindowSize) {
		const win = state.recentSteps.slice(-CONFIG.g1aWindowSize);
		const successCount = win.filter((s) => s.successfulTool).length;
		const successRatio = successCount / win.length;
		const reasoningChars = win.reduce((a, s) => a + s.reasoningLen, 0);
		if (successRatio <= CONFIG.g1aSuccessRatioMax && reasoningChars < CONFIG.g1aReasoningMin) {
			return { hit: true, rule: "G1-A", detail: { windowN: win.length, successRatio: +successRatio.toFixed(2), reasoningChars, maxRatio: CONFIG.g1aSuccessRatioMax, minReasoning: CONFIG.g1aReasoningMin } };
		}
	}
	if (!state.currentTurnChangedFiles) {
		for (const [fp, steps] of state.fingerprintSteps) {
			if (steps.size >= CONFIG.g1bFingerprintSteps) {
				return { hit: true, rule: "G1-B", detail: { fpSteps: steps.size, k: CONFIG.g1bFingerprintSteps, fingerprint: fp.slice(0, 16) } };
			}
		}
	}
	return { hit: false, rule: null, detail: {} };
}

/**
 * G2 判定（pre-execute 上，先于真实执行计数）。
 * @param {object} state
 * @param {string} key
 * @returns {{hit:boolean, rule:string|null, detail:object}}
 */
function evaluateG2(state, key) {
	const rec = state.toolTargets.get(key) || { calls: 0, consecutiveFail: 0, recentCalls: [] };
	// P1-18：G2-A 改滑窗语义（评估报告 §3.1 事故根因：同目标调用计数永久
	// 累加、无成功出口）。以会话级 globalStepSeq 为时间轴，仅统计滑窗内
	// （最近 g1aWindowSize 步）的同键放行调用；滑出窗自然衰减，成功结果
	// 不硬清零（窗滚动即恢复），避免 g2aSameTargetCalls 后永久拦截。
	const window = Math.max(1, CONFIG.g1aWindowSize);
	const win = (rec.recentCalls || []).filter((s) => state.globalStepSeq - s < window);
	rec.recentCalls = win;
	const inWindow = win.length;
	const willBeCalls = inWindow + 1;
	if (rec.consecutiveFail >= CONFIG.g2bConsecutiveFailures) {
		return { hit: true, rule: "G2-B", detail: { consecutiveFail: rec.consecutiveFail, f: CONFIG.g2bConsecutiveFailures, key } };
	}
	if (willBeCalls > CONFIG.g2aSameTargetCalls) {
		return { hit: true, rule: "G2-A", detail: { calls: inWindow, willBe: willBeCalls, m: CONFIG.g2aSameTargetCalls, window, key } };
	}
	return { hit: false, rule: null, detail: { calls: inWindow, willBe: willBeCalls, window, key } };
}

// ── 对 C 的依赖挂起登记（依赖未落地时如实记录，不伪造通过）────────────────
const PENDING_DEPENDENCIES = [
	{
		item: "7/watchdog-outbound",
		dependsOn: "子卡 C 的出站告警服务 API",
		reason: "心跳静默检测已实现；出站通道待 C 发布 API 后接线（届时探测 ctx.semanticWatcher.alert，现仅结构化日志告警）"
	},
	{
		item: "7/heartbeat-event-name",
		dependsOn: "子卡 C 的心跳事件名",
		reason: "按计划书 §5.8 默认订阅 semantic-watcher/heartbeat，待 C 确认实际事件名"
	},
	{
		item: "5/softcut-suppressed-payload",
		dependsOn: "子卡 C 的 agent/soft-cut-suppressed 载荷契约",
		reason: "防御式读取 cutClass/sessionId/turn/step；高置信类=pseudoTool|confirmed-repeat（cot-anchor 移植段三类预算口径）"
	}
];

/** 工具名 → 类别（未知工具返回 null）。 */
function toolCategory(name) {
	return CATEGORY_BY_TOOL.get(name) ?? null;
}

// ── 插件装配 ─────────────────────────────────────────────────────────────
const inject = ["webServer"];

/** soft-cut 抑制升级视作的高置信类（cot-anchor 移植段三类预算口径）。 */
const SOFTCUT_HIGH_CONFIDENCE = new Set(["pseudoTool", "confirmed-repeat", "confirmedRepeat"]);
const WATCHDOG_HEARTBEAT_EVENT = "semantic-watcher/heartbeat";
const WATCHDOG_MAX_SILENT_EVENTS = 60;   // 两次心跳之间最多容忍的会话事件数
const WATCHDOG_MAX_SILENT_MS = 120_000;  // worker 承诺每分钟心跳；2 倍宽限

function apply(ctx) {
	// 每次装配先从 env 重置启动初值（防重复装配污染；off 仍完全不装配）。
	resetConfigFromEnv();
	if (CONFIG.mode === "off") return;
	const states = new Map();
	function stateFor(session) {
		return stateForId(session?.id || "_");
	}
	function stateForId(id) {
		let s = states.get(id);
		if (!s) {
			if (states.size >= CONFIG.maxSessions) evictLeastActive();
			s = createSessionState();
			states.set(id, s);
		}
		touchActivity(s);
		return s;
	}
	// P2-24：LRU 按"最近活跃"而非"创建顺序"淘汰；活跃即会话收到过事件。
	function touchActivity(s) {
		s.lastActiveAt = Date.now();
	}
	function evictLeastActive() {
		let victim = null;
		for (const [id, s] of states) {
			if (!victim || s.lastActiveAt < victim.s.lastActiveAt) victim = { id, s };
		}
		if (victim) states.delete(victim.id);
	}
	function log(payload) {
		logStatic({ mode: CONFIG.mode, ...payload });
	}
	function emit(name, payload) {
		try { ctx.emit?.(name, payload); } catch (e) { log({ at: "emit-error", event: name, error: String(e?.message || e) }); }
	}

	// ── 设置：env 启动初值（resetConfigFromEnv 已重置）→ 持久化覆盖（§9.3）──
	const settingsPath = process.env.DSH_GOVERNOR_SETTINGS_PATH
		|| join(homedir(), ".dsh", "storages", SETTINGS_FILE);
	let persistedOk = true;
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (parsed && typeof parsed === "object") applySettings(parsed);
		else throw new Error("settings file is not an object");
	} catch (e) {
		persistedOk = false;
		if (e?.code !== "ENOENT") log({ at: "settings-corrupt", fallback: "defaults+env", error: String(e?.message || e) });
	}
	function savePersistedSettings(value) {
		try {
			mkdirSync(join(settingsPath, ".."), { recursive: true });
			writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
			return true;
		} catch (error) {
			log({ at: "settings-save-error", error: String(error?.message || error) });
			return false;
		}
	}

	// ── ctx.provide：计划书 §2.2 两服务（watcher 经 ctx.get("stepGovernor")）─
	const services = {
		/**
		 * stall-2：按类别禁用工具（计划书 §2.2(1)）。
		 * @param {string} sessionId 会话 id
		 * @param {string} category 首期枚举 read|grep
		 * @param {{reason?:string, code?:string, evidenceSeq:number, ttlSteps:number}} opts
		 * @returns {{accepted:boolean, expiresAtStep?:number, reason?:string}}
		 */
		denyToolCategory(sessionId, category, opts) {
			try {
				const o = opts && typeof opts === "object" ? opts : {};
				const code = typeof o.code === "string" && o.code ? o.code : BLOCK_CODES.STALL_2;
				if (code !== BLOCK_CODES.STALL_2) {
					return { accepted: false, reason: `code 必须为 ${BLOCK_CODES.STALL_2}（冻结枚举），收到 ${code}` };
				}
				if (FORBIDDEN_RETRY_CODES.has(code)) return { accepted: false, reason: "阻断码禁止使用可重试码" };
				if (typeof sessionId !== "string" || !sessionId) return { accepted: false, reason: "sessionId 缺失" };
				if (!DENY_CATEGORIES.has(category)) return { accepted: false, reason: `未知类别 ${String(category)}，首期枚举 read|grep` };
				const evidenceSeq = Number(o.evidenceSeq);
				const ttlSteps = Number(o.ttlSteps);
				if (!Number.isSafeInteger(evidenceSeq) || evidenceSeq < 0) return { accepted: false, reason: "evidenceSeq 必须为非负整数" };
				if (!Number.isSafeInteger(ttlSteps) || ttlSteps < 1) return { accepted: false, reason: "ttlSteps 必须为正整数（会话内 step seq 增量）" };
				const state = stateForId(sessionId);
				// 幂等键 (sessionId, evidenceSeq, code)：重复调用不刷新 ttl、不重复 deny/发事件。
				const existing = state.categoryDenials.find((d) => d.evidenceSeq === evidenceSeq);
				if (existing) {
					if (!existing.categories.has(category)) existing.categories.add(category);
					return { accepted: true, expiresAtStep: existing.expiresAtStep };
				}
				// 解除谓词：currentStepSeq > evidenceSeq + ttlSteps（严格大于）。
				const expiresAtStep = evidenceSeq + ttlSteps;
				state.categoryDenials.push({ evidenceSeq, ttlSteps, expiresAtStep, category, categories: new Set([category]), reason: String(o.reason ?? "") });
				emit("governor/category-denied", {
					sessionId, code: BLOCK_CODES.STALL_2, category,
					evidenceSeq, ttlSteps, expiresAtStep
				});
				log({ at: "category-denied", sessionId, category, evidenceSeq, expiresAtStep });
				return { accepted: true, expiresAtStep };
			} catch (e) {
				log({ at: "denyToolCategory-error", failOpen: true, error: String(e?.message || e) });
				return { accepted: false, reason: String(e?.message || e) };
			}
		},
		/**
		 * stall-3：语义终判 reject（计划书 §2.2(2)）。pending 项在本 turn 下一个
		 * pre-step 边界消费；turn 结束（含 blocked/aborted）或真人消息清除。
		 * @param {string} sessionId
		 * @param {{reason?:string, code?:string, evidenceSeq:number}} opts
		 * @returns {{accepted:boolean, pending:boolean, reason?:string}}
		 */
		rejectStep(sessionId, opts) {
			try {
				const o = opts && typeof opts === "object" ? opts : {};
				const code = typeof o.code === "string" && o.code ? o.code : BLOCK_CODES.STALL_3;
				if (code !== BLOCK_CODES.STALL_3) {
					return { accepted: false, pending: false, reason: `code 必须为 ${BLOCK_CODES.STALL_3}（冻结枚举、不可重试），收到 ${code}` };
				}
				if (typeof sessionId !== "string" || !sessionId) return { accepted: false, pending: false, reason: "sessionId 缺失" };
				const evidenceSeq = Number(o.evidenceSeq);
				if (!Number.isSafeInteger(evidenceSeq) || evidenceSeq < 0) return { accepted: false, pending: false, reason: "evidenceSeq 必须为非负整数" };
				const state = stateForId(sessionId);
				// 幂等键 (sessionId, evidenceSeq)：重复调用合并为同一 pending 项。
				if (state.pendingReject && state.pendingReject.evidenceSeq === evidenceSeq) {
					return { accepted: true, pending: true };
				}
				state.pendingReject = { evidenceSeq, reason: String(o.reason ?? "语义停滞（L3 终判）"), code, source: "watcher" };
				log({ at: "reject-step-queued", sessionId, evidenceSeq });
				return { accepted: true, pending: true };
			} catch (e) {
				log({ at: "rejectStep-error", failOpen: true, error: String(e?.message || e) });
				return { accepted: false, pending: false, reason: String(e?.message || e) };
			}
		}
	};
	if (typeof ctx.provide === "function") ctx.provide("stepGovernor", services);

	// ── 事件观测 ───────────────────────────────────────────────────────────
	ctx.on("session/event", (session, event) => {
		try {
			const state = stateFor(session);
			if (event?.type === "step/start") {
				// 心跳看门狗：会话仍在推进而心跳静默超限 → 告警（§10.2 第 7 条）。
				watchdogCheck(session?.id || "_");
			}
			noteEvent(state, event);
		} catch (e) { log({ at: "session/event", error: String(e?.message || e) }); }
	});

	// ── tools/pre-execute：G2 支线熔断 + stall-2 类别 deny ─────────────────
	ctx.on("tools/pre-execute", async (exec, next) => {
		try {
			const state = stateFor(exec.agent?.session);
			
			// (1) semantic-stall-2 类别 deny（L3 显式服务；先于机械 G2）。
			const category = toolCategory(exec.name);
			if (category) {
				let deny2 = null;
				for (const d of state.categoryDenials) {
					if (state.globalStepSeq > d.expiresAtStep) continue; // 严格大于解除
					if (!d.categories.has(category)) continue;
					deny2 = deny2 && deny2.expiresAtStep >= d.expiresAtStep ? deny2 : d;
				}
				if (deny2) {
					log({ at: "pre-execute", action: "deny", code: BLOCK_CODES.STALL_2, category, evidenceSeq: deny2.evidenceSeq, expiresAtStep: deny2.expiresAtStep, stepSeq: state.globalStepSeq });
					return {
						kind: "deny",
						reason: `[${PLUGIN_ID}] semantic-stall-2: 类别 ${category} 已被语义监视者临时禁用至 step ${deny2.expiresAtStep}（当前 ${state.globalStepSeq}），目标类别: ${category}。请改用其他取证类别或直接推进任务完成交付；如需继续调用 ${category}，先向用户说明现状并取得确认`,
						code: BLOCK_CODES.STALL_2,
						evidenceSeq: deny2.evidenceSeq,
						info: { plugin: PLUGIN_ID, rule: "stall-2", category, code: BLOCK_CODES.STALL_2, evidenceSeq: deny2.evidenceSeq }
					};
				}
			}
			// (2) 机械 G2 判定。
			const key = targetKey(exec.name, exec.arguments);
			const verdict = evaluateG2(state, key);
			if (verdict.hit) {
				log({ at: "pre-execute", action: enforces(verdict.rule) ? "deny" : "shadow", rule: verdict.rule, ...verdict.detail });
				if (enforces(verdict.rule)) {
					const code = verdict.rule === "G2-B" ? BLOCK_CODES.G2_B : BLOCK_CODES.G2_A;
					// P1-16：deny 文案三要素 = 归一化目标键 + 计数口径 + 合法继续出口。
					const scope = verdict.rule === "G2-B" ? "该目标已连续失败" : "该目标近窗已尝试";
					const targetShown = key.length > 120 ? key.slice(0, 120) + "…" : key;
					return {
						kind: "deny",
						reason: `[${PLUGIN_ID}] ${verdict.rule}: ${scope} ${verdict.rule === "G2-B"
							? `${verdict.detail.consecutiveFail} 次（阈值 ${CONFIG.g2bConsecutiveFailures}）`
							: `${verdict.detail.calls} 次（阈值 ${CONFIG.g2aSameTargetCalls}，每次确认为放行才计数）`}；目标键: ${targetShown}。请更换命令/参数、改用其他工具或类别，或向用户汇报当前进展后由用户决定下一步`,
						code,
						evidenceSeq: state.globalStepSeq,
						info: { plugin: PLUGIN_ID, rule: verdict.rule, code, evidenceSeq: state.globalStepSeq, key, calls: verdict.detail.calls, consecutiveFail: verdict.detail.consecutiveFail }
					};
				}
			}
			const decision = await next();
			// 真实放行（含 shadow）才计一次调用；deny 不计。consecutiveFail 由
			// tool/result 事件按结果维护（自阻断结果已排除，见 noteEvent）。
			if (!decision || decision.kind !== "deny") {
				const rec = state.toolTargets.get(key) || { calls: 0, consecutiveFail: 0, recentCalls: [] };
				rec.recentCalls.push(state.globalStepSeq); // G2-A 滑窗在 pre 放行时记录同键调用时刻
				rec.calls = rec.recentCalls.length;
				state.toolTargets.set(key, rec);
			}
			return decision;
		} catch (e) {
			log({ at: "pre-execute", failOpen: true, error: String(e?.message || e) });
			return next();
		}
	});

	// ── agent/pre-step：G1 步级熔断 + stall-3 pending 消费 ─────────────────
	ctx.on("agent/pre-step", async (payload, next) => {
		try {
			const state = stateFor(payload.agent?.session);
			// pre-step(S) 边界：第 S-1 步已完整结束（工具结果已到），先结算再判定；
			// 同时推进会话级 step seq（与 step/start 事件按 (turn,step) 去重）。
			settleLastStep(state, typeof payload.step === "number" ? payload.step : state.stepInTurn + 1);
			advanceStepBoundary(state, payload.turn ?? state.turn, payload.step);
			// (1) semantic-stall pending 消费（L3 显式服务；先于机械 G1）。
			if (state.pendingReject) {
				const p = state.pendingReject;
				state.pendingReject = null;
				emit("governor/step-rejected", {
					sessionId: payload.agent?.session?.id ?? "_",
					code: p.code, evidenceSeq: p.evidenceSeq,
					consumedAtStep: state.globalStepSeq, source: p.source
				});
				log({ at: "pre-step", action: "reject", code: p.code, evidenceSeq: p.evidenceSeq, consumedAtStep: state.globalStepSeq });
				return {
					kind: "reject",
					reason: `[${PLUGIN_ID}] ${p.code}: ${p.reason}（语义终判，不可重试，需人工/语义介入）`,
					code: p.code,
					evidenceSeq: p.evidenceSeq,
					autoResume: { max: 0, switchAction: false } // semantic-stall 不走 G1 续跑
				};
			}
			// (2) 机械 G1 判定（结构化载荷：冻结码 + autoResume 策略，§9.4）。
			const verdict = evaluateG1(state);
			if (verdict.hit) {
				log({ at: "pre-step", action: enforces(verdict.rule) ? "reject" : "shadow", rule: verdict.rule, ...verdict.detail });
				if (enforces(verdict.rule)) {
					// P1-16：reject 文案三要素 = 触发规则与计数口径 + 当前步序 + 合法继续出口。
					const ruleText = verdict.rule === "G1-A"
						? `连续 ${verdict.detail.consecutiveZero} 步无交付（阈值 ${CONFIG.g1aZeroSteps}）`
						: verdict.rule === "G1-B"
							? `同一结论指纹跨 ${verdict.detail.fpSteps} 步重现（阈值 ${CONFIG.g1bFingerprintSteps}）`
							: `单回合步数 ${verdict.detail.nextStep} 达硬顶 ${verdict.detail.max}`;
					return {
						kind: "reject",
						reason: `[${PLUGIN_ID}] ${verdict.rule}: ${ruleText}（当前第 ${state.globalStepSeq} 步）。请更换动作类别、基于已有成果总结并上报用户，由用户确认后重新定向`,
						code: g1Code(verdict.rule),
						evidenceSeq: state.globalStepSeq,
						autoResume: { max: CONFIG.g1MaxAutoResume, switchAction: CONFIG.g1AutoResumeSwitchAction }
					};
				}
			}
			return next();
		} catch (e) {
			log({ at: "pre-step", failOpen: true, error: String(e?.message || e) });
			return next();
		}
	});

	// ── soft-cut 预算抑制升级（设计 §10.2 第 4 条）────────────────────────
	// C（内核移植段）对每次被预算抑制的 soft-cut ignore 发
	// agent/soft-cut-suppressed；高置信类（pseudoTool/confirmed-repeat）被抑制
	// 意味着模型重复已远超任何机械阈值——升级为终止 turn：在本 turn 下一个
	// pre-step 边界以 g1b-fingerprint-repeat 码 reject（同一 turn 至多升级一次）。
	ctx.on("agent/soft-cut-suppressed", (payload) => {
		try {
			const cls = String(payload?.cutClass ?? "");
			if (!SOFTCUT_HIGH_CONFIDENCE.has(cls)) return; // 启发式类被预算抑制属设计内
			const session = payload?.session ?? { id: String(payload?.sessionId ?? "_") };
			const state = stateFor(session);
			const turnNow = typeof payload?.turn === "number" ? payload.turn : state.turn;
			if (state.pendingReject || state.lastEscalatedTurn === turnNow) return;
			state.lastEscalatedTurn = turnNow;
			state.pendingReject = {
				evidenceSeq: state.globalStepSeq,
				reason: `soft-cut 高置信切断（${cls}）被预算抑制，重复退化仍在继续`,
				code: BLOCK_CODES.G1_B,
				source: "soft-cut-suppressed"
			};
			log({ at: "softcut-escalate", sessionId: session.id, cutClass: cls, evidenceSeq: state.globalStepSeq, turn: turnNow });
		} catch (e) {
			log({ at: "softcut-suppressed-error", failOpen: true, error: String(e?.message || e) });
		}
	});

	// ── watcher 心跳看门狗（设计 §10.2 第 7 条）────────────────────────────
	// worker 每分钟（或每 5 个事件）发心跳标量（§5.8）。会话持续推进而心跳
	// 静默超限 → 对该会话告警一次（直到下个心跳复位）。心跳本身是全局标量
	// （worker 全局状态），但 eventsSinceHeartbeat/alerted 是每会话的（P2-24：
	// 原装配级闭包单例会让一个活跃会话的心跳静默连累全部会话）。
	let watchdogLastHeartbeatAt = 0;
	ctx.on(WATCHDOG_HEARTBEAT_EVENT, () => {
		watchdogLastHeartbeatAt = Date.now();
		for (const s of states.values()) {
			s.watchdog.eventsSinceHeartbeat = 0;
			s.watchdog.alerted = false;
		}
	});
	function watchdogCheck(sessionId) {
		const state = stateForId(sessionId);
		const wd = state.watchdog;
		wd.eventsSinceHeartbeat += 1;
		if (watchdogLastHeartbeatAt === 0) return;            // 尚未见心跳：watcher 可能未安装，不告警
		if (wd.alerted) return;                               // 已告警待复位
		const silentFor = Date.now() - watchdogLastHeartbeatAt;
		if (wd.eventsSinceHeartbeat < WATCHDOG_MAX_SILENT_EVENTS && silentFor < WATCHDOG_MAX_SILENT_MS) return;
		wd.alerted = true;
		const alert = { at: "watchdog-alert", sessionId, silentForMs: silentFor, eventsSinceHeartbeat: wd.eventsSinceHeartbeat, heartbeatEvent: WATCHDOG_HEARTBEAT_EVENT };
		const outbound = ctx.semanticWatcher;
		if (outbound && typeof outbound.alert === "function") {
			try { outbound.alert({ kind: "watchdog-heartbeat-silent", ...alert }); return; } catch { /* 落日志 */ }
		}
		log(alert);
	}

	// ── 设置路由（参照 cot-anchor：kind:"exact"，GET/POST）────────────────
	const webServer = ctx.webServer;
	if (webServer && typeof webServer.register === "function") {
		webServer.register({
			kind: "exact",
			path: SETTINGS_ROUTE,
			async handler(req, res) {
				try {
					if (req.method === "GET") {
						sendJson(res, 200, {
							ok: true,
							schema: SETTINGS_SCHEMA,
							settings: settingsSnapshot(),
							defaults: SETTINGS_DEFAULTS,
							persisted: persistedOk,
							pendingDependencies: PENDING_DEPENDENCIES
						});
						return;
					}
					if (req.method === "POST") {
						const body = await readRequestBody(req);
						const patch = body && typeof body.settings === "object" ? body.settings : body;
						const nextSettings = applySettings(patch ?? {});
						const saved = savePersistedSettings(nextSettings);
						sendJson(res, 200, { ok: true, settings: nextSettings, saved });
						return;
					}
					sendJson(res, 405, { ok: false, error: "method not allowed" });
				} catch (error) {
					sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
				}
			}
		});
	} else {
		log({ at: "webserver-missing", warn: "设置路由未注册：宿主未提供 webServer 服务" });
	}

	log({
		at: "loaded",
		thresholds: { G1A: CONFIG.g1aZeroSteps, G1B: CONFIG.g1bFingerprintSteps, G1C: CONFIG.g1cMaxStepsPerTurn, G2A: CONFIG.g2aSameTargetCalls, G2B: CONFIG.g2bConsecutiveFailures },
		autoResume: { max: CONFIG.g1MaxAutoResume, switchAction: CONFIG.g1AutoResumeSwitchAction },
		pendingDependencies: PENDING_DEPENDENCIES.length
	});
}

// ── 设置路由 HTTP 助手（与 cot-anchor 同构）──────────────────────────────
function sendJson(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}
function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try { resolve(JSON.parse(body || "{}")); }
			catch (error) { reject(error); }
		});
		req.on("error", reject);
	});
}

const name = PLUGIN_ID;

export {
	name, inject, apply,
	createSessionState, noteEvent, noteAssistantStep, evaluateG1, evaluateG2,
	targetKey, failureSignature, reasoningFingerprint, shingleSet, jaccardSimilarity,
	isSelfDenialResult,
	advanceStepBoundary, toolCategory, applySettings, settingsSnapshot,
	BLOCK_CODES, CATEGORY_BY_TOOL, DENY_CATEGORIES, SETTINGS_SCHEMA, SETTINGS_DEFAULTS,
	PENDING_DEPENDENCIES, CONFIG
};
