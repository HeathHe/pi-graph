import { spawn } from "node:child_process";
import { isAbsolute, sep } from "node:path";
import type { ValidationResult } from "./types.ts";

const OUTPUT_LIMIT = 64 * 1024;
const ALLOWED_EXECUTABLES = new Set(["npm", "npx", "pnpm", "yarn", "bun", "node", "tsc", "vitest", "jest", "eslint", "prettier", "pytest", "python3", "ruff", "go", "cargo", "git", "test", "jq"]);

function validateInvocation(executable: string, args: string[]): void {
	for (const argument of args) {
		if (argument.includes("\0")) throw new Error("Validation arguments may not contain NUL bytes.");
		const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
		const segments = value.split(/[\\/]+/);
		if (isAbsolute(value) || value === "~" || value.startsWith(`~${sep}`) || segments.includes("..")) throw new Error(`Validation argument escapes the isolated workspace: ${argument}`);
	}
	if (executable === "node" && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) throw new Error("Inline Node.js evaluation is not allowed in validation commands.");
	if (executable === "python3" && args.some((arg) => arg === "-c")) throw new Error("Inline Python evaluation is not allowed in validation commands.");
	if (executable === "npx" && !args.includes("--no-install")) throw new Error("npx validation must use --no-install to prevent package downloads.");
	if (["npm", "pnpm", "yarn", "bun"].includes(executable) && args.some((arg) => ["--prefix", "--cwd", "--dir", "-C"].includes(arg) || arg.startsWith("--prefix=") || arg.startsWith("--cwd=") || arg.startsWith("--dir="))) throw new Error("Package-manager validation may not change cwd.");
	if (executable === "git") {
		if (args.some((arg) => arg === "-C" || arg.startsWith("--git-dir") || arg.startsWith("--work-tree"))) throw new Error("Git validation may not redirect its repository.");
		const subcommand = args.find((arg) => !arg.startsWith("-"));
		if (!subcommand || !["status", "diff", "show", "rev-parse", "ls-files"].includes(subcommand)) throw new Error(`Git validation subcommand is not read-only: ${subcommand ?? "<missing>"}`);
	}
}

export function validateValidationCommand(command: string): string[] {
	const parsed = parseCommand(command);
	const [executable, ...args] = parsed;
	if (!executable || !ALLOWED_EXECUTABLES.has(executable)) throw new Error(`Validation executable is not allowed: ${executable ?? "<empty>"}`);
	validateInvocation(executable, args);
	return parsed;
}

function appendLimited(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	return next.length <= OUTPUT_LIMIT ? next : next.slice(0, OUTPUT_LIMIT) + "\n[output truncated]";
}

export function runValidation(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ValidationResult> {
	const started = Date.now();
	return new Promise((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let parsed: string[];
		try {
			parsed = validateValidationCommand(command);
		} catch (error) {
			resolvePromise({ command, ok: false, exitCode: null, stdout, stderr: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
			return;
		}
		const [executable, ...args] = parsed;
		if (signal?.aborted) {
			resolvePromise({ command, ok: false, exitCode: null, stdout, stderr: "Validation aborted.", durationMs: Date.now() - started, aborted: true });
			return;
		}
		const child = spawn(executable!, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk); });
		child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk); });
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid, "SIGTERM");
			setTimeout(() => killTree(child.pid, "SIGKILL"), 2_000).unref();
		}, timeoutMs);
		const onAbort = () => {
			aborted = true;
			killTree(child.pid, "SIGTERM");
			setTimeout(() => killTree(child.pid, "SIGKILL"), 2_000).unref();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => { stderr = appendLimited(stderr, error.message); });
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ command, ok: exitCode === 0 && !timedOut && !aborted, exitCode, stdout, stderr, durationMs: Date.now() - started, ...(timedOut ? { timedOut: true } : {}), ...(aborted ? { aborted: true } : {}) });
		});
	});
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		if (process.platform === "win32") process.kill(pid, signal);
		else process.kill(-pid, signal);
	} catch {
		// The validator may have exited between timeout and signal delivery.
	}
}

export function parseCommand(command: string): string[] {
	if (!command.trim()) throw new Error("Validation command is empty.");
	const output: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const character of command) {
		if (escaped) {
			token += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else token += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (token) output.push(token);
			token = "";
			continue;
		}
		if (/[;&|<>`]/.test(character)) throw new Error(`Shell operator '${character}' is not allowed in validation commands.`);
		token += character;
	}
	if (escaped || quote) throw new Error("Validation command has an unterminated escape or quote.");
	if (token) output.push(token);
	return output;
}

export async function runValidations(commands: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];
	for (const command of commands) {
		const result = await runValidation(command, cwd, timeoutMs, signal);
		results.push(result);
		if (!result.ok) break;
	}
	return results;
}
