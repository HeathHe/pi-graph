import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertAsyncRunDirectory, assertAsyncRunIdentity, type EventBus } from "./rpc.ts";

export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export interface AsyncTerminal {
	state: "complete" | "failed" | "stopped" | "paused";
	status: Record<string, unknown>;
	completion?: Record<string, unknown>;
	output: string;
}

export class AsyncRunDeadlineError extends Error {
	constructor(asyncId: string) {
		super(`Subagent run ${asyncId} exceeded its explicit graph deadline.`);
		this.name = "AsyncRunDeadlineError";
	}
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function completionFinalOutput(value: Record<string, unknown> | undefined): string {
	if (!value) return "";
	const results = Array.isArray(value.results) ? value.results as Array<Record<string, unknown>> : [];
	return results.map((result) => typeof result.finalOutput === "string" ? result.finalOutput : "").filter(Boolean).join("\n\n");
}

function completionSummary(value: Record<string, unknown> | undefined): string {
	if (!value) return "";
	const results = Array.isArray(value.results) ? value.results as Array<Record<string, unknown>> : [];
	return results.map((result) => typeof result.summary === "string" ? result.summary : "").filter(Boolean).join("\n\n");
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function readSafeOutput(path: string, asyncDir: string): Promise<string> {
	if (!within(asyncDir, path)) throw new Error("Subagent output file escapes its async run directory.");
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Subagent output file is not a regular file.");
	return readFile(path, "utf8");
}

export async function waitForAsyncRun(input: {
	events: EventBus;
	asyncId: string;
	asyncDir: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	preferCompletionFinalOutput?: boolean;
	completionEventGraceMs?: number;
}): Promise<AsyncTerminal> {
	assertAsyncRunIdentity(input.asyncId, input.asyncDir);
	const statusPath = join(input.asyncDir, "status.json");
	return new Promise((resolvePromise, reject) => {
		let watcher: FSWatcher | undefined;
		let poller: NodeJS.Timeout | undefined;
		let deadline: NodeJS.Timeout | undefined;
		let completionGrace: NodeJS.Timeout | undefined;
		let completionGraceExpired = false;
		let completion: Record<string, unknown> | undefined;
		let checking = false;
		let settled = false;
		const completionEventGraceMs = input.completionEventGraceMs ?? 3_000;
		let unsubscribe: (() => void) | undefined;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			if (deadline) clearTimeout(deadline);
			if (completionGrace) clearTimeout(completionGrace);
			if (poller) clearInterval(poller);
			watcher?.close();
			if (typeof unsubscribe === "function") unsubscribe();
			input.signal?.removeEventListener("abort", onAbort);
			action();
		};
		const check = async () => {
			if (checking || settled) return;
			checking = true;
			try {
				const status = await readJson(statusPath);
				if (!status) return;
				if (status.runId !== input.asyncId) throw new Error(`Subagent status identity does not match ${input.asyncId}.`);
				const state = status.state;
				if (state !== "complete" && state !== "failed" && state !== "stopped" && state !== "paused") return;
				const outputFile = typeof status.outputFile === "string" ? status.outputFile : undefined;
				const fileOutput = !input.preferCompletionFinalOutput && outputFile ? await readSafeOutput(outputFile, input.asyncDir) : "";
				if (state === "complete" && input.preferCompletionFinalOutput && !completion) {
					if (completionGraceExpired) {
						throw new Error(`Subagent completion event for ${input.asyncId} was not observed within ${completionEventGraceMs}ms of terminal status.`);
					}
					if (!completionGrace) {
						completionGrace = setTimeout(() => {
							completionGrace = undefined;
							completionGraceExpired = true;
							void check();
						}, completionEventGraceMs);
						completionGrace.unref();
					}
					return;
				}
				const finalOutput = completionFinalOutput(completion);
				const summary = completionSummary(completion);
				if (state === "complete" && input.preferCompletionFinalOutput && !finalOutput && !summary) {
					throw new Error(`Subagent completion event for ${input.asyncId} did not include usable final output.`);
				}
				const output = input.preferCompletionFinalOutput
					? finalOutput || summary
					: fileOutput || finalOutput || summary;
				finish(() => resolvePromise({ state, status, completion, output }));
			} catch (error) {
				finish(() => reject(error));
			} finally {
				checking = false;
			}
		};
		const onCompleteUnsub = input.events.on(ASYNC_COMPLETE_EVENT, (raw) => {
			const event = raw as Record<string, unknown>;
			const id = event.runId ?? event.id;
			if (id !== input.asyncId || (event.asyncDir !== undefined && event.asyncDir !== input.asyncDir)) return;
			completion = event;
			if (completionGrace) {
				clearTimeout(completionGrace);
				completionGrace = undefined;
			}
			void check();
		});
		if (typeof onCompleteUnsub === "function") unsubscribe = onCompleteUnsub;
		const onAbort = () => finish(() => reject(new Error("Graph node monitoring aborted.")));
		if (input.timeoutMs !== undefined) {
			deadline = setTimeout(() => finish(() => reject(new AsyncRunDeadlineError(input.asyncId))), input.timeoutMs);
		}
		input.signal?.addEventListener("abort", onAbort, { once: true });
		if (input.signal?.aborted) {
			onAbort();
			return;
		}
		try {
			watcher = watch(input.asyncDir, (_event, filename) => {
				if (!filename || filename.toString() === "status.json") void check();
			});
			watcher.on("error", () => void check());
		} catch {
			// Completion events and polling still provide deterministic observation.
		}
		poller = setInterval(() => void check(), 500);
		poller.unref();
		void check();
	});
}

export async function readAsyncRunState(asyncId: string, asyncDir: string): Promise<string | undefined> {
	assertAsyncRunIdentity(asyncId, asyncDir);
	const status = await readJson(join(asyncDir, "status.json"));
	return typeof status?.state === "string" ? status.state : undefined;
}

export async function requestAsyncStop(asyncDir: string): Promise<void> {
	assertAsyncRunDirectory(asyncDir);
	const controlDir = join(asyncDir, "control");
	const target = join(controlDir, "stop.json");
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(controlDir, { recursive: true });
	await writeFile(temporary, `${JSON.stringify({ type: "stop", ts: Date.now(), source: "pi-graph" })}\n`, "utf8");
	await rename(temporary, target);
}

export async function waitForConfirmedStop(
	asyncDir: string,
	timeoutMs = 30_000,
	options: { acceptFailed?: boolean; acceptComplete?: boolean } = {},
): Promise<boolean> {
	const asyncId = assertAsyncRunDirectory(asyncDir);
	const statusPath = join(asyncDir, "status.json");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await readJson(statusPath);
		if (status && status.runId !== asyncId) throw new Error(`Subagent status identity does not match ${asyncId}.`);
		if (status?.state === "stopped") return true;
		if (status?.state === "failed" && options.acceptFailed) return true;
		if (status?.state === "complete" && options.acceptComplete) return true;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	return false;
}
