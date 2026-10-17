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

test("GET 返回 14 项设置 + schema + persisted 状态", async () => {
	const ctx = createCtx(); apply(ctx);
	const { status, body } = await callGet(route(ctx));
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.schema.length, 14, "schema 共 14 项");
	assert.equal(Object.keys(body.settings).length, 14, "settings 共 14 项");
	for (const k of ["mode", "g1aZeroSteps", "g1bFingerprintSteps", "g1cMaxStepsPerTurn", "g2aSameTargetCalls",
		"g2bConsecutiveFailures", "g1MaxAutoResume", "g1AutoResumeSwitchAction", "notifyChannels", "maxSessions",
		"g1aWindowSize", "g1aSuccessRatioMax", "g1aReasoningMin", "g1aUnproductiveSteps"]) {
		assert.ok(k in body.settings, `缺少 ${k}`);
	}
	assert.equal(body.settings.mode, "shadow");
	assert.equal(body.settings.g1MaxAutoResume, 3);
	assert.equal(body.settings.g1AutoResumeSwitchAction, true);
	assert.equal(body.persisted, false, "文件不存在 → 未持久化");
	// P1-19：g1g2 标注 experimental，schema 透传给 UI 渲染强制档警示。
	const modeSpec = body.schema.find((s) => s.key === "mode");
	assert.ok(modeSpec.experimentalOptions && modeSpec.experimentalOptions.includes("g1g2"),
		"mode schema 缺 experimentalOptions");
	assert.ok((modeSpec.experimentalNote || "").length > 0, "mode schema 缺 experimentalNote");
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

test("env 作启动初值；env 显式设过的键持久化不得覆盖（P0-6 env>json>默认）", async () => {
	process.env.DSH_GOVERNOR_G1A_N = "5";
	process.env.DSH_GOVERNOR_MODE = "g2b";
	process.env.DSH_GOVERNOR_SETTINGS_PATH = pathC;
	let ctx = createCtx(); apply(ctx);
	const g1 = await callGet(route(ctx));
	assert.equal(g1.body.settings.g1aZeroSteps, 5, "env 初值");
	assert.equal(g1.body.settings.mode, "g2b", "env 模式");
	await callPost(route(ctx), { settings: { mode: "shadow", g1aZeroSteps: 9 } }); // 保存 → 尝试覆盖 env
	// envOwnedKeys：env 显式设过的键（mode/g1a）持久化时原值保留（g2b/5），
	// 其余键（g1bFingerprintSteps 等）照常保存。确认持久化 json 已落盘。
	const onDiskC = JSON.parse(readFileSync(pathC, "utf8"));
	assert.equal(onDiskC.mode, "g2b", "env 拥有的键持久化保留 env 值");
	assert.equal(onDiskC.g1aZeroSteps, 5, "env 拥有的键持久化保留 env 值");
	assert.equal(onDiskC.g1bFingerprintSteps, 6, "非 env 拥有的键照常持久化");
	// env 仍为 g2b/5。重新装配（模拟重启）后：env 优先 → 仍是 g2b/5（而非 json 的 shadow/9）。
	ctx = createCtx(); apply(ctx);
	const g2 = await callGet(route(ctx));
	assert.equal(g2.body.settings.mode, "g2b", "env 优先：持久化 mode 不覆盖 env");
	assert.equal(g2.body.settings.g1aZeroSteps, 5, "env 优先：持久化 g1a 不覆盖 env");
	delete process.env.DSH_GOVERNOR_G1A_N;
	delete process.env.DSH_GOVERNOR_MODE;
	process.env.DSH_GOVERNOR_SETTINGS_PATH = pathA;
});

test("未设 env 时持久化照常生效（json>默认）", async () => {
	// 上一个测试落盘的 pathC：mode=g2b, g1a=5（env 拥有键保留值），g1bFingerprintSteps=6。
	delete process.env.DSH_GOVERNOR_G1A_N;
	delete process.env.DSH_GOVERNOR_MODE;
	process.env.DSH_GOVERNOR_SETTINGS_PATH = pathC;
	const ctx = createCtx(); apply(ctx);
	const g = await callGet(route(ctx));
	assert.equal(g.body.settings.mode, "g2b", "无 env：持久化值生效");
	assert.equal(g.body.settings.g1aZeroSteps, 5, "无 env：持久化 g1a 生效");
	assert.equal(g.body.settings.g1bFingerprintSteps, 6, "无 env：持久化 g1b 生效");
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
