// 纯逻辑单测：状态机 / G1 / G2 / 目标键 / 失败签名。
import {
	createSessionState, noteEvent, noteAssistantStep, evaluateG1,
	evaluateG2, targetKey, failureSignature, CONFIG
} from "../lib/index.js";

let failed = 0;
function check(label, cond, extra = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${label} ${extra}`);
	if (!cond) failed += 1;
}

// ── 目标键：不同文件=不同键；同 URL 去 query；命令参数进入键体（P1-14）──
check("不同文件路径→不同键",
	targetKey("read", { file_path: "/a/x.js" }) !== targetKey("read", { file_path: "/a/y.js" }));
check("同 URL 不同 query→同键",
	targetKey("browser_open", { url: "http://h/p?a=1" }) === targetKey("browser_open", { url: "http://h/p?b=2" }));
check("同命令不同参数→不同键（P1-14 事故主因）",
	targetKey("pwsh", { command: "node t.js --x=1" }) !== targetKey("pwsh", { command: "node t.js --x=2" }));
check("同命令首段同参数→同键（换管道后缀仍同目标）",
	targetKey("pwsh", { command: "node t.js --x=1 | select -First 3" }) ===
	targetKey("pwsh", { command: "node t.js --x=1; Get-Item x" }));
check("工具名不同→键不同",
	targetKey("read", { file_path: "/a" }) !== targetKey("grep", { file_path: "/a" }));
check("read 不同 offset→不同键（P1-14 分页键）",
	targetKey("read", { file_path: "/g.js", offset: 481, limit: 220 }) !==
	targetKey("read", { file_path: "/g.js", offset: 641, limit: 220 }));
check("read 同 offset 同 limit→同键",
	targetKey("read", { file_path: "/g.js", offset: 481, limit: 220 }) ===
	targetKey("read", { file_path: "/g.js", offset: 481, limit: 220 }));
check("grep 带 path 保留 pattern（P1-14）",
	targetKey("grep", { pattern: "gateway", path: "/a/b.js" }) !==
	targetKey("grep", { pattern: "router", path: "/a/b.js" }));
check("grep 同 pattern 同 path→同键",
	targetKey("grep", { pattern: "gateway", path: "/a/b.js" }) ===
	targetKey("grep", { pattern: "gateway", path: "/a/b.js" }));
check("pwsh 不同 -Filter→不同键（事故 §3.1 seq29/38）",
	targetKey("pwsh", { command: "Get-ChildItem -Filter *.js" }) !==
	targetKey("pwsh", { command: "Get-ChildItem -Filter *.json" }));
check("C:/x 与 D:/x 跨盘符→不同键（Windows 不走 URL）",
	targetKey("read", { file_path: "C:/x/foo.js" }) !== targetKey("read", { file_path: "D:/x/foo.js" }));

// ── 失败签名 ──
check("isError 识别", failureSignature({ isError: true }).error === true);
check("成功正文含 401 不判失败（P0-4）", failureSignature({ content: "HTTP 401 Unauthorized" }).error === false);
check("成功正文含 not found 不判失败（P0-4）", failureSignature({ content: "command not found" }).error === false);
check("结构化 error 判失败", failureSignature({ isError: true, error: { code: "E401" } }).error === true && failureSignature({ isError: true, error: { code: "E401" } }).code === "E401");
check("正常结果非错误", failureSignature({ content: "ok 123" }).error === false);

// ── G2-B：连续失败后下一次命中 ──
{
	const s = createSessionState();
	const key = targetKey("pwsh", { command: "node fail.js" });
	// 经事件路径计数（pre-execute 钩子对放行调用的计数在 apply 内；纯逻辑用 noteEvent 等价驱动）
	noteEvent(s, { type: "tool/call", data: { callId: "b1", name: "pwsh", arguments: { command: "node fail.js" } } });
	noteEvent(s, { type: "tool/result", data: { message: { source: { callId: "b1" }, toolCallId: "b1", isError: true } } });
	noteEvent(s, { type: "tool/call", data: { callId: "b2", name: "pwsh", arguments: { command: "node fail.js" } } });
	noteEvent(s, { type: "tool/result", data: { message: { source: { callId: "b2" }, toolCallId: "b2", isError: true } } });
	const v = evaluateG2(s, key);
	check("G2-B 连续失败 2 次后命中", v.hit && v.rule === "G2-B", JSON.stringify(v.detail));
	noteEvent(s, { type: "tool/call", data: { callId: "b3", name: "pwsh", arguments: { command: "node fail.js" } } });
	noteEvent(s, { type: "tool/result", data: { message: { source: { callId: "b3" }, toolCallId: "b3" } } }); // 成功清零
	const v2 = evaluateG2(s, key);
	check("G2-B 成功后清零（放行）", !v2.hit || v2.rule !== "G2-B");
}

// ── G2-A：同目标滑窗调用计数（M=3，窗口内第 4 次命中）──
// P1-18 滑窗语义：pre 放行时 push globalStepSeq 进 recentCalls，evaluateG2
// 统计当前 seq 往前 g1aWindowSize 步内的同键调用；滑出窗自然衰减。
{
	const s = createSessionState();
	const key = targetKey("read", { file_path: "/same.js" });
	let hitAt = 0;
	for (let i = 1; i <= 4; i++) {
		const v = evaluateG2(s, key);
		if (v.hit && v.rule === "G2-A") { hitAt = i; break; }
		const rec = s.toolTargets.get(key) || { calls: 0, consecutiveFail: 0, recentCalls: [] };
		rec.recentCalls.push(s.globalStepSeq); // 等价于 pre-execute 放行计数
		rec.calls = rec.recentCalls.length;
		s.toolTargets.set(key, rec);
	}
	check("G2-A 窗口内第 4 次同目标命中", hitAt === CONFIG.g2aSameTargetCalls + 1, `hitAt=${hitAt}`);
}

// ── G2-A 滑窗衰减：同目标 3 次后，绕出窗（推进 globalStepSeq）再调用不再拦截 ──
{
	const s = createSessionState();
	const key = targetKey("read", { file_path: "/same.js" });
	for (let i = 0; i < CONFIG.g2aSameTargetCalls; i++) {
		const rec = s.toolTargets.get(key) || { calls: 0, consecutiveFail: 0, recentCalls: [] };
		rec.recentCalls.push(s.globalStepSeq);
		rec.calls = rec.recentCalls.length;
		s.toolTargets.set(key, rec);
	}
	// 推进 seq 超出滑窗（g1aWindowSize 默认 8）
	s.globalStepSeq += CONFIG.g1aWindowSize;
	const v = evaluateG2(s, key);
	check("G2-A 滑出窗后同目标放行（不拦截）", !(v.hit && v.rule === "G2-A"), JSON.stringify(v.detail));
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

// ── P1-15 语义指纹：Jaccard 相似文本命中、歧义文本不命中（抗共同前缀规避）──
{
	// 近似命中对：同一结论换措辞（共享多数词），Jaccard≈0.83 > 0.8 → 应归同桶。
	const a = "the gateway route is never reached in verbose mode. check the router table.";
	const b = "the gateway route is never reached in verbose mode. check the router entries.";
	const s = createSessionState();
	noteAssistantStep(s, { step: 1, hasText: false, reasoning: a, successfulTool: true, fileChange: false });
	noteAssistantStep(s, { step: 2, hasText: false, reasoning: b, successfulTool: true, fileChange: false });
	const fp1 = s.fingerprintSteps.get([...s.fingerprintSteps.keys()][0]);
	check("P1-15 近似文本归入同一语义桶", fp1 && fp1.size === 2, `size=${fp1 && fp1.size}`);
	// 规避负例：共享开头但语义转折（事故模式），不得误并入既有桶。
	const s2 = createSessionState();
	noteAssistantStep(s2, { step: 1, hasText: false, reasoning: a, successfulTool: true, fileChange: false });
	noteAssistantStep(s2, { step: 2, hasText: false, reasoning: "still failing on the same read target the gateway route never comes up in verbose mode", successfulTool: true, fileChange: false });
	check("P1-15 语义歧义文本未误并", s2.fingerprintSteps.size === 2, `buckets=${s2.fingerprintSteps.size}`);
}
// P1-15 Jaccard 函数导出直测
{
	const { jaccardSimilarity, shingleSet } = await import("../lib/index.js");
	const same = jaccardSimilarity(shingleSet("query the router table and log"), shingleSet("query the router table and log"));
	const diff = jaccardSimilarity(shingleSet("query the router table and log the error"), shingleSet("rebuild the whole project from a clean checkout"));
	check("P1-15 jaccard 相同集=1", same === 1, `=${same}`);
	check("P1-15 jaccard 不同集<1", diff < 1 && diff >= 0, `=${diff}`);
}

// ── P1-15 G1-A 近 N 步滑窗双判据（成功占比低 + reasoning 短 → 命中）──
{
	// hasText=true 保持连续零判据为 0（progressed 记推进），唯有滑窗判据能抓失速：
	// 窗内无成功工具、reasoning 极短 → successRatio=0≤MAX 且 reasoningChars<MIN → 命中窗口。
	const s = createSessionState();
	let hit = null;
	for (let step = 1; step <= CONFIG.g1aWindowSize; step++) {
		noteAssistantStep(s, { step, hasText: true, reasoning: "x", successfulTool: false, fileChange: false });
		const v = evaluateG1(s);
		if (v.hit) hit = v;
	}
	check("P1-15 G1-A 滑窗失速命中（含 windowN）", hit && hit.rule === "G1-A" && hit.detail.windowN === CONFIG.g1aWindowSize,
		hit ? JSON.stringify(hit.detail) : "未命中");
	// 有成功工具（占比 > MAX）→ 不命中。
	const s2 = createSessionState();
	for (let step = 1; step <= CONFIG.g1aWindowSize; step++) {
		noteAssistantStep(s2, { step, hasText: true, reasoning: "x", successfulTool: true, fileChange: false });
	}
	const v2 = evaluateG1(s2);
	check("P1-15 G1-A 高成功占比不命中", !(v2.hit && v2.rule === "G1-A"), v2.hit ? JSON.stringify(v2.detail) : "未命中");
}

// ── P1-15 G1-A 滑窗免疫 hasText 注入污染（核查用例）──
{
	// 插件注入 text 设 stepHadText=true（污染连续零推进判据），但滑窗只看
	// successfulTool+reasoning 长度，仍能抓失速（评估报告 §5 需明确是/否结论）。
	const s = createSessionState();
	for (let step = 1; step <= CONFIG.g1aWindowSize; step++) {
		noteAssistantStep(s, { step, hasText: true, reasoning: "short", successfulTool: false, fileChange: false });
	}
	const v = evaluateG1(s);
	check("P1-15 G1-A 滑窗不被注入 text 掩盖", v.hit && v.rule === "G1-A",
		`hasText=true 仍命中: ${v.hit && v.rule}`);
}

// ── hasText 注入污染核查：assistant/message text 块 → stepHadText=true（实测是/否）──
{
	const s = createSessionState();
	// 第三方插件 spliced 注入一条 assistant/message，带纯 text 块。
	noteEvent(s, { type: "assistant/message", data: { step: 1, message: { content: [{ type: "text", text: "注入的说明文字" }] } } });
	s.stepInTurn = 1;
	const target = s.stepInTurn;
	// 模拟结算该步
	noteAssistantStep(s, { step: target, hasText: s.stepHadText === true, reasoning: s.stepReasoning || "", successfulTool: false, fileChange: false });
	check("hasText 注入污染存在：插件注入 text 计入推进", s.stepHadText === true,
		`已实测确认：注入 text 置 stepHadText（污染成立，连续零推进会被掩盖）`);
	// 防护结论：滑窗判据不读 hasText 已在上一条覆盖；连续零推进判据（G1-A 硬零）会受影响，
	// 故滑窗作为兜底关键（上面用例验证）。
}

// ── P1-15 G1-C 黄金回放标定：事故"隔步空转"段 step28-30 必报警 ──
{
	// 事故签名：8 步窗内夹着成功步（连续零推进只到 3，够不到 g1aZeroSteps=4），
	// 但窗内成功工具占比低 + reasoning 总字数低 → 滑窗判据兜底命中。
	// 步骤：1 个成功工具 / 7 个纯 reasoning 短句空转。
	const s = createSessionState();
	let hit = null;
	for (let step = 1; step <= CONFIG.g1aWindowSize; step++) {
		const isSuccess = step % 8 === 1; // 每窗最后一个为成功工具
		noteAssistantStep(s, {
			step, hasText: false,
			reasoning: isSuccess ? "read the file and extract the routing table contents into a stable note" : "hmm",
			successfulTool: isSuccess, fileChange: false
		});
		const v = evaluateG1(s);
		if (v.hit) hit = v;
	}
	check("P1-15 事故隔步空转段滑窗报警（step28-30 段）", hit && hit.rule === "G1-A",
		hit ? JSON.stringify(hit.detail) : "未命中");
}
// ── P1-15 G1-C 黄金回放标定：正常代码浏览零报警 ──
{
	// 正常浏览：每步 reasoning 各异（防 G1-B 指纹误报）+ 成功工具或长推理高产出，
	// 占比/字数双高，不得误杀。
	const browsings = [
		"walking through the route handler to see how the gateway forwards the request and where it falls over",
		"checking the config matches what the docs show for the retry policy and logging output",
		"the router table maps each virtual host to its upstream server so verify that entry",
		"found a stale comment and fixed the module reference to point at the current implementation",
		"comparing the previous run output against this one to see which step diverged",
		"the read returned the expected section so the offset math for the next page is right",
		"verifying the regex handles the multiline case that earlier failed with a trailing newline",
		"the git log shows the change landed before the crash so packaging should pick it up"
	];
	const s = createSessionState();
	let alarm = false;
	for (let step = 1; step <= CONFIG.g1aWindowSize; step++) {
		noteAssistantStep(s, {
			step, hasText: true,
			reasoning: browsings[step - 1],
			successfulTool: true, fileChange: false
		});
		const v = evaluateG1(s);
		if (v.hit) alarm = true;
	}
	check("P1-15 正常代码浏览零报警", !alarm, alarm ? "正常浏览被误杀" : "");
}

console.log(failed === 0 ? "\n全部 governor 逻辑断言通过" : `\n${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
