import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subagentAsyncRoot } from "../src/v3/rpc.ts";

type Mode = "suite";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(testsDir);

function isWithin(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === "" || (
		pathFromRoot !== ".."
		&& !pathFromRoot.startsWith(`..${sep}`)
		&& !isAbsolute(pathFromRoot)
	);
}

async function requestedTestFiles(arguments_: string[]): Promise<string[]> {
	if (arguments_.length === 0) {
		return (await readdir(testsDir, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
			.map((entry) => join(testsDir, entry.name))
			.sort();
	}
	const files: string[] = [];
	for (const argument of arguments_) {
		if (argument.startsWith("-")) throw new Error(`Unsupported isolated test argument: ${argument}`);
		const fromRepository = resolve(repositoryRoot, argument);
		const target = isWithin(testsDir, fromRepository) ? fromRepository : resolve(testsDir, argument);
		if (!isWithin(testsDir, target) || !target.endsWith(".test.ts") || !(await stat(target)).isFile()) {
			throw new Error(`Isolated test target must be a .test.ts file under tests/: ${argument}`);
		}
		files.push(target);
	}
	return files;
}

async function requestedSuiteArguments(arguments_: string[]): Promise<string[]> {
	const testRunnerArguments: string[] = [];
	const fileArguments: string[] = [];
	for (const argument of arguments_) {
		if (/^--test-reporter=(?:spec|tap|dot|junit|lcov)$/u.test(argument)) {
			testRunnerArguments.push(argument);
			continue;
		}
		fileArguments.push(argument);
	}
	return [...testRunnerArguments, ...await requestedTestFiles(fileArguments)];
}

async function childArguments(_mode: Mode, arguments_: string[], guardUrl: string): Promise<string[]> {
  return ["--experimental-strip-types", "--import", guardUrl, "--test", "--test-concurrency=4", ...await requestedSuiteArguments(arguments_)];
}

async function run(): Promise<number> {
	const mode = process.argv[2];
  assert.equal(mode, "suite", "Usage: run-isolated.ts suite [tests/example.test.ts ...]");
	const hostAsyncRoot = subagentAsyncRoot();
	const hostTempRoot = resolve(tmpdir());
	const sandboxRoot = await mkdtemp(join(hostTempRoot, "pi-graph-test-sandbox-"));
	assert.ok(isWithin(hostTempRoot, sandboxRoot) && resolve(sandboxRoot) !== hostTempRoot, "Refusing an unsafe test sandbox path.");
	const isolatedAgentDir = join(sandboxRoot, "pi-agent");
	await mkdir(isolatedAgentDir, { mode: 0o700 });
	const guardUrl = pathToFileURL(join(testsDir, "assert-isolated-temp.ts")).href;
	try {
		const argumentsForChild = await childArguments(mode, process.argv.slice(3), guardUrl);
		const child = spawn(process.execPath, argumentsForChild, {
			cwd: repositoryRoot,
			stdio: "inherit",
			detached: process.platform !== "win32",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: isolatedAgentDir,
				TMPDIR: sandboxRoot,
				TMP: sandboxRoot,
				TEMP: sandboxRoot,
				PI_GRAPH_TEST_SANDBOX_ROOT: sandboxRoot,
				PI_GRAPH_TEST_HOST_ASYNC_ROOT: hostAsyncRoot,
			},
		});
		let forwardedSignal: NodeJS.Signals | undefined;
		let forceKillTimer: NodeJS.Timeout | undefined;
		const signalChildTree = (signal: NodeJS.Signals, force = false): boolean => {
			if (child.pid === undefined) return child.kill(signal);
			if (process.platform === "win32") {
				const taskkill = spawnSync("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
					stdio: "ignore",
					windowsHide: true,
				});
				if (!taskkill.error && taskkill.status === 0) return true;
				return child.kill(signal);
			}
			try {
				process.kill(-child.pid, signal);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				return child.kill(signal);
			}
		};
		const forwardSignal = (signal: NodeJS.Signals) => {
			if (forwardedSignal !== undefined) {
				signalChildTree("SIGKILL", true);
				return;
			}
			forwardedSignal = signal;
			signalChildTree(signal);
			forceKillTimer = setTimeout(() => signalChildTree("SIGKILL", true), 5_000);
			forceKillTimer.unref();
		};
		const onInterrupt = () => forwardSignal("SIGINT");
		const onTerminate = () => forwardSignal("SIGTERM");
		process.on("SIGINT", onInterrupt);
		process.on("SIGTERM", onTerminate);
		try {
			const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
				child.once("error", reject);
				child.once("exit", (code, signal) => resolvePromise({ code, signal }));
			});
			if (forwardedSignal !== undefined) return 128 + (constants.signals[forwardedSignal] ?? 1);
			if (result.signal) {
				console.error(`Isolated test process exited from signal ${result.signal}.`);
				return 1;
			}
			return result.code ?? 1;
		} finally {
			if (forwardedSignal !== undefined) signalChildTree("SIGKILL", true);
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onTerminate);
			if (forceKillTimer) clearTimeout(forceKillTimer);
		}
	} finally {
		await rm(sandboxRoot, { recursive: true, force: true });
	}
}

process.exitCode = await run();
