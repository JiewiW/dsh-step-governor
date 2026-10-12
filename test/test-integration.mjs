// 集成测试：用最小伪 cordis ctx 驱动 apply()，验证两个钩子的真实决策。
// 通过子进程 + 不同 DSH_GOVERNOR_MODE 验证 shadow / g2b / g1g2 / 异常 fail-open。
// P0-6 隔离：每次 run 强制独立临时 SETTINGS_PATH，与本机持久化 json 无关。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "integrity-runner.mjs");
const isoDir = mkdtempSync(join(tmpdir(), `gov-int-${process.pid}-`));

function run(mode, extraEnv = {}) {
	const out = execFileSync(process.execPath, [runner], {
		encoding: "utf8",
		env: {
			...process.env,
			DSH_GOVERNOR_MODE: mode,
			DSH_GOVERNOR_SETTINGS_PATH: join(isoDir, `settings-${mode}-${Object.keys(extraEnv).join("_") || "base"}.json`),
			...extraEnv
		}
	});
	return JSON.parse(out.trim().split("\n").pop());
}

let failed = 0;
function check(label, cond, extra = "") {
	console.log(`${cond ? "PASS" : "FAIL"} ${label} ${extra}`);
	if (!cond) failed += 1;
}

// 1. shadow：G2 连续失败、G1 零推进都只记录，决策全部放行
{
	const r = run("shadow");
	check("shadow 已加载", r.loaded === true);
	check("shadow G2 不 deny（放行）", r.g2Decision === "next", r.g2Decision);
	check("shadow G1 不 reject（放行）", r.g1Decision === "next", r.g1Decision);
	check("shadow 有观测日志", r.logs.some((l) => l.at === "loaded"));
}

// 2. g2b：仅 G2-B enforce；G1 仍影子放行
{
	const r = run("g2b");
	check("g2b G2-B deny", r.g2Decision === "deny", r.g2Decision);
	check("g2b deny reason 非空", /G2-B/.test(r.g2Reason || ""));
	check("g2b G1 仍放行（影子）", r.g1Decision === "next", r.g1Decision);
}

// 3. g1g2：G1-A reject 生效（小阈值 G1A_N=2，便于 3 步内触发）
{
	const r = run("g1g2", { DSH_GOVERNOR_G1A_N: "2" });
	check("g1g2 G1 reject", r.g1Decision === "reject", r.g1Decision);
}

// 4. fail-open：pre-step 回调内抛错时放行（runner 用坏 payload 触发）
{
	const r = run("g1g2", { GOVERNOR_BAD_PAYLOAD: "1" });
	check("异常时 fail-open 放行", r.g1Decision === "next", r.g1Decision);
}

console.log(failed === 0 ? "\n全部集成断言通过" : `\n${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
