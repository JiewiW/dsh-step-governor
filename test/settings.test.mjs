// 设置接口：GET 10 项 / POST clamp+持久化 / 损坏回退 / env 启动初值 / 持久化覆盖 env。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), `gov-set-${process.pid}-`));
const pathA = join(dir, "a.json");
const pathB = join(dir, "b.json");
const pathC = join(dir, "c.json");
writeFileSync(pathB, "{oops not json", "utf8"); // 损坏文件
process.env.DSH_GOVERNOR_SETTINGS_PATH = pathA;
const { apply } = await import("../lib/index.js");

function createCtx() {
	const handlers = new Map();
	const regs = [];
	return {
		regs,
		on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
		async emit() { return undefined; },
		provide() { /* 不需要 */ },
		webServer: { register: (r) => regs.push(r) }
	};
}
function route(ctx) {
	assert.equal(ctx.regs.length, 1, "设置路由未注册");
	assert.equal(ctx.regs[0].path, "/plugins/step-governor/settings");
	return ctx.regs[0].handler;
}
const fakeRes = () => {
	const res = { status: 0, body: "" };
	res.writeHead = (s) => { res.status = s; };
	res.end = (b) => { res.body = b || ""; };
	return res;
};
async function callGet(handler) {
	const res = fakeRes();
	await handler({ method: "GET" }, res);
	return { status: res.status, body: JSON.parse(res.body) };
}
async function callPost(handler, payload) {
	const res = fakeRes();
	const req = new EventEmitter();
	req.method = "POST";
	const p = handler(req, res);
	req.emit("data", JSON.stringify(payload));
	req.emit("end");
	await p;
	return { status: res.status, body: JSON.parse(res.body) };
}

test("GET 返回 10 项设置 + schema + persisted 状态", async () => {
	const ctx = createCtx(); apply(ctx);
	const { status, body } = await callGet(route(ctx));
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.schema.length, 10, "schema 共 10 项");
	assert.equal(Object.keys(body.settings).length, 10, "settings 共 10 项");
	for (const k of ["mode", "g1aZeroSteps", "g1bFingerprintSteps", "g1cMaxStepsPerTurn", "g2aSameTargetCalls",
		"g2bConsecutiveFailures", "g1MaxAutoResume", "g1AutoResumeSwitchAction", "notifyChannels", "maxSessions"]) {
		assert.ok(k in body.settings, `缺少 ${k}`);
	}
	assert.equal(body.settings.mode, "shadow");
	assert.equal(body.settings.g1MaxAutoResume, 3);
	assert.equal(body.settings.g1AutoResumeSwitchAction, true);
	assert.equal(body.persisted, false, "文件不存在 → 未持久化");
});

test("POST clamp + 非法回退 + 未知键丢弃 + 持久化落盘", async () => {
	const ctx = createCtx(); apply(ctx);
	const handler = route(ctx);
	const { body } = await callPost(handler, { settings: {
		g1aZeroSteps: 999, g1bFingerprintSteps: "abc", mode: "g2",
		notifyChannels: ["GUI", "nope"], g1AutoResumeSwitchAction: "yes", bogusKey: 1
	} });
	assert.equal(body.ok, true);
	assert.equal(body.saved, true, "持久化成功");
	assert.equal(body.settings.g1aZeroSteps, 20, "数值 clamp 到 schema 上限");
	assert.equal(body.settings.g1bFingerprintSteps, 6, "非数值回退原值");
	assert.equal(body.settings.mode, "g2", "合法模式生效");
	assert.deepEqual(body.settings.notifyChannels, ["GUI"], "未知渠道过滤");
	assert.equal(body.settings.g1AutoResumeSwitchAction, true, "非布尔回退原值");
	assert.ok(!("bogusKey" in body.settings), "未知键丢弃");
	const onDisk = JSON.parse(readFileSync(pathA, "utf8"));
	assert.equal(onDisk.mode, "g2", "落盘内容与响应一致");
	// 再次 GET 读到持久化值
	const g2 = await callGet(handler);
	assert.equal(g2.body.settings.g1aZeroSteps, 20);
});

test("损坏文件回退默认并标记 persisted=false", async () => {
	process.env.DSH_GOVERNOR_SETTINGS_PATH = pathB;
	const ctx = createCtx(); apply(ctx);
	const { body } = await callGet(route(ctx));
	assert.equal(body.persisted, false, "损坏 → 回退");
	assert.equal(body.settings.mode, "shadow", "回退默认");
	assert.equal(body.settings.g1aZeroSteps, 4, "回退默认");
	process.env.DSH_GOVERNOR_SETTINGS_PATH = pathA;
});

test("env 作启动初值；设置卡保存后覆盖 env（§9.3）", async () => {
	process.env.DSH_GOVERNOR_G1A_N = "5";
	process.env.DSH_GOVERNOR_MODE = "g2b";
	process.env.DSH_GOVERNOR_SETTINGS_PATH = pathC;
	let ctx = createCtx(); apply(ctx);
	const g1 = await callGet(route(ctx));
	assert.equal(g1.body.settings.g1aZeroSteps, 5, "env 初值");
	assert.equal(g1.body.settings.mode, "g2b", "env 模式");
	await callPost(route(ctx), { settings: { mode: "shadow" } }); // 保存 → 覆盖 env
	ctx = createCtx(); apply(ctx); // 重新装配（模拟重启）
	const g2 = await callGet(route(ctx));
	assert.equal(g2.body.settings.mode, "shadow", "持久化覆盖 env");
	assert.equal(g2.body.settings.g1aZeroSteps, 5, "未覆盖项仍取 env 初值");
	delete process.env.DSH_GOVERNOR_G1A_N;
	delete process.env.DSH_GOVERNOR_MODE;
	process.env.DSH_GOVERNOR_SETTINGS_PATH = pathA;
});

test("405 / 损坏请求体 500", async () => {
	const ctx = createCtx(); apply(ctx);
	const handler = route(ctx);
	const res1 = fakeRes();
	await handler({ method: "DELETE" }, res1);
	assert.equal(res1.status, 405);
	const res2 = fakeRes();
	const req = new EventEmitter();
	req.method = "POST";
	const p = handler(req, res2);
	req.emit("data", "{bad json");
	req.emit("end");
	await p;
	assert.equal(res2.status, 500);
});
