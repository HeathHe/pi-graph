import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { atomicWriteJson } from "./durable.ts";
import { canonicalDigest } from "./digests.ts";
import { assertAsyncRunIdentity, subagentAsyncRoot, type EventBus } from "./rpc.ts";

export const NATIVE_COMPLETE_EVENT = "pi-graph:child-complete";
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const receiptWrites = new Map<string, Promise<unknown>>();
type RecordValue = Record<string, any>;
export interface NativeRunIdentity { asyncId: string; asyncDir: string }
export interface NativeReceipt {
 version: 1; runId: string; asyncDir: string; sessionId: string;
 source: "event" | "result" | "replay"; capturedAt: string;
 completion: RecordValue; status: RecordValue; digest: string;
}
function record(raw: unknown): raw is RecordValue { return !!raw && typeof raw === "object" && !Array.isArray(raw); }
export function nativeResultsDir(): string { return join(dirname(subagentAsyncRoot()), "async-subagent-results"); }
async function safeText(file: string): Promise<string | undefined> {
 let handle;
 try {
  handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await handle.stat();
  if (!info.isFile() || info.size > MAX_RESULT_BYTES) return undefined;
  const value = await handle.readFile("utf8");
  return Buffer.byteLength(value) <= MAX_RESULT_BYTES ? value : undefined;
 } catch (error) {
  if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
  throw error;
 } finally { await handle?.close(); }
}
export async function readNativeJson(file: string, strict = false): Promise<RecordValue | undefined> {
 const text = await safeText(file);
 if (text === undefined) {
  if (strict && await lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Graph receipt is not a bounded regular file.");
  return undefined;
 }
 try { const raw: unknown = JSON.parse(text); if (record(raw)) return raw; } catch { /* invalid JSON */ }
 if (strict) throw new Error("Graph receipt is malformed.");
 return undefined;
}
function within(root: string, target: string): boolean {
 const path = relative(root, target);
 return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function receiptDigest(completion: RecordValue): string {
 // Delivery annotations and summaries may differ between file and event.
 return canonicalDigest({ state: completion.state, success: completion.success ?? null, results: completion.results.map((r: RecordValue) => ({
  output: r.finalOutput, success: r.success ?? null, error: r.error ?? null,
  timedOut: r.timedOut === true, stopped: r.stopped === true, interrupted: r.interrupted === true, skipped: r.skipped === true,
 })) });
}

/** Scoped before spawn; keeps fast completion alive across the reply/monitor gap. */
export class NativeResultCapture {
 private off?: () => void;
 private pending: RecordValue[] = [];
 private identity?: NativeRunIdentity;
 private path?: string;
 private queue: Promise<void> = Promise.resolve();
 private error?: unknown;
 private closed = false;
 private pendingBytes = 0;
 constructor(events: EventBus) {
  const off = events.on(NATIVE_COMPLETE_EVENT, raw => {
   if (this.closed || !record(raw)) return;
   if (this.identity) {
    if ((raw.runId ?? raw.id) !== this.identity.asyncId) return;
    this.enqueue(raw);
   } else {
    // Only the bounded spawn-reply window needs this buffer. Recovery also
    // reads upstream's public result/replay if a very busy bus overflows it.
    const bytes = Buffer.byteLength(JSON.stringify(raw));
    if (bytes > MAX_RESULT_BYTES || this.pendingBytes + bytes > MAX_RESULT_BYTES || this.pending.length >= 32) return;
    this.pendingBytes += bytes;
    this.pending.push(structuredClone(raw));
   }
  });
  if (typeof off === "function") this.off = off;
 }
 private enqueue(value: RecordValue): void {
  const copy = structuredClone(value);
  const identity = this.identity!, path = this.path;
  const capture = async () => {
   const status = await readNativeJson(join(identity.asyncDir, "status.json"));
   if (!status) { this.pending.push(copy); return; }
   await captureNativeResultUnlocked(identity, path, status, copy, "event");
  };
  // Reserve ownership synchronously, before status I/O or instance-local waits.
  const operation = path ? withReceiptWrite(path, capture) : this.queue.then(capture);
  this.queue = operation.catch(error => { this.error = error; });
 }
 async bind(identity: NativeRunIdentity, path?: string): Promise<void> {
  assertAsyncRunIdentity(identity.asyncId, identity.asyncDir);
  this.identity = identity; this.path = path; this.pendingBytes = 0;
  for (const value of this.pending.splice(0)) if ((value.runId ?? value.id) === identity.asyncId) this.enqueue(value);
  await this.flush();
 }
 async flush(): Promise<void> {
  if (this.identity) for (const value of this.pending.splice(0)) this.enqueue(value);
  await this.queue;
  if (this.error) throw this.error;
 }
 async close(): Promise<void> { this.closed = true; this.off?.(); this.off = undefined; await this.queue; }
}

function withReceiptWrite<T>(path: string | undefined, run: () => Promise<T>): Promise<T> {
 if (!path) return run();
 const prior = receiptWrites.get(path) ?? Promise.resolve();
 const operation = prior.catch(() => undefined).then(run);
 receiptWrites.set(path, operation);
 return operation.finally(() => { if (receiptWrites.get(path) === operation) receiptWrites.delete(path); });
}
async function captureNativeResultUnlocked(identity: NativeRunIdentity, path: string | undefined, status: RecordValue,
 raw: RecordValue, source: NativeReceipt["source"]): Promise<NativeReceipt | undefined> {
 if ((raw.runId ?? raw.id) !== identity.asyncId || status.runId !== identity.asyncId) return undefined;
 if (raw.asyncDir !== undefined && raw.asyncDir !== identity.asyncDir) return undefined;
 if (typeof status.sessionId !== "string" || !status.sessionId || raw.sessionId !== status.sessionId) return undefined;
 if (!["complete", "failed", "stopped", "paused", "partial"].includes(raw.state)) return undefined;
 if (!Array.isArray(raw.results) || (raw.state === "complete" && !raw.results.length)) return undefined;
 const results: RecordValue[] = [];
 for (const child of raw.results) {
  if (!record(child)) return undefined;
  let output: string | undefined;
  const artifact = child.artifactPaths?.outputPath;
  // Never read arbitrary session/log paths as if they were a final answer.
  if (typeof artifact === "string" && isAbsolute(artifact)
   && [path ? dirname(path) : undefined, status.cwd, status.artifactsDir, identity.asyncDir, dirname(subagentAsyncRoot())]
    .some(root => typeof root === "string" && within(root, artifact))) output = await safeText(artifact);
  if (output === undefined && child.truncated !== true && typeof child.output === "string") output = child.output;
  if (output === undefined && raw.state === "complete") return undefined;
  results.push({ ...child, finalOutput: output ?? "" });
 }
 const completion = { ...raw, state: raw.state === "partial" ? "paused" : raw.state, results };
 const receipt: NativeReceipt = { version: 1, runId: identity.asyncId, asyncDir: identity.asyncDir,
  sessionId: status.sessionId, status, source, capturedAt: new Date().toISOString(), completion, digest: canonicalDigest({ completion, status }) };
 if (path) {
  const previous = await readNativeReceipt(identity, path, status);
  if (previous) {
   if (receiptDigest(previous.completion) !== receiptDigest(receipt.completion)) throw new Error("Conflicting pi-subagents final results; reconciliation required.");
   return previous;
  }
  await atomicWriteJson(path, receipt);
 }
 return receipt;
}
export async function readNativeReceipt(identity: NativeRunIdentity, path: string, status: RecordValue): Promise<NativeReceipt | undefined> {
 const raw = await readNativeJson(path, true);
 if (!raw) return undefined;
 if (raw.version !== 1 || raw.runId !== identity.asyncId || raw.asyncDir !== identity.asyncDir || raw.sessionId !== status.sessionId
  || !record(raw.completion) || !Array.isArray(raw.completion.results) || raw.digest !== canonicalDigest({ completion: raw.completion, status: raw.status })) {
  throw new Error("Graph child-result receipt identity or digest mismatch.");
 }
 return raw as unknown as NativeReceipt;
}
export async function reconcileNativeResult(identity: NativeRunIdentity, path: string | undefined, status: RecordValue,
 event?: RecordValue): Promise<NativeReceipt | undefined> {
 return withReceiptWrite(path, () => reconcileNativeResultUnlocked(identity, path, status, event));
}
async function reconcileNativeResultUnlocked(identity: NativeRunIdentity, path: string | undefined, status: RecordValue,
 event?: RecordValue): Promise<NativeReceipt | undefined> {
 // Owned worker may publish output just before its guardian observes physical close.
 // Freeze the receipt only after that independent lifecycle evidence is available.
 if(status.runtimeKind==='pi-graph-sdk/1'&&!status.processTerminal?.runnerProcessInstanceId)return undefined;
 if (path) { const receipt = await readNativeReceipt(identity, path, status); if (receipt) return receipt; }
 if (event) { const receipt = await captureNativeResultUnlocked(identity, path, status, event, "event"); if (receipt) return receipt; }
 const owned = await readNativeJson(join(identity.asyncDir, 'result.json'));
 if (owned && status.runtimeKind === 'pi-graph-sdk/1') return captureNativeResultUnlocked(identity, path, status, owned, 'result');
 const root = nativeResultsDir();
 const raw = await readNativeJson(join(root, `${identity.asyncId}.json`));
 if (raw) { const receipt = await captureNativeResultUnlocked(identity, path, status, raw, "result"); if (receipt) return receipt; }
 const replay = await readNativeJson(join(root, "completion-replay", `${encodeURIComponent(identity.asyncId)}.json`));
 if (!replay || replay.version !== 1 || replay.runId !== identity.asyncId || replay.sessionId !== status.sessionId
  || !(replay.expiresAt > Date.now()) || !record(replay.completion) || replay.completion.runId !== identity.asyncId) return undefined;
 const archive = await readNativeJson(join(root, "output-archives", `${encodeURIComponent(identity.asyncId)}.json`));
 if (!archive || archive.version !== 1 || archive.runId !== identity.asyncId || !Array.isArray(archive.entries)
  || !Array.isArray(replay.completion.results)) return undefined;
 const results = replay.completion.results.map((child: RecordValue, i: number) => {
  const entry = archive.entries.find((v: unknown) => record(v) && v.resultIndex === i);
  return { ...child,
   ...(entry?.source === "output-artifact" ? { artifactPaths: { ...child.artifactPaths, outputPath: entry.path } } : {}),
   ...(entry?.source === "result-tail" ? { output: entry.text, truncated: entry.truncated === true } : {}),
  };
 });
 return captureNativeResultUnlocked(identity, path, status, { ...replay.completion, sessionId: replay.sessionId, results }, "replay");
}
