// 载荷冻结码 / G2-B 自我强化排除 / 心跳看门狗。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DSH_GOVERNOR_SETTINGS_PATH = join(tmpdir(), `gov-pl-${process.pid}-${Date.now()}.json`);
const { apply, createSessionState, noteEvent, evaluateG2, targetKey, BLOCK_CODES, isSelfDenialResult } = await import("../lib/index.js");

/** 真实 tool/result 形状（dsh-llm lib/types/message.js:92-100 + agent-loop :763-779）：
 *  callId 在 message.source.callId / message.toolCallId；deny 标记在事件 data 顶层 error。 */
function realResult(callId, extra = {}) {
	return { message: { role: "tool", source: { kind: "tool", callId }, toolCallId: callId, ...extra } };
}

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
	// 2026-10-17 根治静默中断：首次命中改为"软停"——投递收尾指令让模型自己总结结束，
	// 不再把 turn 直接掐成 {"kind":"blocked"}。
	assert.notEqual(d?.kind, "reject", "首次命中不得直接终止 turn");
	assert.equal(d?.kind, "enter");
	const notice = (d?.messages ?? []).find((m) => JSON.stringify(m).includes("收尾边界"));
	assert.ok(notice, "软停必须向模型投递可见的收尾指令");
	// 同一 turn 再命中（模型无视指令仍在调工具）才硬拦，并保留冻结码。
	const d2 = await ctx.emit("agent/pre-step", { turn: 1, step: 4, agent: { session: s } });
	assert.equal(d2?.kind, "reject");
	assert.equal(d2?.code, "g1a-zero-delivery");
	assert.deepEqual(d2?.autoResume, { max: 3, switchAction: true });
	assert.equal(typeof d2?.evidenceSeq, "number");
	assert.ok(typeof d2?.reason === "string" && d2.reason.length > 0);
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
	assert.notEqual(d?.kind, "reject", "G1-C 首次命中同样先软停");
	const d2 = await ctx.emit("agent/pre-step", { turn: 1, step: 4, agent: { session: s } });
	assert.equal(d2?.kind, "reject");
	assert.equal(d2?.code, "g1c-turn-limit");
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
	// 两次真实失败（isError=true）经事件路径计数：pre-execute（+calls）→ tool/result（consecutiveFail）
	for (const [callId, seq] of [["f1", 1], ["f2", 2]]) {
		noteEvent(s, { type: "tool/call", data: { callId, ...RK } });
		const rec = s.toolTargets.get(key) || { calls: 0, consecutiveFail: 0 };
		rec.calls += 1; // 等价于 pre-execute 对放行调用的计数
		s.toolTargets.set(key, rec);
		noteEvent(s, { type: "tool/result", data: realResult(callId, { isError: true, content: `Error: ${seq}` }) });
	}
	noteEvent(s, { type: "tool/call", data: { callId: "x1", ...RK } });
	// 真实形状自阻断：deny 标记在事件 data 顶层 error（P0-5①）
	noteEvent(s, { type: "tool/result", data: { ...realResult("x1", { isError: true, content: "Error: denied" }), error: { message: "denied", info: { plugin: "dsh-step-governor", rule: "G2-B" } } } });
	assert.equal(evaluateG2(s, key).detail.consecutiveFail, 2, "自阻断不计 increment，也不清零");
	noteEvent(s, { type: "tool/call", data: { callId: "x2", ...RK } });
	noteEvent(s, { type: "tool/result", data: realResult("x2", { isError: true, content: "Error: real" }) });
	assert.equal(evaluateG2(s, key).detail.consecutiveFail, 3, "真实失败照常计数");

	// 错误形状负对照（P0-5③）：历史版本读 message 层，标记藏 message 内、data 无顶层 error → 必须认不出
	// （真实契约中 deny 标记只在 data 顶层 error —— 见 isSelfDenialResult 文档）
	assert.equal(isSelfDenialResult({ message: { role: "tool", source: { kind: "tool", callId: "n1" }, toolCallId: "n1", isError: true, error: { info: { plugin: "dsh-step-governor", rule: "G2-B" } } } }), false,
		"错误契约形状（标记在 message 内、data 无顶层 error）不得被识别为自我阻断");
	// 真实形状：标记在事件 data 顶层 error → 识别成功
	assert.equal(isSelfDenialResult({ ...realResult("n2", { isError: true }), error: { info: { plugin: "dsh-step-governor", rule: "G2-B" } } }), true,
		"真实形状（标记在 data 顶层 error）必须被识别");

	// 钩子路径：g2b 模式下 2 次真实失败 → deny；自阻断结果到达后再次发起仍 deny（未被 reset）
	process.env.DSH_GOVERNOR_MODE = "g2b";
	const ctx = createCtx(); apply(ctx);
	const sess = { id: "pg5" };
	const KEY2 = { name: "pwsh", arguments: { command: "node fail.js" } };
	const ev = (type, data) => ctx.emit("session/event", sess, { type, data });
	for (const callId of ["c1", "c2"]) {
		await ev("tool/call", { callId, ...KEY2 });
		await ctx.emit("tools/pre-execute", { ...KEY2, agent: { session: sess } });
		await ev("tool/result", realResult(callId, { isError: true, content: "Error: boom" }));
	}
	assert.equal((await ctx.emit("tools/pre-execute", { ...KEY2, agent: { session: sess } }))?.code, "g2b-consecutive-failure");
	await ev("tool/result", { ...realResult("c3", { isError: true, content: "Error: denied" }), error: { message: "denied", info: { plugin: "dsh-step-governor", rule: "G2-B" } } });
	assert.equal((await ctx.emit("tools/pre-execute", { ...KEY2, agent: { session: sess } }))?.code, "g2b-consecutive-failure", "自阻断未 reset，继续 deny");
	ctx.restore();
	delete process.env.DSH_GOVERNOR_MODE;
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

