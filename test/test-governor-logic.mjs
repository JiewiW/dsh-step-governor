// 纯逻辑单测：状态机 / G1 / G2 / 目标键 / 失败签名。
import {
	createSessionState, noteEvent, noteAssistantStep, evaluateG1,
	evaluateG2, commitCall, targetKey, failureSignature, CONFIG
} from "../lib/index.js";

let failed = 0;
function check(label, cond, extra = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${label} ${extra}`);
	if (!cond) failed += 1;
}

// ── 目标键：不同文件=不同键；同 URL 去 query；同命令首段归一 ──
check("不同文件路径→不同键",
	targetKey("read", { file_path: "/a/x.js" }) !== targetKey("read", { file_path: "/a/y.js" }));
check("同 URL 不同 query→同键",
	targetKey("browser_open", { url: "http://h/p?a=1" }) === targetKey("browser_open", { url: "http://h/p?b=2" }));
check("同命令不同管道后缀→同键",
	targetKey("pwsh", { command: "node t.js --x=1" }) === targetKey("pwsh", { command: "node t.js --x=2" }));
check("工具名不同→键不同",
	targetKey("read", { file_path: "/a" }) !== targetKey("grep", { file_path: "/a" }));

// ── 失败签名 ──
check("isError 识别", failureSignature({ isError: true }).error === true);
check("401 识别", failureSignature({ content: "HTTP 401 Unauthorized" }).error === true);
check("正常结果非错误", failureSignature({ content: "ok 123" }).error === false);

// ── G2-B：连续失败后下一次命中 ──
{
	const s = createSessionState();
	const key = targetKey("pwsh", { command: "node fail.js" });
	commitCall(s, key, { isError: true });
	commitCall(s, key, { isError: true }); // 连续失败=2
	const v = evaluateG2(s, key);
	check("G2-B 连续失败 2 次后命中", v.hit && v.rule === "G2-B", JSON.stringify(v.detail));
	commitCall(s, key, { content: "ok" }); // 成功清零
	const v2 = evaluateG2(s, key);
	check("G2-B 成功后清零（放行）", !v2.hit || v2.rule !== "G2-B");
}

// ── G2-A：同目标调用计数（M=3，第 4 次命中）──
{
	const s = createSessionState();
	const key = targetKey("read", { file_path: "/same.js" });
	let hitAt = 0;
	for (let i = 1; i <= 4; i++) {
		const v = evaluateG2(s, key);
		if (v.hit && v.rule === "G2-A") { hitAt = i; break; }
		commitCall(s, key, { content: "x" });
	}
	check("G2-A 第 4 次同目标命中", hitAt === CONFIG.g2aSameTargetCalls + 1, `hitAt=${hitAt}`);
}

// ── G1-A：连续硬零推进 N 步（直接驱动 noteAssistantStep，不经 step/start 结算）──
{
	const s = createSessionState();
	noteEvent(s, { type: "turn/start", data: { turn: 1 } });
	let g1aAt = 0;
	for (let step = 1; step <= CONFIG.g1aZeroSteps + 1; step++) {
		noteAssistantStep(s, { step, hasText: false, reasoning: "thinking " + step, successfulTool: false, fileChange: false });
		const v = evaluateG1(s);
		if (v.hit && v.rule === "G1-A") { g1aAt = step; break; }
	}
	check("G1-A 连续硬零推进命中", g1aAt === CONFIG.g1aZeroSteps, `at=${g1aAt}`);
}

// ── G1-A 重置：成功工具/文件变更/用户消息后清零 ──
{
	const s = createSessionState();
	noteEvent(s, { type: "turn/start", data: { turn: 1 } });
	noteAssistantStep(s, { step: 1, hasText: false, reasoning: "a", successfulTool: false, fileChange: false });
	noteAssistantStep(s, { step: 2, hasText: false, reasoning: "b", successfulTool: true, fileChange: false });
	check("成功工具后 G1-A 清零", evaluateG1(s).rule !== "G1-A");
	noteAssistantStep(s, { step: 3, hasText: false, reasoning: "c", successfulTool: false, fileChange: false });
	noteEvent(s, { type: "user/message", data: { source: { kind: "user" } } });
	check("用户消息后 G1-A 清零", s.consecutiveZero === 0);
}

// ── G1-B：同一指纹跨 K 步重现（且无文件变更）──
{
	const s = createSessionState();
	noteEvent(s, { type: "turn/start", data: { turn: 1 } });
	let g1bAt = 0;
	for (let step = 1; step <= CONFIG.g1bFingerprintSteps + 1; step++) {
		noteAssistantStep(s, { step, hasText: false, reasoning: "the kernel never marks in verbose mode so all branches miss", successfulTool: true, fileChange: false });
		const v = evaluateG1(s);
		if (v.hit && v.rule === "G1-B") { g1bAt = step; break; }
	}
	check("G1-B 同指纹 K 步重现命中", g1bAt === CONFIG.g1bFingerprintSteps, `at=${g1bAt}`);
}

// ── G1-B 负例：文件变更后指纹清空 ──
{
	const s = createSessionState();
	noteAssistantStep(s, { step: 1, hasText: false, reasoning: "same conclusion text here", successfulTool: true, fileChange: false });
	noteAssistantStep(s, { step: 2, hasText: false, reasoning: "same conclusion text here", successfulTool: true, fileChange: true });
	check("文件变更后 G1-B 不命中", !evaluateG1(s).hit || evaluateG1(s).rule !== "G1-B");
}

// ── G1-C：步数硬上限（用小阈值 env 不易改，直接构造 state）──
{
	const s = createSessionState();
	s.stepInTurn = CONFIG.g1cMaxStepsPerTurn - 1; // 下一步=上限
	const v = evaluateG1(s);
	check("G1-C 达到步数上限命中", v.hit && v.rule === "G1-C");
}

// ── spliced 注入（source.kind 非 user）不重置 ──
{
	const s = createSessionState();
	s.consecutiveZero = 3;
	noteEvent(s, { type: "user/message", data: { source: { kind: "spliced" } } });
	check("插件注入消息不重置计数", s.consecutiveZero === 3);
}

console.log(failed === 0 ? "\n全部 governor 逻辑断言通过" : `\n${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
