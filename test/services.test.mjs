// 服务契约测试：denyToolCategory / rejectStep（计划书 §2.2 逐条）。
// 模式=shadow：显式服务调用即显式意图，shadow 亦生效（仅 off 不装配）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DSH_GOVERNOR_MODE = "shadow";
process.env.DSH_GOVERNOR_SETTINGS_PATH = join(tmpdir(), `gov-svc-${process.pid}-${Date.now()}.json`);
const { apply } = await import("../lib/index.js");

function createCtx() {
	const handlers = new Map();
	const provided = new Map();
	const events = [];
	return {
		provided, events,
		on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
		async emit(name, ...callArgs) {
			events.push(name);
			const fns = handlers.get(name) || [];
			let idx = 0;
			const next = async () => { idx += 1; return idx >= fns.length ? undefined : fns[idx](...callArgs, next); };
			return fns.length ? fns[0](...callArgs, next) : undefined;
		},
		provide(k, v) { provided.set(k, v); }
	};
}
function newCtx() { const ctx = createCtx(); apply(ctx); return ctx; }
const emitted = (ctx, name) => ctx.events.filter((n) => n === name).length;
const exec = (ctx, id, name, args) => ctx.emit("tools/pre-execute", { name, arguments: args, agent: { session: { id } } });
const preStep = (ctx, id, turn, step) => ctx.emit("agent/pre-step", { turn, step, agent: { session: { id } } });
const isDeny = (d) => d?.kind === "deny";

test("ctx.provide 暴露 stepGovernor 两服务", () => {
	const ctx = newCtx();
	const svc = ctx.provided.get("stepGovernor");
	assert.ok(svc, "stepGovernor 未注册");
	assert.equal(typeof svc.denyToolCategory, "function");
	assert.equal(typeof svc.rejectStep, "function");
});

test("denyToolCategory 参数校验（未知类别/错码/可重试码/坏 seq）", () => {
	const ctx = newCtx();
	const svc = ctx.provided.get("stepGovernor");
	assert.equal(svc.denyToolCategory("s0", "bash", { evidenceSeq: 1, ttlSteps: 2 }).accepted, false, "未知类别须拒绝");
	assert.equal(svc.denyToolCategory("s0", "read", { evidenceSeq: 1, ttlSteps: 2, code: "g2a-same-target" }).accepted, false, "码必须 semantic-stall-2");
	assert.equal(svc.denyToolCategory("s0", "read", { evidenceSeq: 1, ttlSteps: 2, code: "prompt-rejected" }).accepted, false, "禁止可重试码");
	assert.equal(svc.denyToolCategory("s0", "read", { evidenceSeq: -1, ttlSteps: 2 }).accepted, false, "evidenceSeq 须非负整数");
	assert.equal(svc.denyToolCategory("s0", "read", { evidenceSeq: 1, ttlSteps: 0 }).accepted, false, "ttlSteps 须正整数");
	assert.equal(svc.denyToolCategory("", "read", { evidenceSeq: 1, ttlSteps: 2 }).accepted, false, "sessionId 缺失须拒绝");
});

test("ttl 限定 deny 与严格大于解除（=expiresAtStep 仍 deny）", async () => {
	const ctx = newCtx();
	const svc = ctx.provided.get("stepGovernor");
	const r = svc.denyToolCategory("s1", "read", { evidenceSeq: 0, ttlSteps: 2, reason: "测试" });
	assert.deepEqual(r, { accepted: true, expiresAtStep: 2 });
	assert.ok(isDeny(await exec(ctx, "s1", "read", { file_path: "/a.js" })), "seq=0 deny");
	await preStep(ctx, "s1", 1, 1); // seq → 1
	assert.ok(isDeny(await exec(ctx, "s1", "read", { file_path: "/a.js" })), "seq=1 仍 deny");
	await preStep(ctx, "s1", 1, 2); // seq → 2（=expiresAtStep，严格大于才解除）
	assert.ok(isDeny(await exec(ctx, "s1", "read", { file_path: "/a.js" })), "seq=2 等于上限仍 deny");
	await preStep(ctx, "s1", 1, 3); // seq → 3（>2，解除）
	const d = await exec(ctx, "s1", "read", { file_path: "/a.js" });
	assert.ok(!isDeny(d), "seq=3 严格大于后解除");
	assert.ok(!ctx.events.includes("governor/step-rejected"), "类别 deny 不发 step-rejected");
});

