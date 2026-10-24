// S3 单测：compress 目标键归一化（G2-A 可对同范围重复压缩累积计数）
// 事故 6117c5ca：compress 无专门分支 → 全参数哈希 → 同范围不同 summary 键互异 → G2-A 永不命中
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

process.env.DSH_GOVERNOR_SETTINGS_PATH = join(tmpdir(), `gov-tk-${process.pid}-${Date.now()}.json`);
const { targetKey } = await import("../lib/index.js");

const here = join(fileURLToPath(new URL(".", import.meta.url)));
const baseline = JSON.parse(readFileSync(join(here, "old-keys-baseline.json"), "utf8"));

// (a) flat 同范围 2 次调用键相等
test("(a) flat 同范围 2 次调用键相等", () => {
	const k1 = targetKey("compress", { startId: "m01185", endId: "m01207", topic: "t1" });
	const k2 = targetKey("compress", { startId: "m01185", endId: "m01207", summary: "不同文本" });
	assert.equal(k1, k2);
});

// (b) content 数组同范围（各段相同）键相等
test("(b) content 数组同范围（各段相同）键相等", () => {
	const k1 = targetKey("compress", { content: [ { startId: "m01185", endId: "m01207", summary: "s1" } ] });
	const k2 = targetKey("compress", { content: [ { startId: "m01185", endId: "m01207", summary: "s2 完全不同的摘要文本" } ] });
	assert.equal(k1, k2);
});

// (b2) content 数组同范围多段拼接
test("(b2) content 数组多段拼接：同段序同键", () => {
	const k1 = targetKey("compress", { content: [
		{ startId: "m01185", endId: "m01207", topic: "a" },
		{ startId: "b9", endId: "b14", topic: "b" },
	] });
	const k2 = targetKey("compress", { content: [
		{ startId: "m01185", endId: "m01207", topic: "X" },
		{ startId: "b9", endId: "b14", topic: "Y" },
	] });
	assert.equal(k1, k2);
	// 段序不同 → 不同键
	const k3 = targetKey("compress", { content: [
		{ startId: "b9", endId: "b14", topic: "b" },
		{ startId: "m01185", endId: "m01207", topic: "a" },
	] });
	assert.notEqual(k1, k3, "段序不同应为不同键（保序拼接）");
});

// (c) 同范围不同 summary 键相等（风暴形态核心断言）
test("(c) 同范围不同 summary 键相等（风暴形态核心断言）", () => {
	const k1 = targetKey("compress", { content: [ { startId: "m01185", endId: "m01207", summary: "s1" } ] });
	const k2 = targetKey("compress", { content: [ { startId: "m01185", endId: "m01207", summary: "s2 完全不同" } ] });
	assert.equal(k1, k2);
});

// (d) 不同范围键不等
test("(d) 不同范围键不等", () => {
	const k1 = targetKey("compress", { startId: "m01185", endId: "m01207" });
	const k2 = targetKey("compress", { startId: "m01184", endId: "m01206" });
	assert.notEqual(k1, k2);
});

// (e) 无范围参数 raw="unranged"
test("(e) 无范围参数 raw=unranged（同无范围调用同键）", () => {
	const k1 = targetKey("compress", { content: "m01185 摘要文本无范围标记" });
	const k2 = targetKey("compress", { content: "另一段无范围摘要" });
	assert.equal(k1, k2, "无范围参数同键（都落 unranged）");
});

// (e2) 非法 JSON content（如转义断裂）→ 不按数组处理 → 无 flat → unranged
test("(e2) 非法 JSON content 字符串 → unranged", () => {
	const bad = '{ "startId": "m01185", "endId": "m01207", "summary": "broken\\\\n\\n\\\\" }';
	const k = targetKey("compress", { content: bad });
	const kUnranged = targetKey("compress", { content: "xx" });
	assert.equal(k, kUnranged, "非法 JSON 回退 unranged 与无范围同键");
});

// (e3) content 字符串可解析为数组 → 按数组取范围
test("(e3) content 字符串（JSON 数组字面量）→ 按数组取范围", () => {
	const k1 = targetKey("compress", { content: '[{"startId":"m01185","endId":"m01207","summary":"s1"}]' });
	const k2 = targetKey("compress", { content: '[{"startId":"m01185","endId":"m01207","summary":"s2"}]' });
	assert.equal(k1, k2, "字符串数组形态同范围不同 summary 同键");
});

// (f) 其他工具（read/grep/edit/write/compress 旧键）回归不变
test("(f) 其他工具键生成回归不变（对旧键基线）", () => {
	for (const c of baseline) {
		if (c.name === "compress") continue; // compress 旧键已被专门分支取代，属预期变化
		const actual = targetKey(c.name, c.args);
		assert.equal(actual, c.key, `${c.name} 键与基线不一致`);
	}
});

// (f2) compress 键形态（键体含范围，head 可读）
test("(f2) compress 键形态：范围进键体且 summary/topic 不进键", () => {
	const k = targetKey("compress", { content: [ { startId: "m01185", endId: "m01207", summary: "s" } ] });
	assert.ok(k.startsWith("compress::"), `键以 compress:: 开头: ${k}`);
	assert.ok(!k.includes("summary") && !k.includes("topic"), "summary/topic 不进键");
	// head 段取首个可读 token（m01185）；digest 为完整范围 m01185::m01207 的 FNV-1a。
	const head = (k.match(/^compress::([A-Za-z0-9_.\/-]+)/) || [])[1] || "";
	assert.equal(head, "m01185", `head 为首段范围起点: ${k}`);
	function fnv1aHex(text) {
		let hash = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	}
	const expectDigest = fnv1aHex("m01185::m01207");
	assert.ok(k.endsWith(`#${expectDigest}`), `digest 为范围哈希: got=${k} expect=#${expectDigest}`);
	const k2 = targetKey("compress", { content: [ { startId: "m01185", endId: "m01207", summary: "完全不同的摘要" } ] });
	assert.equal(k, k2);
});
