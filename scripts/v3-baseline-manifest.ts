import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { release, arch } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const CERTIFIED = "0.49.0";

function run(command: string, args: string[], timeoutMs = 600_000): { exitCode: number } {
	try {
		execFileSync(command, args, { cwd: root, timeout: timeoutMs, stdio: "pipe" });
		return { exitCode: 0 };
	} catch (error) {
		return { exitCode: (error as { status?: number }).status ?? 1 };
	}
}

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

// ── 任务二.2：三处 pi-subagents 版本必须一致为 certified 0.49.0 ──
function verifyDependencyChannels(): { packageJson: string; packageLock: string; nodeModules: string } {
	const packageJson = JSON.parse(readFileSyncText(join(root, "package.json"))) as { devDependencies: Record<string, string> };
	const packageLock = JSON.parse(readFileSyncText(join(root, "package-lock.json"))) as { packages: Record<string, { version?: string }> };
	const nodeModules = JSON.parse(readFileSyncText(join(root, "node_modules", "pi-subagents", "package.json"))) as { version: string };
	const found = {
		packageJson: packageJson.devDependencies["pi-subagents"] ?? "",
		packageLock: packageLock.packages["node_modules/pi-subagents"]?.version ?? "",
		nodeModules: nodeModules.version,
	};
	for (const [place, version] of Object.entries(found)) {
		if (version !== CERTIFIED) throw new Error(`pi-subagents version mismatch in ${place}: found '${version}', certified '${CERTIFIED}'.`);
	}
	return found;
}

function readFileSyncText(path: string): string {
	return readFileSync(path, "utf8");
}

// ── per-file TAP 收集（含嵌套套件层级路径） ──
interface TestEntry { name: string; result: "pass" | "fail" | "skip" | "todo"; }
interface FileEntry { file: string; tests: TestEntry[]; }

function collectFileTests(file: string): FileEntry {
	const output = execFileSync(
		process.execPath,
		["--experimental-strip-types", "tests/run-isolated.ts", "suite", "--test-reporter=tap", file],
		{ cwd: root, timeout: 600_000, stdio: "pipe", encoding: "utf8" },
	);
	const tests: TestEntry[] = [];
	const subtestByIndent = new Map<number, string>();
	const indexByPath = new Map<string, number>();
	for (const rawLine of output.split("\n")) {
		const indentMatch = rawLine.match(/^( *)/);
		const indent = indentMatch ? indentMatch[1]!.length : 0;
		const line = rawLine.slice(indent);
		const subtest = line.match(/^# Subtest: (.*)$/);
		if (subtest) {
			subtestByIndent.set(indent, subtest[1]!);
			for (const key of [...subtestByIndent.keys()]) if (key > indent) subtestByIndent.delete(key);
			const path = [...subtestByIndent.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n).join(" > ");
			indexByPath.set(path, tests.length);
			tests.push({ name: path, result: "pass" });
			continue;
		}
		const status = line.match(/^(ok|not ok)\s+\d+\s+-\s+(.*?)(\s+#\s+(SKIP|TODO))?$/);
		if (status) {
			const path = [...subtestByIndent.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n).join(" > ");
			const index = indexByPath.get(path);
			if (index !== undefined) {
				if (status[1] === "not ok") tests[index]!.result = "fail";
				else if (status[4] === "SKIP") tests[index]!.result = "skip";
				else if (status[4] === "TODO") tests[index]!.result = "todo";
			}
		}
	}
	return { file: `tests/${file.split("/").pop()}`, tests };
}

async function main(): Promise<void> {
	const testedCommit = git(["rev-parse", "HEAD"]);
	const testFiles = (await readdir(join(root, "tests"))).filter((f) => f.endsWith(".test.ts")).sort();

	// per-file TAP
	const files: FileEntry[] = [];
	for (const file of testFiles) files.push(collectFileTests(join(root, "tests", file)));
	const leafCount = files.reduce((sum, f) => sum + f.tests.length, 0);
	const leafPass = files.reduce((sum, f) => sum + f.tests.filter((t) => t.result === "pass").length, 0);

	// full-suite 官方统计
	const fullTap = execFileSync(
		process.execPath,
		["--experimental-strip-types", "tests/run-isolated.ts", "suite", "--test-reporter=tap", ...testFiles.map((f) => `tests/${f}`)],
		{ cwd: root, timeout: 600_000, stdio: "pipe", encoding: "utf8" },
	);
	const official = fullTap.match(/^# tests (\d+)$/m);
	const officialPass = fullTap.match(/^# pass (\d+)$/m);
	const officialFail = fullTap.match(/^# fail (\d+)$/m);

	const check = run("npm", ["run", "check"]);
	const pack = run("npm", ["run", "pack:check"], 300_000);
	const channels = verifyDependencyChannels();

	// 任务二.4：lockHash 必须来自 testedCommit 的 package-lock.json 内容
	const lockContent = git(["show", `${testedCommit}:package-lock.json`]);
	const lockHash = sha256(lockContent + "\n"); // git blob 内容；git 输出去尾换行后还原一次换行

	const manifest = {
		manifestVersion: 1,
		generatedAt: new Date().toISOString(),
		baseline: {
			testedCommit,
			archiveTag: "v1-governed",
			lockHash,
			lockHashSource: `git show ${testedCommit}:package-lock.json`,
		},
		environment: {
			node: process.version,
			npm: execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim(),
			os: release(), // 任务二.1：os.release()
			arch: arch(),  // 独立 arch 字段
			platform: process.platform,
		},
		channels: {
			piSubagentsCertified: CERTIFIED,
			piSubagentsDrift: "latest",
			verified: channels,
		},
		check: { command: "npm run check", exitCode: check.exitCode },
		tests: {
			perFileTap: { files: files.length, leafTests: leafCount, pass: leafPass, fail: leafCount - leafPass, files },
			fullSuite: {
				command: "npm test",
				officialTotal: official ? Number(official[1]) : null,
				pass: officialPass ? Number(officialPass[1]) : null,
				fail: officialFail ? Number(officialFail[1]) : null,
			},
		},
		pack: { command: "npm run pack:check", exitCode: pack.exitCode },
	};

	await writeFile(join(root, "docs", "v3-baseline-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	console.log(JSON.stringify({ testedCommit, lockHash: lockHash.slice(0, 12), perFile: leafCount, fullSuite: official?.[1], check: check.exitCode, pack: pack.exitCode, channels }));
}

main().catch((error) => {
	console.error(String(error));
	process.exit(1);
});
