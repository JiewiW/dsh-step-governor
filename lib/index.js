/**
 * dsh-step-governor — 确定性步数治理（实验插件，源自 governor-design-proposal）。
 *
 * 两个硬决策钩子（均为 waterfall，不改内核）：
 *   - agent/pre-step     → {kind:"reject"} 终止当前 turn（G1 步级熔断）
 *   - tools/pre-execute  → {kind:"deny"}   阻断单次工具调用（G2 支线熔断）
 *
 * 全部判据只用确定性信号（计数/指纹/错误签名），不调用 LLM 自评。
 * 组件自身任何异常一律 fail-open（放行），绝不阻断正常任务。
 *
 * 模式（env DSH_GOVERNOR_MODE，默认 shadow）：
 *   off   = 完全透传，不观测
 *   shadow= 观测+结构化日志，永不拦截
 *   g2b   = 仅 G2-B（连续失败）enforce
 *   g2    = G2-A + G2-B enforce，G1 仍影子
 *   g1g2  = G1 + G2 全部 enforce
 */

const PLUGIN_ID = "dsh-step-governor";

// ── 阈值（env 可覆盖；默认值为暂定，需影子期校准）─────────────────────────
function intEnv(name, fallback) {
	const raw = process.env[name];
	const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
const CONFIG = {
	mode: (process.env.DSH_GOVERNOR_MODE || "shadow").toLowerCase(),
	g1aZeroSteps: intEnv("DSH_GOVERNOR_G1A_N", 4),
	g1bFingerprintSteps: intEnv("DSH_GOVERNOR_G1B_K", 6),
	g1cMaxStepsPerTurn: intEnv("DSH_GOVERNOR_G1C_MAX", 60),
	g2aSameTargetCalls: intEnv("DSH_GOVERNOR_G2A_M", 3),
	g2bConsecutiveFailures: intEnv("DSH_GOVERNOR_G2B_F", 2),
	maxSessions: intEnv("DSH_GOVERNOR_MAX_SESSIONS", 200)
};
const MODES = ["off", "shadow", "g2b", "g2", "g1g2"];
if (!MODES.includes(CONFIG.mode)) CONFIG.mode = "shadow";
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

// ── 纯逻辑：结论指纹 ─────────────────────────────────────────────────────
/**
 * 对一段推理取稳定指纹：取规范化后的前 48 个字母数字字符。
 * 取整段开头而非单个名词，降低"引用共同前提"被误判为重推的概率。
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
		consecutiveZero: 0,          // G1-A
		fingerprintSteps: new Map(), // fp -> Set(step)  G1-B
		currentTurnChangedFiles: false,
		toolTargets: new Map(),      // key -> {calls, consecutiveFail}  G2
		pendingKeyByStep: new Map(), // step -> targetKey（tool/call→tool/result 关联）
		stepHadSuccess: new Map()    // step -> 是否出现过成功工具结果
	};
}

function blocksOf(message) {
	const c = message?.content;
	return Array.isArray(c) ? c : [];
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
			state.currentTurnChangedFiles = false;
			break;
		case "step/start": {
			// 结算上一步（首个 step 无需结算）：综合"有无 text 交付/成功工具/文件变更"。
			if (state.stepInTurn > 0) {
				const prev = state.stepInTurn;
				noteAssistantStep(state, {
					step: prev,
					hasText: state.stepHadText === true,
					reasoning: state.stepReasoning || "",
					successfulTool: state.stepHadSuccess.get(prev) === true,
					fileChange: state.stepChangedFile === true
				});
			}
			state.stepInTurn = d.step ?? state.stepInTurn + 1;
			state.stepHadText = false;
			state.stepReasoning = "";
			state.stepChangedFile = false;
			break;
		}
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
			if (key == null) {
				const keys = [...state.pendingKeyByStep.values()];
				key = keys.length ? keys[keys.length - 1] : null;
			}
			const err = failureSignature(d.message);
			if (d.step != null) state.stepHadSuccess.set(d.step, !err.error);
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
			// 真实用户介入重置全部计数；插件 spliced 注入（source.kind 非 user）不算。
			if (d.source?.kind === "user") {
				state.consecutiveZero = 0;
				state.fingerprintSteps.clear();
				for (const v of state.toolTargets.values()) v.consecutiveFail = 0;
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

// ── 插件装配 ─────────────────────────────────────────────────────────────
const inject = [];

function apply(ctx) {
	if (CONFIG.mode === "off") return;
	const states = new Map();
	function stateFor(session) {
		const id = session?.id || "_";
		if (!states.has(id)) {
			if (states.size >= CONFIG.maxSessions) states.delete(states.keys().next().value);
			states.set(id, createSessionState());
		}
		return states.get(id);
	}
	function log(payload) {
		try { console.warn(`[${PLUGIN_ID}] ${JSON.stringify({ mode: CONFIG.mode, ...payload })}`); } catch { /* ignore */ }
	}

	ctx.on("session/event", (session, event) => {
		try { noteEvent(stateFor(session), event); }
		catch (e) { log({ at: "session/event", error: String(e?.message || e) }); }
	});

	ctx.on("tools/pre-execute", async (exec, next) => {
		try {
			const state = stateFor(exec.agent?.session);
			const key = targetKey(exec.name, exec.arguments);
			const verdict = evaluateG2(state, key);
			if (verdict.hit) {
				log({ at: "pre-execute", action: enforces(verdict.rule) ? "deny" : "shadow", rule: verdict.rule, ...verdict.detail });
				if (enforces(verdict.rule)) {
					return {
						kind: "deny",
						reason: `[${PLUGIN_ID}] ${verdict.rule}: ${verdict.rule === "G2-B"
							? `该目标已连续失败 ${verdict.detail.consecutiveFail} 次，禁止同路径重试，请换方法或上报用户`
							: `该目标已尝试 ${verdict.detail.calls} 次，禁止再试，请换方法或上报用户`}`,
						info: { plugin: PLUGIN_ID, rule: verdict.rule }
					};
				}
			}
			const decision = await next();
			// 真实放行（含 shadow）才计一次调用；deny 不计。consecutiveFail 由
			// tool/result 事件按结果维护。
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

	ctx.on("agent/pre-step", async (payload, next) => {
		try {
			const state = stateFor(payload.agent?.session);
			if (typeof payload.step === "number") state.stepInTurn = payload.step;
			const verdict = evaluateG1(state);
			if (verdict.hit) {
				log({ at: "pre-step", action: enforces(verdict.rule) ? "reject" : "shadow", rule: verdict.rule, ...verdict.detail });
				if (enforces(verdict.rule)) return { kind: "reject" };
			}
			return next();
		} catch (e) {
			log({ at: "pre-step", failOpen: true, error: String(e?.message || e) });
			return next();
		}
	});

	log({ at: "loaded", thresholds: { G1A: CONFIG.g1aZeroSteps, G1B: CONFIG.g1bFingerprintSteps, G1C: CONFIG.g1cMaxStepsPerTurn, G2A: CONFIG.g2aSameTargetCalls, G2B: CONFIG.g2bConsecutiveFailures } });
}

const name = PLUGIN_ID;

export {
	name, inject, apply,
	createSessionState, noteEvent, noteAssistantStep, evaluateG1, evaluateG2, commitCall,
	targetKey, failureSignature, reasoningFingerprint, CONFIG
};
