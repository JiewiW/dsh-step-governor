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
		hint: "灰度顺序 g2b→g2→g1g2；off 完全透传，shadow 永不拦截。" },
	{ key: "g1aZeroSteps", label: "G1-A 连续无交付步数", type: "number", min: 2, max: 20, group: "G1 阈值" },
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
/** 运行时配置：由 resetConfigFromEnv()/applySettings() 原地更新，钩子与纯函数全部直读本对象。 */
const CONFIG = {};
/**
 * 从 env 重置 CONFIG 为启动初值（每次 apply() 开头调用）：
 * env=启动初值、设置卡=运行期覆盖；重复装配（测试/多实例）互不污染。
 */
function resetConfigFromEnv() {
	CONFIG.mode = (process.env.DSH_GOVERNOR_MODE || "shadow").toLowerCase();
	if (!MODES.includes(CONFIG.mode)) CONFIG.mode = "shadow";
	CONFIG.g1aZeroSteps = intEnv("DSH_GOVERNOR_G1A_N", SETTINGS_DEFAULTS.g1aZeroSteps);
	CONFIG.g1bFingerprintSteps = intEnv("DSH_GOVERNOR_G1B_K", SETTINGS_DEFAULTS.g1bFingerprintSteps);
	CONFIG.g1cMaxStepsPerTurn = intEnv("DSH_GOVERNOR_G1C_MAX", SETTINGS_DEFAULTS.g1cMaxStepsPerTurn);
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
			if (spec.options.includes(next)) CONFIG[key] = next;
			else warn.push(`${key} 非法值 ${JSON.stringify(v)} 回退 ${CONFIG[key]}`);
		} else if (spec.type === "boolean") {
			if (typeof v === "boolean") CONFIG[key] = v;
			else warn.push(`${key} 非布尔回退 ${CONFIG[key]}`);
		} else if (key === "notifyChannels") {
			const list = Array.isArray(v) ? v.filter((c) => NOTIFY_CHANNELS.has(c)) : [];
			if (list.length > 0) CONFIG[key] = [...new Set(list)];
			else warn.push(`${key} 非法回退默认`);
		} else {
			const n = Math.round(Number(v));
			if (Number.isFinite(n)) CONFIG[key] = Math.min(spec.max, Math.max(spec.min, n));
			else warn.push(`${key} 非数值回退 ${CONFIG[key]}`);
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
	const raw = String(
		a.file_path ?? a.path ?? a.url ?? a.command ?? a.pattern ?? a.script ??
		a.query ?? a.name ?? ""
	);
	let key = raw;
	try {
		const u = new URL(raw);
		key = u.origin + u.pathname; // URL 去 query
	} catch {
		key = raw
			.replace(/\s+/g, " ")
			.split(/[|;&]/)[0]                       // 管道/串联只取首段
			.replace(/^(?:"|')|(?:"|')$/g, "")
			.trim();
	}
	const cmdHead = key.match(/^([A-Za-z0-9_.\\/-]+)/);
	return `${name}::${cmdHead ? cmdHead[1] : key.slice(0, 80)}`.toLowerCase();
}

/**
 * 失败签名：工具结果是否为错误，以及可归类的错误码。
 * @param {unknown} result 工具返回
 * @returns {{error:boolean, code:string}}
 */
function failureSignature(result) {
	if (!result) return { error: false, code: "" };
	const r = typeof result === "object" ? result : { content: String(result) };
	if (r.isError === true || r.error) return { error: true, code: r.error?.code || "error" };
	const text = (() => { try { return JSON.stringify(r); } catch { return String(result); } })();
	if (/\b(401|403)\b/.test(text)) return { error: true, code: /401/.test(text) ? "401" : "403" };
	if (/command not found|cannot find|not recognized/i.test(text)) return { error: true, code: "not-found" };
	return { error: false, code: "" };
}

/**
 * 结果是否为本插件自阻断（G2-B 自我强化排除）。
 * 内核把 pre-execute deny 的 info 透传到 tool/result 的 error.info
 * （dsh-tools/lib/index.js:3241-3256，`...{ info: denialInfo }`），
 * 据此识别 governor 自己 deny 产生的错误结果，跳过 consecutiveFail 维护。
 * @param {unknown} message tool/result 的 message
 * @returns {boolean}
 */
function isSelfDenialResult(message) {
	if (!message || typeof message !== "object") return false;
	const info = message.error?.info ?? message.info;
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

// ── 纯逻辑：per-session 状态机 ───────────────────────────────────────────
function createSessionState() {
	return {
		turn: 0,
		stepInTurn: 0,
		globalStepSeq: 0,            // 会话级 step 边界计数（ttl/pending 的时间轴）
		lastBoundaryKey: "",         // (turn,step) 去重键：step/start 与 pre-step 只计一次
		lastSettledStep: 0,          // 已结算的最后一个 turn 内步号（两入口结算幂等）
		consecutiveZero: 0,          // G1-A
		fingerprintSteps: new Map(), // fp -> Set(step)  G1-B
		currentTurnChangedFiles: false,
		toolTargets: new Map(),      // key -> {calls, consecutiveFail}  G2
		pendingKeyByStep: new Map(), // step -> targetKey（tool/call→tool/result 关联）
		stepHadSuccess: new Map(),   // step -> 是否出现过成功工具结果
		categoryDenials: [],         // semantic-stall-2：[{evidenceSeq,ttlSteps,expiresAtStep,category}]
		pendingReject: null,         // semantic-stall 待消费项 {evidenceSeq,reason,code,source}
		lastEscalatedTurn: null      // soft-cut 抑制升级每 turn 至多一次（null=尚未升级）
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
			const callId = d.message?.callId;
			let key = callId != null ? state.pendingKeyByStep.get(callId) : null;
			if (callId != null) state.pendingKeyByStep.delete(callId);
			if (key == null) {
				const keys = [...state.pendingKeyByStep.values()];
				key = keys.length ? keys[keys.length - 1] : null;
			}
			const err = failureSignature(d.message);
			if (d.step != null) state.stepHadSuccess.set(d.step, !err.error);
			// G2-B 自我强化排除：governor 自己 deny 产生的错误结果既不计入
			// 连续失败也不清零（跳过维护，绝不自证循环）。内核透传证据：
			// dsh-tools/lib/index.js:3241-3256 error.info = deny 载荷 info。
			if (isSelfDenialResult(d.message)) break;
			if (key) {
				const rec = state.toolTargets.get(key) || { calls: 0, consecutiveFail: 0 };
				rec.consecutiveFail = err.error ? rec.consecutiveFail + 1 : 0;
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

	const fp = reasoningFingerprint(stepInfo.reasoning || "");
	let fpSteps = 0;
	if (fp && !stepInfo.fileChange) {
		if (!state.fingerprintSteps.has(fp)) state.fingerprintSteps.set(fp, new Set());
		state.fingerprintSteps.get(fp).add(stepInfo.step);
		fpSteps = state.fingerprintSteps.get(fp).size;
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
		noteAssistantStep(state, {
			step: target,
			hasText: state.stepHadText === true,
			reasoning: state.stepReasoning || "",
			successfulTool: state.stepHadSuccess.get(target) === true,
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
	const rec = state.toolTargets.get(key) || { calls: 0, consecutiveFail: 0 };
	const willBeCalls = rec.calls + 1;
	if (rec.consecutiveFail >= CONFIG.g2bConsecutiveFailures) {
		return { hit: true, rule: "G2-B", detail: { consecutiveFail: rec.consecutiveFail, f: CONFIG.g2bConsecutiveFailures, key } };
	}
	if (willBeCalls > CONFIG.g2aSameTargetCalls) {
		return { hit: true, rule: "G2-A", detail: { calls: willBeCalls, m: CONFIG.g2aSameTargetCalls, key } };
	}
	return { hit: false, rule: null, detail: { calls: willBeCalls, key } };
}

/** 真实放行后提交调用计数，并据结果更新连续失败。 */
function commitCall(state, key, result) {
	const rec = state.toolTargets.get(key) || { calls: 0, consecutiveFail: 0 };
	rec.calls += 1;
	rec.consecutiveFail = failureSignature(result).error ? rec.consecutiveFail + 1 : 0;
	state.toolTargets.set(key, rec);
	return rec;
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
		if (!states.has(id)) {
			if (states.size >= CONFIG.maxSessions) states.delete(states.keys().next().value);
			states.set(id, createSessionState());
		}
		return states.get(id);
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
						reason: `[${PLUGIN_ID}] semantic-stall-2: 类别 ${category} 已被语义监视者临时禁用至 step ${deny2.expiresAtStep}（当前 ${state.globalStepSeq}），请改用其他取证方式或推进任务`,
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
					return {
						kind: "deny",
						reason: `[${PLUGIN_ID}] ${verdict.rule}: ${verdict.rule === "G2-B"
							? `该目标已连续失败 ${verdict.detail.consecutiveFail} 次，禁止同路径重试，请换方法或上报用户`
							: `该目标已尝试 ${verdict.detail.calls} 次，禁止再试，请换方法或上报用户`}`,
						code,
						evidenceSeq: state.globalStepSeq,
						info: { plugin: PLUGIN_ID, rule: verdict.rule, code, evidenceSeq: state.globalStepSeq }
					};
				}
			}
			const decision = await next();
			// 真实放行（含 shadow）才计一次调用；deny 不计。consecutiveFail 由
			// tool/result 事件按结果维护（自阻断结果已排除，见 noteEvent）。
			if (!decision || decision.kind !== "deny") {
				const rec = state.toolTargets.get(key) || { calls: 0, consecutiveFail: 0 };
				rec.calls += 1;
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
					return {
						kind: "reject",
						reason: `[${PLUGIN_ID}] ${verdict.rule}: ${
							verdict.rule === "G1-A" ? `连续 ${verdict.detail.consecutiveZero} 步无交付`
							: verdict.rule === "G1-B" ? `同一结论指纹跨 ${verdict.detail.fpSteps} 步重现`
							: `单回合步数 ${verdict.detail.nextStep} 达硬顶 ${verdict.detail.max}`}，请更换动作类别或收敛上报`,
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
	// 静默超限 → 告警一次（直到下个心跳复位）。出站通道依赖 C 的 API（挂起
	// 登记 PENDING_DEPENDENCIES），当前以结构化日志告警 + 探测 ctx 出站服务。
	const watchdog = { lastHeartbeatAt: 0, eventsSinceHeartbeat: 0, alerted: false };
	ctx.on(WATCHDOG_HEARTBEAT_EVENT, () => {
		try {
			watchdog.lastHeartbeatAt = Date.now();
			watchdog.eventsSinceHeartbeat = 0;
			watchdog.alerted = false;
		} catch { /* ignore */ }
	});
	function watchdogCheck(sessionId) {
		try {
			watchdog.eventsSinceHeartbeat += 1;
			if (watchdog.lastHeartbeatAt === 0) return;            // 尚未见心跳：watcher 可能未安装，不告警
			if (watchdog.alerted) return;                          // 已告警待复位
			const silentFor = Date.now() - watchdog.lastHeartbeatAt;
			if (watchdog.eventsSinceHeartbeat < WATCHDOG_MAX_SILENT_EVENTS && silentFor < WATCHDOG_MAX_SILENT_MS) return;
			watchdog.alerted = true;
			const alert = { at: "watchdog-alert", sessionId, silentForMs: silentFor, eventsSinceHeartbeat: watchdog.eventsSinceHeartbeat, heartbeatEvent: WATCHDOG_HEARTBEAT_EVENT };
			const outbound = ctx.semanticWatcher;
			if (outbound && typeof outbound.alert === "function") {
				try { outbound.alert({ kind: "watchdog-heartbeat-silent", ...alert }); return; } catch { /* 落日志 */ }
			}
			log(alert);
		} catch (e) {
			log({ at: "watchdog-error", error: String(e?.message || e) });
		}
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
	createSessionState, noteEvent, noteAssistantStep, evaluateG1, evaluateG2, commitCall,
	targetKey, failureSignature, reasoningFingerprint, isSelfDenialResult,
	advanceStepBoundary, toolCategory, applySettings, settingsSnapshot,
	BLOCK_CODES, CATEGORY_BY_TOOL, DENY_CATEGORIES, SETTINGS_SCHEMA, SETTINGS_DEFAULTS,
	PENDING_DEPENDENCIES, CONFIG
};