test("看门狗 GUI 渠道：告警经只读路由暴露，心跳复位后清除", async () => {
	process.env.DSH_GOVERNOR_MODE = "shadow";
	const ctx = createCtx();
	const regs = [];
	ctx.webServer = { register: (r) => regs.push(r) };
	apply(ctx);
	const wdRoute = regs.find((r) => r.path === "/plugins/step-governor/watchdog");
	assert.ok(wdRoute, "看门狗路由应已注册");
	const call = async () => {
		const res = { status: 0, body: "" };
		res.writeHead = (s) => { res.status = s; };
		res.end = (b) => { res.body = b || ""; };
		await wdRoute.handler({ method: "GET" }, res);
		return JSON.parse(res.body);
	};
	// 未见心跳且仍在启动宽限内：不告警，路由返回空
	assert.equal((await call()).alert, null, "宽限期内不应有告警");
	await ctx.emit("semantic-watcher/heartbeat", { worker: "w1" });
	const s = { id: "pg8" };
	for (let i = 1; i <= 60; i++) {
		await ctx.emit("session/event", s, { type: "step/start", data: { turn: 1, step: i } });
	}
	const hit = await call();
	assert.ok(hit.alert, "静默超限后路由应返回告警");
	assert.equal(hit.alert.sessionId, "pg8");
	assert.equal(hit.alert.heartbeatEvent, "semantic-watcher/heartbeat");
	// 心跳恢复 → 告警清除
	await ctx.emit("semantic-watcher/heartbeat", { worker: "w1" });
	assert.equal((await call()).alert, null, "心跳恢复后告警应清除");
	ctx.restore();
});

test("看门狗启动检测：宽限内不告警，超宽限无心跳则判 watcher 未运行", async () => {
	process.env.DSH_GOVERNOR_MODE = "shadow";
	// 把宽限压到 0，模拟「已过宽限期仍无任何心跳」。
	process.env.DSH_GOVERNOR_WATCHDOG_GRACE_MS = "0";
	const ctx = createCtx();
	const regs = [];
	ctx.webServer = { register: (r) => regs.push(r) };
	apply(ctx);
	const wdRoute = regs.find((r) => r.path === "/plugins/step-governor/watchdog");
	const call = async () => {
		const res = { status: 0, body: "" };
		res.writeHead = (s) => { res.status = s; };
		res.end = (b) => { res.body = b || ""; };
		await wdRoute.handler({ method: "GET" }, res);
		return JSON.parse(res.body);
	};
	const s = { id: "pg9" };
	// 宽限为 0：首个会话事件即应触发启动检测告警。
	await ctx.emit("session/event", s, { type: "step/start", data: { turn: 1, step: 1 } });
	const hit = await call();
	assert.ok(hit.alert, "超宽限且无心跳应告警");
	assert.equal(hit.alert.kind, "watchdog-watcher-absent", "告警类型为 watcher 未运行");
	assert.equal(hit.alert.sessionId, "pg9");
	// 后续事件不重复告警（已告警待复位）
	await ctx.emit("session/event", s, { type: "step/start", data: { turn: 1, step: 2 } });
	assert.equal((await call()).alert.kind, "watchdog-watcher-absent", "告警保持");
	// 心跳到达 → 启动检测告警清除，转入静默检测
	await ctx.emit("semantic-watcher/heartbeat", { worker: "w1" });
	assert.equal((await call()).alert, null, "心跳到达后告警应清除");
	delete process.env.DSH_GOVERNOR_WATCHDOG_GRACE_MS;
	ctx.restore();
});

test("看门狗双通道：derive-watcher 经 session/event 落盘的心跳也能复位告警", async () => {
	process.env.DSH_GOVERNOR_MODE = "shadow";
	process.env.DSH_GOVERNOR_WATCHDOG_GRACE_MS = "0";
	const ctx = createCtx();
	const regs = [];
	ctx.webServer = { register: (r) => regs.push(r) };
	apply(ctx);
	const wdRoute = regs.find((r) => r.path === "/plugins/step-governor/watchdog");
	const call = async () => {
		const res = { status: 0, body: "" };
		res.writeHead = (s) => { res.status = s; };
		res.end = (b) => { res.body = b || ""; };
		await wdRoute.handler({ method: "GET" }, res);
		return JSON.parse(res.body);
	};
	const s = { id: "pg-dual-channel" };
	// 宽限 0 + 无心跳：首个会话事件触发 watcher-absent 告警。
	await ctx.emit("session/event", s, { type: "step/start", data: { turn: 1, step: 1 } });
	assert.equal((await call()).alert.kind, "watchdog-watcher-absent", "无心跳应先告警");
	// derive-watcher 的真实心跳路径：不走顶层 ctx.emit，而是经 session/event 落盘事件广播。
	// 这正是线上误报的成因——本用例确保这条通道也能复位看门狗。
	await ctx.emit("session/event", s, { type: "semantic-watcher/heartbeat", data: { worker: "w1" } });
	const cleared = await call();
	assert.equal(cleared.alert, null, "经 session/event 落盘的心跳应清除告警");
	assert.ok(cleared.lastHeartbeatAt > 0, "lastHeartbeatAt 应被记录");
	delete process.env.DSH_GOVERNOR_WATCHDOG_GRACE_MS;
	ctx.restore();
});
