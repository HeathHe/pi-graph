import { createJiti } from "jiti";
import { readSupervisionJson, confirmedProcessExit } from "./supervision.ts";
import { waitForNativeAsyncRun } from "./native-monitor.ts";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { childSupervision, observeV3ChildLifecycle, v3ChildObservationFingerprint } from "./observability.ts";
import { assertAsyncRunDirectory, assertAsyncRunIdentity, type EventBus } from "./rpc.ts";
import type { V3ChildObservation } from "./types.ts";

export const ASYNC_COMPLETE_EVENT = "pi-graph:child-complete";

export interface AsyncTerminal {
	state: "complete" | "failed" | "stopped" | "paused";
	status: Record<string, unknown>;
	completion?: Record<string, unknown>;
	output: string;
	observation: V3ChildObservation;
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

/**
 * pi-subagents may persist a structured workflow result directly in
 * status.json instead of publishing a top-level outputFile. Read only the
 * documented text projections; never follow a path found inside workflow data.
 */
function durableStatusOutput(status: Record<string, unknown>): string {
	const workflow = status.workflow;
	if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return "";
	const value = (workflow as Record<string, unknown>).value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const record = value as Record<string, unknown>;
	if (typeof record.output === "string" && record.output.length > 0) return record.output;
	const results = Array.isArray(record.results) ? record.results as Array<Record<string, unknown>> : [];
	return results.map((result) => {
		if (typeof result.finalOutput === "string" && result.finalOutput.length > 0) return result.finalOutput;
		if (typeof result.output === "string" && result.output.length > 0) return result.output;
		return typeof result.summary === "string" ? result.summary : "";
	}).filter(Boolean).join("\n\n");
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
 events: EventBus; asyncId: string; asyncDir: string;
 /** Historical API fields are ignored: they must never terminate execution. */
 timeoutMs?: number; completionEventGraceMs?: number;
 signal?: AbortSignal; probe?: () => Promise<void>; probeIntervalMs?: number;
 healthTimeoutMs?: number; requireSupervision?: boolean; preferCompletionFinalOutput?: boolean;
 onObservation?: (observation: V3ChildObservation) => void | Promise<void>;
}): Promise<AsyncTerminal> {
 assertAsyncRunIdentity(input.asyncId, input.asyncDir);
 if (input.requireSupervision) return waitForNativeAsyncRun(input);
 return new Promise((resolvePromise, reject) => {
  let watcher: FSWatcher | undefined; let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined; let settled = false; let checking = false; let dirty = false;
  let completion: Record<string, unknown> | undefined;
  let failures = 0; let probing = false;
  let health: "responsive" | "unknown" | "suspected_unresponsive" = "unknown";
  let fingerprint: string | undefined; let pendingFinish: (() => void) | undefined;
  const healthAbort = new AbortController();
  const finish = (action: () => void) => {
   if (settled) return; settled = true; healthAbort.abort();
   if (timer) clearInterval(timer); watcher?.close(); unsubscribe?.();
   input.signal?.removeEventListener("abort", onAbort);
   if (checking) pendingFinish = action; else action();
  };
  const check = async () => {
   if (settled) return;
   if (checking) { dirty = true; return; }
   checking = true;
   try {
    const status = await readSupervisionJson(join(input.asyncDir, "status.json"));
    if (status && status.runId !== input.asyncId) throw new Error("Subagent status identity mismatch.");
    const current = status ?? { runId: input.asyncId, state: "running" };
    const observation = observeV3ChildLifecycle({ asyncId: input.asyncId, status: current, ...(completion ? { completion } : {}) });
    observation.supervision = childSupervision(current, Date.now(), health === "responsive" ? "available" : failures ? "unreachable" : "not_checked");
    const nextFingerprint = v3ChildObservationFingerprint(observation);
    if (fingerprint !== nextFingerprint) { fingerprint = nextFingerprint; try { await input.onObservation?.(observation); } catch {} }
    if (settled) return;
    // Compatibility reader for historical records and other direct callers.
    const state = current.state;
    if (state !== "complete" && state !== "failed" && state !== "stopped" && state !== "paused") return;
    const result = completion;
    if (state === "complete" && input.preferCompletionFinalOutput && !result) return;
    const fileOutput = !input.preferCompletionFinalOutput && typeof current.outputFile === "string"
     ? await readSafeOutput(current.outputFile, input.asyncDir).catch(() => "") : "";
    const output = completionFinalOutput(result) || completionSummary(result) || durableStatusOutput(current) || fileOutput;
    finish(() => resolvePromise({ state, status: current, completion: result, output, observation }));
   } catch (error) { finish(() => reject(error)); }
   finally { checking = false; const action = pendingFinish; pendingFinish = undefined; action?.(); if (dirty && !settled) { dirty = false; void check(); } }
  };
  const probe = async () => {
   if (settled || probing) return; probing = true;
   try {
    let ok = false;
    if (input.probe) { try { await input.probe(); ok = true; } catch {} }
    if (settled) return;
    failures = ok ? 0 : failures + 1; health = ok ? "responsive" : "unknown";
   } finally { probing = false; if (!settled) void check(); }
  };
  const onAbort = () => finish(() => reject(new Error("Graph node monitoring aborted.")));
  const off = input.events.on(ASYNC_COMPLETE_EVENT, raw => {
   const event = raw as Record<string, unknown>;
   if ((event.runId ?? event.id) !== input.asyncId || (event.asyncDir !== undefined && event.asyncDir !== input.asyncDir)) return;
   completion = event; void check();
  });
  if (typeof off === "function") unsubscribe = off;
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) { onAbort(); return; }
  try {
   watcher = watch(input.asyncDir, (_event, file) => { if (!file || ["status.json", "process-terminal.json"].includes(String(file))) void check(); });
   watcher.on("error", () => { watcher?.close(); watcher = undefined; void check(); });
  } catch {}
  timer = setInterval(() => { void check(); void probe(); }, input.probeIntervalMs ?? 30000);
  // Keep this monitor alive while execution is active, even when watchers fail.
  void check().then(() => { if (!settled) void probe(); });
 });
}

