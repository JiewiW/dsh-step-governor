// 载荷冻结码 / G2-B 自我强化排除 / soft-cut 抑制升级 / 心跳看门狗。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DSH_GOVERNOR_SETTINGS_PATH = join(tmpdir(), `gov-pl-${process.pid}-${Date.now()}.json`);
const { apply, createSessionState, noteEvent, commitCall, evaluateG2, targetKey, BLOCK_CODES } = await import("../lib/index.js");

function createCtx() {
	const handlers = new Map();
	const events = [];
	const logs = [];
	const origWarn = console.warn;
	console.warn = (...a) => {
		const m = a.join(" ").match(/^\[dsh-step-governor\] (.*)$/);
		if (m) { try { logs.push(JSON.parse(m[1])); } catch {} }
	};
	const restore = () => { console.warn = origWarn; };
	return {
		events, logs, restore,
		on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
		async emit(name, ...callArgs) {
			events.push(name);
			const fns = handlers.get(name) || [];
			let idx = 0;
			const next = async () => { idx += 1; return idx >= fns.length ? undefined : fns[idx](...callArgs, next); };
			return fns.length ? fns[0](...callArgs, next) : undefined;
		},
		provide() { /* 捕获服务不需要 */ }
	};
}
const FROZEN = ["g1a-zero-delivery", "g1b-fingerprint-repeat", "g1c-turn-limit",
	"g2a-same-target", "g2b-consecutive-failure", "semantic-stall-2", "semantic-stall", "no-progress"];

test("§5.8 冻结枚举码与 forbid 集合", () => {
	assert.deepEqual([...Object.values(BLOCK_CODES)].sort(), [...FROZEN].filter((c) => c !== "no-progress").sort());
});

test("G1-A reject 载荷：冻结码 + autoResume 默认 {max:3,switchAction:true}", async () => {
	process.env.DSH_GOVERNOR_MODE = "g1g2";
	process.env.DSH_GOVERNOR_G1A_N = "2";
	const ctx = createCtx(); apply(ctx);
	const s = { id: "pg1" };
	const ev = (type, data) => ctx.emit("session/event", s, { type, data });
	await ev("turn/start", { turn: 1 });
	await ev("step/start", { turn: 1, step: 1 });
	await ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "reasoning", text: "t1" }] } });
	await ev("tool/result", { step: 1, message: { callId: "a", isError: true, content: "Error: 401" } });
	assert.equal((await ctx.emit("agent/pre-step", { turn: 1, step: 2, agent: { session: s } }))?.kind, undefined, "第 1 步结算后未达 N");
	await ev("step/start", { turn: 1, step: 2 });
	await ev("assistant/message", { turn: 1, step: 2, message: { content: [{ type: "reasoning", text: "t2" }] } });
	await ev("tool/result", { step: 2, message: { callId: "b", isError: true, content: "Error: 401" } });
	const d = await ctx.emit("agent/pre-step", { turn: 1, step: 3, agent: { session: s } });
	assert.equal(d?.kind, "reject");
	assert.equal(d?.code, "g1a-zero-delivery");
	assert.deepEqual(d?.autoResume, { max: 3, switchAction: true });
	assert.equal(typeof d?.evidenceSeq, "number");
	assert.ok(typeof d?.reason === "string" && d.reason.length > 0);
	ctx.restore();
	delete process.env.DSH_GOVERNOR_G1A_N;
});

test("G1-C 冻结码 g1c-turn-limit", async () => {
	process.env.DSH_GOVERNOR_MODE = "g1g2";
	process.env.DSH_GOVERNOR_G1C_MAX = "3";
	const ctx = createCtx(); apply(ctx);
	const s = { id: "pg2" };
	const ev = (type, data) => ctx.emit("session/event", s, { type, data });
	await ev("turn/start", { turn: 1 });
	await ev("step/start", { turn: 1, step: 1 });
	await ev("step/start", { turn: 1, step: 2 });
	const d = await ctx.emit("agent/pre-step", { turn: 1, step: 3, agent: { session: s } });
	assert.equal(d?.kind, "reject");
	assert.equal(d?.code, "g1c-turn-limit");
	ctx.restore();
	delete process.env.DSH_GOVERNOR_G1C_MAX;
});

test("G2 deny 载荷：g2b-consecutive-failure / g2a-same-target + info.plugin 透传", async () => {
	process.env.DSH_GOVERNOR_MODE = "g1g2";
	const ctx = createCtx(); apply(ctx);
	const s = { id: "pg3" };
	const ev = (type, data) => ctx.emit("session/event", s, { type, data });
	const KEY = { name: "pwsh", arguments: { command: "node fail.js" } };
	for (const callId of ["c1", "c2"]) {
		await ev("tool/call", { callId, ...KEY });
		await ctx.emit("tools/pre-execute", { ...KEY, agent: { session: s } });
		await ev("tool/result", { message: { callId, isError: true, content: "Error: boom" } });
	}
	const d = await ctx.emit("tools/pre-execute", { ...KEY, agent: { session: s } });
	assert.equal(d?.kind, "deny");
	assert.equal(d?.code, "g2b-consecutive-failure");
	assert.equal(d?.info?.plugin, "dsh-step-governor", "deny info.plugin 供 result 侧自识别");
	assert.equal(typeof d?.evidenceSeq, "number");

	const s2 = { id: "pg4" };
	const RK = { name: "read", arguments: { file_path: "/same.js" } };
	for (let i = 1; i <= 3; i++) {
		await ev("tool/call", { callId: `r${i}`, ...RK });
		await ctx.emit("tools/pre-execute", { ...RK, agent: { session: s2 } });
		await ev("tool/result", { message: { callId: `r${i}`, content: "ok" } });
	}
	const d2 = await ctx.emit("tools/pre-execute", { ...RK, agent: { session: s2 } });
	assert.equal(d2?.kind, "deny");
	assert.equal(d2?.code, "g2a-same-target", "同目标第 4 次 G2-A deny");
	ctx.restore();
});

