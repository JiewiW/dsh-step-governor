// 被 test-integration.mjs 在子进程调用：装载 apply() 到伪 ctx，
// 用真实事件序列驱动 G1/G2，输出钩子的实际决策。
// P0-6 隔离：强制独立临时 SETTINGS_PATH，禁止直读真实 storages json。
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.DSH_GOVERNOR_SETTINGS_PATH = process.env.DSH_GOVERNOR_SETTINGS_PATH
	|| join(tmpdir(), `gov-int-${process.pid}-${Date.now()}.json`);
const { apply } = await import("../lib/index.js");

const logs = [];
console.warn = (...args) => {
	const m = args.join(" ").match(/^\[dsh-step-governor\] (.*)$/);
	if (m) { try { logs.push(JSON.parse(m[1])); } catch {} }
};

function createCtx() {
	const handlers = new Map();
	return {
		on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
		async emit(name, ...callArgs) {
			const fns = handlers.get(name) || [];
			let idx = 0;
			const next = async () => { idx += 1; return idx >= fns.length ? undefined : fns[idx](...callArgs, next); };
			return fns.length ? fns[0](...callArgs, next) : undefined;
		}
	};
}

const ctx = createCtx();
apply(ctx);
const session = { id: "sess-smoke" };
const ev = (type, data) => ctx.emit("session/event", session, { type, data });
const KEY = { name: "pwsh", arguments: { command: "node always-fail.js" } };

// ── G2-B：两次失败调用，再发起第 3 次 ──
async function failedCall(n) {
	const callId = `c${n}`;
	await ev("tool/call", { step: n, callId, name: KEY.name, arguments: KEY.arguments });
	await ctx.emit("tools/pre-execute", { name: KEY.name, arguments: KEY.arguments, agent: { session } });
	await ev("tool/result", { step: n, message: { role: "tool", source: { kind: "tool", callId }, toolCallId: callId, isError: true, content: "Error: boom" } });
}
await failedCall(1);
await failedCall(2);
const g2d = await ctx.emit("tools/pre-execute", { name: KEY.name, arguments: KEY.arguments, agent: { session } });
const g2Decision = g2d?.kind === "deny" ? "deny" : "next";
const g2Reason = g2d?.reason || "";

// ── P1-20：终态提交工具连续两次真实失败后，第三次仍须放行 ──
// 这是 fusion 事故的最小复现：Worker 两次参数写错（区间超 80 行、区间条数超 12），
// 若治理器把第三、四、五次也拦掉，外部工作流永远收不到提交 → 判 Worker 不可用
// → 整个任务卡死。此处用真实事件序列驱动 pre-execute 钩子验证豁免生效。
const SUB = { name: "fusion_submit_result", arguments: { summary: "同一份审计报告", status: "completed", sources: [{ path: "a.js", startLine: 1, endLine: 10 }] } };
async function submitFailed(n) {
	const callId = `s${n}`;
	await ev("tool/call", { step: 10 + n, callId, name: SUB.name, arguments: SUB.arguments });
	await ctx.emit("tools/pre-execute", { name: SUB.name, arguments: SUB.arguments, agent: { session } });
	await ev("tool/result", { step: 10 + n, message: { role: "tool", source: { kind: "tool", callId }, toolCallId: callId, isError: true, content: "Error: Exploration source ranges require 1–80 lines each" } });
}
await submitFailed(1);
await submitFailed(2);
const subd = await ctx.emit("tools/pre-execute", { name: SUB.name, arguments: SUB.arguments, agent: { session } });
const submitDecision = subd?.kind === "deny" ? "deny" : "next";
const submitExemptLogged = logs.some((l) => l.action === "exempt" && l.terminalToolExempt === true);

// ── G1-A：构造连续零推进步（无 text、工具全失败、无文件变更）──
await ev("turn/start", { turn: 1 });
async function zeroStep(step, callId) {
	await ev("step/start", { turn: 1, step });
	await ev("assistant/message", { turn: 1, step, message: { content: [{ type: "reasoning", text: `thinking ${step}` }] } });
	await ev("tool/call", { turn: 1, step, callId, name: "read", arguments: { file_path: `/z/${step}.js` } });
	await ev("tool/result", { turn: 1, step, message: { role: "tool", source: { kind: "tool", callId }, toolCallId: callId, isError: true, content: "Error: 401" } });
}
// pre-step 钩子需要在每次 step/start 后征询；坏 payload 分支触发 fail-open。
let g1Decision = "next";
let g1SoftStopped = false;
const N = Number(process.env.DSH_GOVERNOR_G1A_N || 4);
if (process.env.GOVERNOR_BAD_PAYLOAD === "1") {
	// 坏 payload（null）使 handler 内取值抛错 → fail-open：当次必须放行。
	const d = await ctx.emit("agent/pre-step", null);
	g1Decision = d?.kind === "reject" ? "reject" : "next";
} else {
	// 软停语义（2026-10-17）：首次命中投递收尾指令（kind=enter + messages），
	// 模型若无视、同一 turn 再命中才硬拦。循环必须留出"第二次命中"的机会。
	for (let step = 1; step <= N + 3; step++) {
		const d = await ctx.emit("agent/pre-step", { turn: 1, step, agent: { session } });
		if (Array.isArray(d?.messages) && d.messages.length > 0) g1SoftStopped = true;
		if (d?.kind === "reject") { g1Decision = "reject"; break; }
		await zeroStep(step, `z${step}`);
	}
}

console.log(JSON.stringify({ loaded: logs.some((l) => l.at === "loaded"), g2Decision, g2Reason, submitDecision, submitExemptLogged, g1Decision, g1SoftStopped, logs }));
