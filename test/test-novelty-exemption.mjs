// 回归：G1-A「只读空转」不得误杀"连读不同目标"的正常取证。
// 事故背景（2026-10-17）：参考会话 session-7acba9a1 在 step 5/6 被 G1-A 拦断，
// 每步其实都读了不同的文件——旧判据把"无文本输出的只读步"一律计成空转。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.DSH_GOVERNOR_SETTINGS_PATH = join(tmpdir(), `gov-nov-${process.pid}-${Date.now()}.json`);
const { createSessionState, noteEvent, evaluateG1 } = await import("../lib/index.js");

/** 推进一个只读步：有 reasoning、成功的 read、无文本、无文件变更。 */
function readStep(state, step, filePath, reasoning) {
	noteEvent(state, { type: "step/start", data: { turn: 1, step } });
	noteEvent(state, { type: "assistant/message", data: { turn: 1, step, message: { content: [{ type: "reasoning", text: reasoning }] } } });
	noteEvent(state, { type: "tool/call", data: { turn: 1, step, callId: `c${step}`, name: "read", arguments: { file_path: filePath } } });
	noteEvent(state, { type: "tool/result", data: { turn: 1, step, message: { role: "tool", message: { content: [] }, source: { kind: "tool", callId: `c${step}` }, toolCallId: `c${step}`, content: "ok" } } });
}

test("连读不同文件的调查步不触发 G1-A 只读空转", () => {
	const s = createSessionState();
	noteEvent(s, { type: "turn/start", data: { turn: 1 } });
	const texts = [
		"定位输入框组件的斜杠菜单实现位置，先看目录结构确认包边界",
		"检查容器组件里对 selection 的同步逻辑，确认外部选择是否被覆盖",
		"查看编辑器扩展的节点变换函数，判断分词样式是否重复应用",
		"阅读粘贴事件处理分支，核对剪贴板数据进入编辑器后的路径",
		"核对焦点切换时的命令分发顺序，排查失焦后状态是否残留",
		"复查标签持久化结构，确认 DOM 重建时能否恢复节点标记",
		"比对两个版本实现的差异，找出行为变化引入的那一行",
		"追踪主题样式注入点，确认占位颜色是否会污染后续输入"
	];
	for (let step = 1; step <= 8; step += 1) {
		readStep(s, step, `/repo/src/module-${step}.js`, texts[step - 1]);
	}
	// 结算第 8 步：再来一个 step/start 作为边界。
	noteEvent(s, { type: "step/start", data: { turn: 1, step: 9 } });
	const verdict = evaluateG1(s);
	assert.notEqual(verdict.rule, "G1-A", `不同目标的取证不得判空转，实际命中 ${verdict.rule}`);
});

test("反复读同一目标仍然触发 G1-A（重复翻页不放行）", () => {
	const s = createSessionState();
	noteEvent(s, { type: "turn/start", data: { turn: 1 } });
	const sameText = "同一个文件的同一页反复读取，没有产生任何新信息也没有输出结论";
	for (let step = 1; step <= 8; step += 1) {
		readStep(s, step, "/repo/src/same-file.js::@0:80", sameText);
	}
	noteEvent(s, { type: "step/start", data: { turn: 1, step: 9 } });
	const verdict = evaluateG1(s);
	assert.equal(verdict.rule, "G1-A", "同目标重复只读必须继续被拦");
});