test("G2-B 自排除：自阻断结果不计 increment 也不 reset", async () => {
	// 纯逻辑：cf=2 后自阻断结果 → 仍 2（不 3 不 0）；真实失败 → 3
	const s = createSessionState();
	const key = targetKey("pwsh", { command: "node fail.js" }); // 与 tool/call 派生的目标键一致
	const RK = { name: "pwsh", arguments: { command: "node fail.js" } };
	commitCall(s, key, { isError: true });
	commitCall(s, key, { isError: true });
	noteEvent(s, { type: "tool/call", data: { callId: "x1", ...RK } });
	noteEvent(s, { type: "tool/result", data: { message: { callId: "x1", isError: true, error: { info: { plugin: "dsh-step-governor", rule: "G2-B" } } } } });
	assert.equal(evaluateG2(s, key).detail.consecutiveFail, 2, "自阻断不计 increment");
	noteEvent(s, { type: "tool/call", data: { callId: "x2", ...RK } });
	noteEvent(s, { type: "tool/result", data: { message: { callId: "x2", isError: true, content: "Error: real" } } });
	assert.equal(evaluateG2(s, key).detail.consecutiveFail, 3, "真实失败照常计数");

	// 钩子路径：g2b 模式下 2 次真实失败 → deny；自阻断结果到达后再次发起仍 deny（未被 reset）
	process.env.DSH_GOVERNOR_MODE = "g2b";
	const ctx = createCtx(); apply(ctx);
	const sess = { id: "pg5" };
	const KEY2 = { name: "pwsh", arguments: { command: "node fail.js" } };
	const ev = (type, data) => ctx.emit("session/event", sess, { type, data });
	for (const callId of ["c1", "c2"]) {
		await ev("tool/call", { callId, ...KEY2 });
		await ctx.emit("tools/pre-execute", { ...KEY2, agent: { session: sess } });
		await ev("tool/result", { message: { callId, isError: true, content: "Error: boom" } });
	}
	assert.equal((await ctx.emit("tools/pre-execute", { ...KEY2, agent: { session: sess } }))?.code, "g2b-consecutive-failure");
	await ev("tool/result", { message: { callId: "c3", isError: true, error: { info: { plugin: "dsh-step-governor", rule: "G2-B" } } } });
	assert.equal((await ctx.emit("tools/pre-execute", { ...KEY2, agent: { session: sess } }))?.code, "g2b-consecutive-failure", "自阻断未 reset，继续 deny");
	ctx.restore();
});

test("soft-cut 预算抑制升级：高置信类→下一边界 reject（g1b 码），每 turn 一次", async () => {
	process.env.DSH_GOVERNOR_MODE = "g1g2";
	const ctx = createCtx(); apply(ctx);
	const s = { id: "pg6" };
	await ctx.emit("agent/soft-cut-suppressed", { cutClass: "pseudoTool", session: s, turn: 1 });
	const d = await ctx.emit("agent/pre-step", { turn: 1, step: 1, agent: { session: s } });
	assert.equal(d?.kind, "reject", "高置信抑制升级为终止 turn");
	assert.equal(d?.code, "g1b-fingerprint-repeat");
	// 消费后同 turn 再次抑制：不重复升级
	await ctx.emit("agent/soft-cut-suppressed", { cutClass: "confirmed-repeat", session: s, turn: 1 });
	assert.equal((await ctx.emit("agent/pre-step", { turn: 1, step: 2, agent: { session: s } }))?.kind, undefined, "每 turn 至多升级一次");
	// 启发式类被抑制属设计内：不动作
	await ctx.emit("agent/soft-cut-suppressed", { cutClass: "length", session: s, turn: 2 });
	assert.equal((await ctx.emit("agent/pre-step", { turn: 2, step: 1, agent: { session: s } }))?.kind, undefined, "启发式类不升级");
	ctx.restore();
});

test("心跳看门狗：静默超限告警一次、出站服务优先、心跳复位", async () => {
	process.env.DSH_GOVERNOR_MODE = "shadow";
	const ctx = createCtx();
	ctx.semanticWatcher = { alerts: [], alert(p) { this.alerts.push(p); } };
	apply(ctx);
	await ctx.emit("semantic-watcher/heartbeat", { worker: "w1" });
	const s = { id: "pg7" };
	for (let i = 1; i <= 60; i++) {
		await ctx.emit("session/event", s, { type: "step/start", data: { turn: 1, step: i } });
	}
	assert.equal(ctx.semanticWatcher.alerts.length, 1, "静默超限告警一次");
	assert.equal(ctx.semanticWatcher.alerts[0]?.kind, "watchdog-heartbeat-silent");
	for (let i = 61; i <= 70; i++) {
		await ctx.emit("session/event", s, { type: "step/start", data: { turn: 1, step: i } });
	}
	assert.equal(ctx.semanticWatcher.alerts.length, 1, "已告警待复位不重复");
	await ctx.emit("semantic-watcher/heartbeat", { worker: "w1" });
	for (let i = 71; i <= 130; i++) {
		await ctx.emit("session/event", s, { type: "step/start", data: { turn: 1, step: i } });
	}
	assert.equal(ctx.semanticWatcher.alerts.length, 2, "心跳复位后可再告警");
	ctx.restore();
});