test("幂等键 (sessionId,evidenceSeq,code)：重复不刷新 ttl、不重复事件；类别合并", async () => {
	const ctx = newCtx();
	const svc = ctx.provided.get("stepGovernor");
	const r1 = svc.denyToolCategory("s2", "read", { evidenceSeq: 5, ttlSteps: 3 });
	assert.equal(r1.expiresAtStep, 8);
	const r2 = svc.denyToolCategory("s2", "read", { evidenceSeq: 5, ttlSteps: 99 });
	assert.equal(r2.expiresAtStep, 8, "重复调用不刷新 ttl");
	assert.equal(emitted(ctx, "governor/category-denied"), 1, "重复调用不重复发事件");
	const r3 = svc.denyToolCategory("s2", "grep", { evidenceSeq: 5, ttlSteps: 99 });
	assert.equal(r3.expiresAtStep, 8, "同类不同类别合并到同一幂等键");
	assert.ok(isDeny(await exec(ctx, "s2", "grep", { pattern: "x", path: "/p" })), "合并后 grep 也被 deny");
	assert.ok(!isDeny(await exec(ctx, "s2", "pwsh", { command: "node t.js" })), "未列类别不受影响");
	const r4 = svc.denyToolCategory("s2", "read", { evidenceSeq: 6, ttlSteps: 1 });
	assert.equal(r4.expiresAtStep, 7, "不同 evidenceSeq 为新条目");
	assert.equal(emitted(ctx, "governor/category-denied"), 2);
});

test("rejectStep：pending 消费/幂等/turn 结束与真人消息清除、spliced 不清除", async () => {
	const ctx = newCtx();
	const svc = ctx.provided.get("stepGovernor");
	assert.ok(svc.rejectStep("s3", { evidenceSeq: 24, reason: "L3 终判" }).pending, "首调 pending=true");
	assert.ok(svc.rejectStep("s3", { evidenceSeq: 24 }).accepted, "幂等键重复调用 accepted");
	assert.equal(emitted(ctx, "governor/step-rejected"), 0, "排队时未消费不发事件");
	const d = await preStep(ctx, "s3", 1, 1);
	assert.equal(d?.kind, "reject", "下一 pre-step 边界消费");
	assert.equal(d?.code, "semantic-stall", "冻结码 semantic-stall");
	assert.equal(d?.evidenceSeq, 24);
	assert.deepEqual(d?.autoResume, { max: 0, switchAction: false }, "semantic-stall 不走 G1 续跑");
	assert.equal(emitted(ctx, "governor/step-rejected"), 1, "消费时发一次 step-rejected");
	assert.equal((await preStep(ctx, "s3", 1, 2))?.kind, undefined, "消费后清空，不再 reject");

	// turn/end（含 blocked/aborted）清除
	svc.rejectStep("s3", { evidenceSeq: 25 });
	await ctx.emit("session/event", { id: "s3" }, { type: "turn/end", data: { turn: 1 } });
	assert.equal((await preStep(ctx, "s3", 2, 1))?.kind, undefined, "turn 结束清除 pending");

	// 真人消息清除；spliced 注入不清除
	svc.rejectStep("s3", { evidenceSeq: 26 });
	await ctx.emit("session/event", { id: "s3" }, { type: "user/message", data: { source: { kind: "user" } } });
	assert.equal((await preStep(ctx, "s3", 3, 1))?.kind, undefined, "真人消息清除 pending");
	svc.rejectStep("s3", { evidenceSeq: 27 });
	await ctx.emit("session/event", { id: "s3" }, { type: "user/message", data: { source: { kind: "spliced" } } });
	assert.equal((await preStep(ctx, "s3", 4, 1))?.kind, "reject", "spliced 注入不清除");
	assert.equal(svc.rejectStep("s3", { evidenceSeq: 28, code: "prompt-rejected" }).accepted, false, "rejectStep 禁止可重试码");
	assert.equal(svc.rejectStep("s3", { evidenceSeq: 28, code: "g1a-zero-delivery" }).accepted, false, "rejectStep 码必须 semantic-stall");
});

test("step-rejected 事件载荷含 code/evidenceSeq/consumedAtStep", async () => {
	const ctx = newCtx();
	const svc = ctx.provided.get("stepGovernor");
	svc.rejectStep("s4", { evidenceSeq: 9 });
	await preStep(ctx, "s4", 1, 1);
	assert.equal(emitted(ctx, "governor/step-rejected"), 1);
});