export async function readAsyncRunState(asyncId: string, asyncDir: string): Promise<string | undefined> {
	assertAsyncRunIdentity(asyncId, asyncDir);
	const status = await readJson(join(asyncDir, "status.json"));
	if (status && status.runId !== asyncId) throw new Error(`Subagent status identity does not match ${asyncId}.`);
	return typeof status?.state === "string" ? status.state : undefined;
}

/**
 * The public async spawn reply can win the race with status.json publication.
 * Wait only for the exact reply-bound asyncId/asyncDir identity; pi-subagents
 * 0.56 no longer persists the outer RPC tool-call id in single-run status.
 */
export async function waitForAsyncRunIdentity(
	asyncId: string,
	asyncDir: string,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
	assertAsyncRunIdentity(asyncId, asyncDir);
	const timeoutMs = options.timeoutMs ?? 5_000;
	const pollMs = options.pollMs ?? 50;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Async identity timeout must be 1..30000ms.");
	if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) throw new Error("Async identity poll interval must be a positive integer no greater than the timeout.");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const state = await readAsyncRunState(asyncId, asyncDir);
		if (state !== undefined) return state;
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`pi-subagents did not publish durable status identity for ${asyncId} within ${timeoutMs}ms.`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(pollMs, remaining)));
	}
}

export async function requestAsyncStop(asyncDir: string): Promise<void> {
	assertAsyncRunDirectory(asyncDir);
 const intent = await readSupervisionJson(join(asyncDir, 'intent.json'));
 if (!intent || intent.runtimeKind !== 'pi-graph-sdk/1') throw new Error('Legacy run control is unavailable: old Graph must not be replayed.');
 const { atomicWriteJson } = await import('./durable.ts');
 await atomicWriteJson(join(asyncDir, 'control.json'), {version:1,runId:intent.runId,runnerProcessInstanceId:intent.runnerProcessInstanceId,action:'stop'});
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
		const proof = await readSupervisionJson(join(asyncDir, "process-terminal.json"));
		if (confirmedProcessExit(proof, asyncId)) {
			if (status?.state === "stopped") return true;
			if (status?.state === "failed" && options.acceptFailed) return true;
			if (status?.state === "complete" && options.acceptComplete) return true;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	return false;
}
