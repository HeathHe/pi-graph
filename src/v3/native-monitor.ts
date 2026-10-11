import {completionOutput} from './result-output.ts';
import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "./durable.ts";
import { observeV3ChildLifecycle, v3ChildObservationFingerprint } from "./observability.ts";
import { confirmedProcessExit } from "./supervision.ts";
import { assertAsyncRunIdentity, type EventBus } from "./rpc.ts";
import { NATIVE_COMPLETE_EVENT, readNativeJson, reconcileNativeResult, type NativeResultCapture } from "./native-results.ts";
import type { AsyncTerminal } from "./lifecycle.ts";
import type { V3ChildObservation } from "./types.ts";

/** Native upstream completion and public physical-exit proof are separate gates. */
export async function waitForNativeAsyncRun(input: {
 ownerSessionId?: string; ownerSessionFile?: string; agent?: string;
 events: EventBus; asyncId: string; asyncDir: string; resultPath?: string;
 capture?: NativeResultCapture; signal?: AbortSignal;
 probe?: () => Promise<void>; probeIntervalMs?: number;
 onObservation?: (observation: V3ChildObservation) => void | Promise<void>;
}): Promise<AsyncTerminal> {
 assertAsyncRunIdentity(input.asyncId, input.asyncDir);
 return new Promise((resolve, reject) => {
  let settled = false, checking = false, dirty = false, probing = false;
  let pendingFinish: (() => void) | undefined;
  let completion: Record<string, any> | undefined;
  let fingerprint: string | undefined;
  let probeState: "available" | "unreachable" | "not_checked" = "not_checked";
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let off: (() => void) | void;
  const finish = (action: () => void) => {
   if (settled) return;
   settled = true; if (timer) clearInterval(timer); watcher?.close(); off?.();
   input.signal?.removeEventListener("abort", onAbort);
   if (checking) pendingFinish = action; else action();
  };
  const onAbort = () => finish(() => reject(new Error("Graph node monitoring aborted.")));
  const check = async () => {
   if (settled) return;
   if (checking) { dirty = true; return; }
   checking = true;
   try {
    await input.capture?.flush();
    const saved = input.resultPath ? await readNativeJson(input.resultPath, true) : undefined;
    let status = await readNativeJson(join(input.asyncDir, "status.json")) ?? saved?.status;
    if (!status) return;
    if (status.runId !== input.asyncId) throw new Error("Subagent status identity mismatch.");
    const proofPath = input.resultPath ? join(dirname(input.resultPath), "child-process-terminal.json") : undefined;
    const proof = await readNativeJson(join(input.asyncDir, "process-terminal.json"))
     ?? (proofPath ? await readNativeJson(proofPath) : undefined);
    const owned=status.runtimeKind==='pi-graph-sdk/1';
    const exited = (!owned||(typeof status.runnerProcessInstanceId==='string'&&proof?.runtimeKind==='pi-graph-sdk/1')) && confirmedProcessExit(proof, input.asyncId, owned?status.runnerProcessInstanceId:undefined);
    // The guardian publishes physical proof before its final status marker. Use
    // only the independently validated matching proof to bridge that atomic-file
    // window, so a valid startup-failure receipt wins over a generic crash text.
    if(exited && status.runtimeKind==='pi-graph-sdk/1' && !status.processTerminal?.runnerProcessInstanceId)
     status={...status,processTerminal:{runnerProcessInstanceId:proof!.runnerProcessInstanceId}};
    const receipt = await reconcileNativeResult(input, input.resultPath, status, completion);
    if (receipt) completion = undefined;
    if (exited && proofPath && !(await readNativeJson(proofPath))) await atomicWriteJson(proofPath, proof);
    const observation = observeV3ChildLifecycle({ asyncId: input.asyncId, status,
     ...(receipt ? { completion: receipt.completion } : {}) });
    const supervision = observation.supervision!;
    supervision.probe = probeState;
    // A responsive parent RPC does not prove the child/model is making progress.
    supervision.health = exited ? "exited" : "unknown";
    supervision.processExitConfirmed = exited;
    if (exited && proof) supervision.runnerInstanceId = proof.runnerProcessInstanceId;
    const runner = Array.isArray(proof?.instances) ? proof.instances.find((v: Record<string, any>) => v.kind === "runner") : undefined;
    const crashed = exited && !receipt && (runner?.signal != null || (typeof runner?.exitCode === "number" && runner.exitCode !== 0))
     && !["complete", "stopped", "paused"].includes(status.state);
    const failedExit=exited && (runner?.signal != null || (typeof runner?.exitCode==="number"&&runner.exitCode!==0));
    if (failedExit) supervision.runtimeFailure = true;
    if (exited && !receipt) {
     supervision.attention = crashed ? "runtime_exited" : "result_unavailable";
     supervision.error = crashed ? "Runner exit confirmed before final result publication."
      : "Runner exited but a complete final result is unavailable; reconciliation required.";
    }
    const next = v3ChildObservationFingerprint(observation);
    if (fingerprint !== next) { fingerprint = next; await input.onObservation?.(observation); }
    if (settled || !exited) return;
    if (crashed) { finish(() => resolve({ state: "failed", status, output: supervision.error!, observation })); return; }
    if (!receipt) return;
    const result = receipt.completion;
    const successful = !failedExit && result.state === "complete" && result.success !== false
     && result.results.every((r: Record<string, any>) => r.success !== false && !r.timedOut && !r.stopped && !r.interrupted && !r.skipped);
    const state: AsyncTerminal["state"] = successful ? "complete" : result.state === "stopped" ? "stopped" : result.state === "paused" ? "paused" : "failed";
    const output = completionOutput(result);
    finish(() => resolve({ state, status, completion: result, output, observation }));
   } catch (error) { finish(() => reject(error)); }
   finally { checking = false; const action = pendingFinish; pendingFinish = undefined; action?.(); if (dirty && !settled) { dirty = false; void check(); } }
  };
  const probe = async () => {
   if (!input.probe || settled || probing) return;
   probing = true;
   try { await input.probe(); probeState = "available"; } catch { probeState = "unreachable"; }
   finally { probing = false; if (!settled) void check(); }
  };
  off = input.events.on(NATIVE_COMPLETE_EVENT, raw => {
   const value = raw as Record<string, any> | undefined;
   if (!value || (value.runId ?? value.id) !== input.asyncId || (value.asyncDir !== undefined && value.asyncDir !== input.asyncDir)) return;
   completion = value; void check();
  });
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) { onAbort(); return; }
  try { watcher = watch(input.asyncDir, () => { void check(); }); watcher.on("error", () => { watcher?.close(); watcher = undefined; }); } catch {}
  timer = setInterval(() => { void check(); void probe(); }, input.probeIntervalMs ?? 30_000);
  void check().then(() => { void probe(); });
 });
}
