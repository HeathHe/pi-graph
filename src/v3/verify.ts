import { spawn } from "node:child_process";
import type { V3ValidationResult } from "./types.ts";
import { validateValidationCommandV3 } from "./validation-command.ts";

export interface V3VerificationLimits {
	/** Total wall-clock budget for a single validation command. */
	timeoutMs: number;
	/** Per-stream (stdout and stderr) byte cap; overflow sets the truncated flag. */
	streamLimitBytes: number;
}

export const V3_VERIFY_DEFAULTS: V3VerificationLimits = {
	timeoutMs: 300_000,
	streamLimitBytes: 64 * 1024,
};

export interface V3RunVerificationOptions extends Partial<V3VerificationLimits> {
	signal?: AbortSignal;
}

interface CappedStream {
	value: string;
	truncated: boolean;
}

function appendCapped(current: CappedStream, chunk: Buffer | string, limitBytes: number): CappedStream {
	if (current.truncated || current.value.length >= limitBytes) return current;
	const incoming = chunk.toString();
	const remaining = limitBytes - current.value.length;
	if (incoming.length <= remaining) return { value: current.value + incoming, truncated: false };
	return { value: current.value + incoming.slice(0, remaining), truncated: true };
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

export async function runV3Validation(command: string, cwd: string, options: V3RunVerificationOptions = {}): Promise<V3ValidationResult> {
	const limits: V3VerificationLimits = { ...V3_VERIFY_DEFAULTS, ...options };
	const started = Date.now();
	return new Promise((resolvePromise) => {
		let stdout: CappedStream = { value: "", truncated: false };
		let stderr: CappedStream = { value: "", truncated: false };
		let timedOut = false;
		let aborted = false;
		let childExitCode: number | null = null;
		let childSignal: NodeJS.Signals | null = null;
		let parsed: string[];
		try {
			parsed = validateValidationCommandV3(command);
		} catch (error) {
			resolvePromise({
				command, ok: false, exitCode: null, signal: null, timedOut: false,
				stdout: "", stdoutTruncated: false,
				stderr: error instanceof Error ? error.message : String(error), stderrTruncated: false,
				durationMs: Date.now() - started,
			});
			return;
		}
		const [executable, ...args] = parsed;
		if (options.signal?.aborted) {
			resolvePromise({
				command, ok: false, exitCode: null, signal: null, timedOut: false,
				stdout: "", stdoutTruncated: false, stderr: "Validation aborted before start.", stderrTruncated: false,
				durationMs: Date.now() - started,
			});
			return;
		}
		const child = spawn(executable!, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (chunk: Buffer) => { stdout = appendCapped(stdout, chunk, limits.streamLimitBytes); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = appendCapped(stderr, chunk, limits.streamLimitBytes); });
		let timer: NodeJS.Timeout | undefined;
		const onAbort = () => {
			aborted = true;
			killTree(child.pid, "SIGTERM");
			setTimeout(() => killTree(child.pid, "SIGKILL"), 2_000).unref();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			stderr = appendCapped(stderr, Buffer.from(`\n${error.message}`), limits.streamLimitBytes);
		});
		child.on("close", (exitCode, signal) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			childExitCode = exitCode;
			childSignal = signal ?? null;
			const ok = exitCode === 0 && !timedOut && !aborted;
			resolvePromise({
				command,
				ok,
				exitCode: childExitCode,
				signal: childSignal,
				timedOut,
				stdout: stdout.value,
				stdoutTruncated: stdout.truncated,
				stderr: stderr.value,
				stderrTruncated: stderr.truncated,
				durationMs: Date.now() - started,
			});
		});
		timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid, "SIGTERM");
			setTimeout(() => killTree(child.pid, "SIGKILL"), 2_000).unref();
		}, limits.timeoutMs);
	});
}

export async function runV3Validations(commands: string[], cwd: string, options: V3RunVerificationOptions = {}): Promise<V3ValidationResult[]> {
	const results: V3ValidationResult[] = [];
	for (const command of commands) {
		const result = await runV3Validation(command, cwd, options);
		results.push(result);
		if (!result.ok) break;
	}
	return results;
}
