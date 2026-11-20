import { SchedulerCore, type SchedulerCoreOptions } from "pi-maestro-teammate/v1/scheduler";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeCardText, toolCallLine, toolResultCard } from "pi-cockpit/src/quiet-tools.ts";
import type { FlowToolResult } from "./tool-result.ts";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_RUNS = 10;
const MAX_RUNS = 1_000;
const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60_000;
const MAX_SHELL_TIMEOUT_MS = 60 * 60_000;
const MAX_LOOPS = 32;
const OUTPUT_LIMIT = 1_000;

const LOOP_BASE_DIR = path.join(os.tmpdir(), "pi-loops");
const REGISTRY_PATH = path.join(LOOP_BASE_DIR, "registry.json");

function loopLogDir(loopId: string): string {
  return path.join(LOOP_BASE_DIR, loopId);
}

interface RegistryEntry {
  id: string;
  task: string;
  intervalMs: number;
  maxRuns: number;
  runCount: number;
  cwd: string;
  pid: number;
  startedAt: number;
}

function readRegistry(): RegistryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as RegistryEntry[];
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  fs.mkdirSync(LOOP_BASE_DIR, { recursive: true });
  const tmp = `${REGISTRY_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const LOOP_UPDATE_EVENT = "loop:update";
export const LOOP_QUERY_EVENT = "loop:query";
/** Resource observations only; never a Task/Goal completion or another execution request. */
export const LOOP_EXECUTION_EVENT = "loop:execution";

export type LoopKind = "prompt" | "shell";
export type LoopStatus = "scheduled" | "running" | "completed" | "failed" | "cancelled";
export type LoopTerminalOutcome = "failed" | "completed";

// Stable glyph + text per state (ui-conventions-004): color only enhances.
const STATUS_GLYPH: Record<LoopStatus, string> = {
  scheduled: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
};

export interface LoopRunResult {
  ok: boolean;
  summary: string;
  /** The command may have run, but no normal terminal result was confirmed. */
  outcomeUnknown?: boolean;
}

export interface LoopExecutionObservation {
  id: string;
  state: "pending" | "returned" | "unknown";
  startedAt: number;
  observedAt?: number;
  result?: { ok: boolean; summary: string };
  reason?: string;
}

export interface LoopJobSnapshot {
  id: string;
  kind: LoopKind;
  task: string;
  intervalMs: number;
  maxRuns: number;
  runCount: number;
  status: LoopStatus;
  createdAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastResult?: string;
  cwd?: string;
  timeoutMs?: number;
  logDir?: string;
  /** Original call observation; a returned call is not a process-tree reaping receipt. */
  execution?: LoopExecutionObservation;
  /** Issued only at new creation, never inferred from legacy persisted status. */
  birthId?: string;
  /** Persisted before external spawn; neither a missing PID nor reload authorizes local replay. */
  detached?: "transferring" | "issued";
}

type LoopJob = LoopJobSnapshot;

interface LoopExecution {
  id: string;
  generation: number;
  job: LoopJob;
  signal: AbortSignal;
  startedAt: number;
  promise: Promise<void>;
  quitDrain: boolean;
  retired: boolean;
  unknownReason?: string;
  cancelQuitWait?: () => void;
}

const QUIT_EXEC_OBSERVATION_GRACE_MS = 5_100;


export interface CreateLoopInput {
  kind: LoopKind;
  task: string;
  intervalMs: number;
  maxRuns?: number;
  cwd?: string;
  timeoutMs?: number;
}

export interface LoopSchedulerOptions {
  execute(job: LoopJobSnapshot): Promise<LoopRunResult>;
  /** Trusted synchronous host commit. No port means volatile state, never restart authority. */
  commit?: (jobs: LoopJobSnapshot[]) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Called after every state change (create, cancel, run completion). */
  onUpdate?: (jobs: LoopJobSnapshot[]) => void;
  /** Called once when a loop reaches a terminal outcome (failed or completed). */
  onTerminal?: (job: LoopJobSnapshot, outcome: LoopTerminalOutcome) => void;
  /** Separate resource fact channel; cancelled late business updates remain fenced. */
  onExecutionObservation?: (job: LoopJobSnapshot) => void;
  onError?: (error: unknown, taskId: string) => void;
}

export class LoopScheduler {
  private readonly jobs = new Map<string, LoopJob>();
  private readonly commitState?: LoopSchedulerOptions["commit"];
  private readonly executeJob: LoopSchedulerOptions["execute"];
  private readonly now: () => number;
  private core: SchedulerCore;
  private readonly coreOptions: SchedulerCoreOptions;
  private readonly onUpdate?: LoopSchedulerOptions["onUpdate"];
  private readonly onTerminal?: LoopSchedulerOptions["onTerminal"];
  private readonly onExecutionObservation?: LoopSchedulerOptions["onExecutionObservation"];
  private counter = 0;
  private readonly inFlight = new Map<string, LoopExecution>();
  private readonly setTimer: NonNullable<LoopSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<LoopSchedulerOptions["clearTimer"]>;
  private quitClosing = false;
  private lifecycleGeneration = 0;
  private quitHandoffPromise?: Promise<{ jobs: LoopJobSnapshot[]; unknown: LoopJobSnapshot[] }>;


  constructor(options: LoopSchedulerOptions) {
    this.executeJob = options.execute;
    this.commitState = options.commit;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.coreOptions = {
      now: this.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      onError: options.onError,
    };
    this.core = new SchedulerCore(this.coreOptions);
    this.onUpdate = options.onUpdate;
    this.onTerminal = options.onTerminal;
    this.onExecutionObservation = options.onExecutionObservation;
  }

  create(input: CreateLoopInput): LoopJobSnapshot {
    if (this.quitClosing) throw new Error("Loop scheduler is closing; new work is not admitted.");
    if (!input.task.trim()) throw new Error("task is required.");
    if (!Number.isInteger(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS || input.intervalMs > MAX_INTERVAL_MS) {
      throw new Error(`intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}.`);
    }
    const maxRuns = input.maxRuns ?? DEFAULT_MAX_RUNS;
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_RUNS) {
      throw new Error(`maxRuns must be an integer between 1 and ${MAX_RUNS}.`);
    }
    const timeoutMs = input.kind === "shell" ? (input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_SHELL_TIMEOUT_MS)) {
      throw new Error(`timeoutMs must be an integer between 1000 and ${MAX_SHELL_TIMEOUT_MS}.`);
    }
    const activeCount = [...this.jobs.values()].filter((job) => !job.detached && (job.status === "scheduled" || job.status === "running")).length;
    if (activeCount >= MAX_LOOPS) throw new Error(`At most ${MAX_LOOPS} loops may be active.`);

    const createdAt = this.now();
    const job: LoopJob = {
      id: `loop-${(++this.counter).toString(36)}-${createdAt.toString(36)}`,
      kind: input.kind,
      task: input.task.trim(),
      intervalMs: input.intervalMs,
      maxRuns,
      runCount: 0,
      status: "scheduled",
      createdAt,
      birthId: this.commitState ? randomUUID() : undefined,
      cwd: input.cwd,
      timeoutMs,
      logDir: input.kind === "shell" ? loopLogDir(`loop-${this.counter.toString(36)}-${createdAt.toString(36)}`) : undefined,
    };
    this.jobs.set(job.id, job);
    try {
      // Scheduling is synchronous: no timer can run before this stack commits or cancels it.
      // A scheduling failure must not leave a confirmed queue in the SDK journal.
      this.schedule(job);
      this.commit();
    } catch (error) {
      this.core.cancel(job.id);
      this.jobs.delete(job.id);
      throw error;
    }
    this.onUpdate?.(this.list());
    return this.snapshot(job);
  }

  list(): LoopJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((job) => this.snapshot(job));
  }

  cancel(id: string): LoopJobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.detached) throw new Error("This loop was handed off outside this session; its remaining runs were not cancelled here.");
    if (job.status === "cancelled") return this.snapshot(job);
    const record = this.inFlight.get(id);
    if (job.kind === "shell" && record && this.isCurrentExecution(record)) {
      job.execution = { id: record.id, state: "pending", startedAt: record.startedAt };
    }
    this.core.cancel(id);
    if (job.status === "scheduled" || job.status === "running") {
      job.status = "cancelled";
      job.nextRunAt = undefined;
    }
    this.emitUpdate();
    if (job.execution?.state === "pending") this.onExecutionObservation?.(this.snapshot(job));
    return this.snapshot(job);
  }

  /**
   * Restore a job from a persisted snapshot, preserving runCount and id.
   * The job is rescheduled immediately if it has remaining runs.
   */
  restore(snapshot: LoopJobSnapshot, confirmed = false): LoopJobSnapshot {
    if (this.quitClosing) throw new Error("Loop scheduler is closing; restored work is not admitted.");
    if (snapshot.status === "cancelled" && snapshot.kind === "shell" && snapshot.execution) {
      const old = snapshot.execution;
      const valid = typeof old.id === "string" && old.id.length > 0 && Number.isFinite(old.startedAt);
      const returned = valid && old.state === "returned" && Number.isFinite(old.observedAt)
        && old.observedAt! >= old.startedAt && typeof old.result?.ok === "boolean"
        && typeof old.result.summary === "string";
      const job: LoopJob = { ...snapshot, nextRunAt: undefined, execution: returned
        ? { ...old, result: { ...old.result! } }
        : { id: valid ? old.id : `${snapshot.id}:unconfirmed`, state: "unknown",
          startedAt: valid ? old.startedAt : snapshot.lastRunAt ?? snapshot.createdAt,
          observedAt: this.now(), reason: old.state === "unknown" && typeof old.reason === "string"
            ? old.reason : "No original terminal observation survived this session handoff" } };
      this.jobs.set(job.id, job);
      this.emitUpdate();
      return this.snapshot(job);
    }
    if (snapshot.detached) {
      // Transfer authority and the prior execution result are different facts. Keep a known return
      // intact; an unconfirmed transfer is never permission to replay it locally.
      const job: LoopJob = { ...snapshot, nextRunAt: undefined,
        detached: confirmed ? snapshot.detached : "transferring" };
      this.jobs.set(job.id, job);
      this.onUpdate?.(this.list());
      return this.snapshot(job);
    }
    if (snapshot.runCount >= snapshot.maxRuns) return snapshot;
    if (snapshot.status === "cancelled" || snapshot.status === "failed") return snapshot;
    if (!confirmed || !snapshot.birthId || snapshot.execution?.state === "pending"
      || snapshot.execution?.state === "unknown" || snapshot.status === "running") {
      const reason = "Prior loop execution is unconfirmed; review this loop before creating replacement work";
      const job: LoopJob = { ...snapshot, status: "failed", nextRunAt: undefined,
        execution: { id: snapshot.execution?.id ?? `${snapshot.id}:unconfirmed`, state: "unknown",
          startedAt: snapshot.execution?.startedAt ?? snapshot.lastRunAt ?? snapshot.createdAt,
          observedAt: this.now(), reason }, lastResult: reason };
      this.jobs.set(job.id, job);
      this.onUpdate?.(this.list());
      this.onExecutionObservation?.(this.snapshot(job));
      return this.snapshot(job);
    }
    const job: LoopJob = {
      id: snapshot.id,
      kind: snapshot.kind,
      task: snapshot.task,
      intervalMs: snapshot.intervalMs,
      maxRuns: snapshot.maxRuns,
      runCount: snapshot.runCount,
      status: "scheduled",
      createdAt: snapshot.createdAt,
      lastRunAt: snapshot.lastRunAt,
      lastResult: snapshot.lastResult,
      birthId: snapshot.birthId,
      execution: snapshot.execution,
      cwd: snapshot.cwd,
      timeoutMs: snapshot.timeoutMs,
      logDir: snapshot.kind === "shell" ? loopLogDir(snapshot.id) : undefined,
    };
    this.jobs.set(job.id, job);
    try {
      this.schedule(job);
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }
    this.emitUpdate();
    return this.snapshot(job);
  }

  /** Clear all timers but keep jobs in the map (for reload teardown). */
  pause(): void {
    try { this.invalidateExecutionObservations("Session reload ended the original execution observation"); }
    finally {
      this.lifecycleGeneration++;
      this.core.pause();
      for (const job of this.jobs.values()) job.nextRunAt = undefined;
    }
  }

  resume(): void {
    if (this.quitClosing) return;
    this.core.resume();
    for (const job of this.jobs.values()) {
      if (job.status === "scheduled" && !job.detached) job.nextRunAt = this.now() + job.intervalMs;
    }
    this.emitUpdate();
  }

  /** Re-arm this reusable service after a session replacement shutdown. */
  reset(): void {
    if (!this.core.isShutdown) return;
    this.core = new SchedulerCore(this.coreOptions);
    this.quitClosing = false;
    this.quitHandoffPromise = undefined;
  }

  /** Freeze new ticks synchronously, then reconcile only this quit's exact executions. */
  prepareQuitHandoff(): Promise<{ jobs: LoopJobSnapshot[]; unknown: LoopJobSnapshot[] }> {
    if (this.quitHandoffPromise) return this.quitHandoffPromise;
    this.quitClosing = true;
    const generation = this.lifecycleGeneration;
    const selected = [...this.inFlight.values()].filter((record) =>
      record.job.kind === "shell" && record.job.status === "running"
      && !record.signal.aborted && !record.retired && this.jobs.get(record.job.id) === record.job);
    const cancelled = [...this.inFlight.values()].filter((record) =>
      this.isCurrentExecution(record) && record.job.kind === "shell"
      && record.job.status === "cancelled" && record.job.execution?.state === "pending");
    for (const record of selected) record.quitDrain = true;
    // Core.pause aborts its scheduling signal, not the already-running pi.exec.
    this.core.pause();
    for (const job of this.jobs.values()) job.nextRunAt = undefined;
    this.quitHandoffPromise = Promise.all([...selected, ...cancelled].map((record) => this.awaitQuitExecution(record)))
      .then(() => this.lifecycleGeneration !== generation ? { jobs: [], unknown: [] } : ({
        jobs: this.list().filter((job) => job.kind === "shell" && job.status === "scheduled"
          && job.runCount < job.maxRuns && !job.detached),
        unknown: this.list().filter((job) => job.status === "cancelled" && job.execution?.state === "unknown"
          || selected.some((record) => record.job === this.jobs.get(job.id) && record.unknownReason !== undefined)),
      }));
    return this.quitHandoffPromise;
  }

  /** Original owner drains its exact calls before the SDK may create another owner. */
  async prepareReloadHandoff(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const handoff = await this.prepareQuitHandoff();
    if (generation !== this.lifecycleGeneration) return;
    this.commit();
    // An unresolved call is local to its loop; other confirmed remaining jobs can still recover.
    for (const job of handoff.unknown) this.onExecutionObservation?.(job);
  }

  markDetached(id: string, state: "transferring" | "issued"): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "scheduled") throw new Error("Loop is no longer available for transfer");
    this.core.cancel(job.id);
    job.detached = state;
    job.nextRunAt = undefined;
    this.emitUpdate();
  }

  private async awaitQuitExecution(record: LoopExecution): Promise<void> {
    const deadline = record.startedAt + (record.job.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS)
      + QUIT_EXEC_OBSERVATION_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let releaseWait!: () => void;
    const invalidated = new Promise<void>((resolve) => { releaseWait = resolve; });
    const cancelQuitWait = () => {
      if (timer !== undefined) { this.clearTimer(timer); timer = undefined; }
      releaseWait();
    };
    record.cancelQuitWait = cancelQuitWait;
    try {
      await Promise.race([
        invalidated,
        record.promise.catch((error) => {
          if (this.isCancelled(record.job)) throw error; // Observation/persistence errors remain the original error.
          this.markExecutionUnknown(record, `execution rejected: ${error instanceof Error ? error.message : String(error)}`);
        }),
        new Promise<void>((resolve, reject) => {
          timer = this.setTimer(() => {
            try {
              this.markExecutionUnknown(record, "configured execution timeout and observation grace elapsed");
              resolve();
            } catch (error) { reject(error); }
          }, Math.max(0, deadline - this.now()));
        }),
      ]);
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
      if (record.cancelQuitWait === cancelQuitWait) delete record.cancelQuitWait;
    }
  }

  private markExecutionUnknown(record: LoopExecution, reason: string): void {
    if (this.isCancelled(record.job)) {
      if (!this.isCurrentExecution(record) || record.job.execution?.state !== "pending") return;
      record.unknownReason = reason;
      record.retired = true;
      this.setExecutionObservation(record, { id: record.id, state: "unknown", startedAt: record.startedAt,
        observedAt: this.now(), reason });
      return;
    }
    if (record.retired || this.jobs.get(record.job.id) !== record.job
      || (this.inFlight.get(record.job.id) !== record
        && !(record.quitDrain && this.quitClosing && this.inFlight.get(record.job.id) === undefined))
      || this.isCancelled(record.job)) return;
    record.retired = true;
    record.unknownReason = reason;
    record.job.status = "failed";
    record.job.execution = { id: record.id, state: "unknown", startedAt: record.startedAt,
      observedAt: this.now(), reason };
    record.job.nextRunAt = undefined;
    record.job.lastResult = `Prior execution outcome unknown; remaining loop was not handed off: ${reason}`.slice(0, OUTPUT_LIMIT);
    this.core.cancel(record.job.id);
    this.emitUpdate();
    this.onTerminal?.(this.snapshot(record.job), "failed");
  }

  shutdown(): void {
    try { this.invalidateExecutionObservations("Session closed without an original terminal observation"); }
    finally {
      this.lifecycleGeneration++;
      for (const record of this.inFlight.values()) {
        record.retired = true;
        record.cancelQuitWait?.();
      }
      this.inFlight.clear();
      this.core.shutdown();
      for (const job of this.jobs.values()) { job.status = "cancelled"; job.nextRunAt = undefined; }
      this.jobs.clear();
    }
  }

  private isCurrentExecution(record: LoopExecution): boolean {
    return !record.retired && record.generation === this.lifecycleGeneration
      && this.jobs.get(record.job.id) === record.job && this.inFlight.get(record.job.id) === record;
  }

  private setExecutionObservation(record: LoopExecution, observation: LoopExecutionObservation): void {
    record.job.execution = observation;
    this.commit();
    this.onExecutionObservation?.(this.snapshot(record.job));
  }

  private invalidateExecutionObservations(reason: string): void {
    let failed = false; let primary: unknown;
    for (const record of this.inFlight.values()) {
      if (!this.isCurrentExecution(record) || record.job.execution?.state !== "pending") continue;
      try { this.markExecutionUnknown(record, reason); }
      catch (error) { if (!failed) { failed = true; primary = error; } }
      finally { record.retired = true; record.cancelQuitWait?.(); }
    }
    if (failed) throw primary;
  }

  private schedule(job: LoopJob): void {
    if (job.detached || job.status === "cancelled" || job.runCount >= job.maxRuns) return;
    job.status = "scheduled";
    job.nextRunAt = this.now() + job.intervalMs;
    this.core.schedule({
      id: job.id,
      intervalMs: job.intervalMs,
      run: ({ signal }) => this.run(job, signal),
    });
  }

  private run(job: LoopJob, signal: AbortSignal): Promise<void> {
    if (this.quitClosing || job.detached || signal.aborted || this.isCancelled(job) || this.jobs.get(job.id) !== job) return Promise.resolve();
    let resolveRun!: () => void;
    let rejectRun!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    const record: LoopExecution = {
      id: randomUUID(), generation: this.lifecycleGeneration,
      job, signal, startedAt: this.now(), promise: completion, quitDrain: false, retired: false,
    };
    // Install the exact completion before executeJob can yield or re-enter a quit.
    this.inFlight.set(job.id, record);
    const release = () => { if (this.inFlight.get(job.id) === record) this.inFlight.delete(job.id); };
    void this.runExecution(record).then(() => { release(); resolveRun(); }, (error) => { release(); rejectRun(error); });
    return completion;
  }

  private async runExecution(record: LoopExecution): Promise<void> {
    const { job, signal } = record;
    job.status = "running";
    job.nextRunAt = undefined;
    job.lastRunAt = record.startedAt;
    job.execution = { id: record.id, state: "pending", startedAt: record.startedAt };
    try { this.commit(); }
    catch (error) {
      record.retired = true;
      job.status = "failed";
      job.execution = { ...job.execution, state: "unknown", observedAt: this.now(),
        reason: "Execution record could not be saved; command was not started" };
      this.core.cancel(job.id);
      this.onUpdate?.(this.list());
      throw error;
    }

    let result: LoopRunResult;
    try {
      result = await this.executeJob(this.snapshot(job));
    } catch (error) {
      result = { ok: false, outcomeUnknown: true, summary: error instanceof Error ? error.message : String(error) };
    }

    if (this.isCancelled(job) && this.isCurrentExecution(record) && job.execution?.state === "pending") {
      if (result.outcomeUnknown) {
        record.unknownReason = result.summary;
        this.setExecutionObservation(record, { id: record.id, state: "unknown", startedAt: record.startedAt,
          observedAt: this.now(), reason: result.summary });
      } else {
        this.setExecutionObservation(record, { id: record.id, state: "returned", startedAt: record.startedAt,
          observedAt: this.now(), result: { ok: result.ok, summary: result.summary.slice(0, OUTPUT_LIMIT) } });
      }
      return;
    }
    if (record.retired || this.isCancelled(job) || this.jobs.get(job.id) !== job
      || this.inFlight.get(job.id) !== record || (signal.aborted && !record.quitDrain)) return;
    if (result.outcomeUnknown) {
      this.markExecutionUnknown(record, result.summary);
      return;
    }
    // These fields are committed together by emitUpdate: never publish returned with an old count.
    job.execution = { id: record.id, state: "returned", startedAt: record.startedAt,
      observedAt: this.now(), result: { ok: result.ok, summary: result.summary.slice(0, OUTPUT_LIMIT) } };
    job.runCount++;
    job.lastResult = result.summary.slice(0, OUTPUT_LIMIT);
    if (!result.ok) {
      job.status = "failed";
      this.core.cancel(job.id);
      this.emitExecutionUpdate(record);
      this.onTerminal?.(this.snapshot(job), "failed");
      return;
    }
    if (job.runCount >= job.maxRuns) {
      job.status = "completed";
      this.core.cancel(job.id);
      this.emitExecutionUpdate(record);
      this.onTerminal?.(this.snapshot(job), "completed");
      return;
    }
    job.status = "scheduled";
    job.nextRunAt = this.quitClosing ? undefined : this.now() + job.intervalMs;
    this.emitExecutionUpdate(record);
  }

  private isCancelled(job: LoopJob): boolean {
    return job.status === "cancelled";
  }

  private emitExecutionUpdate(record: LoopExecution): void {
    try { this.commit(); }
    catch (error) {
      record.retired = true;
      record.job.status = "failed";
      record.job.nextRunAt = undefined;
      record.job.execution = { id: record.id, state: "unknown", startedAt: record.startedAt,
        observedAt: this.now(), reason: "The returned execution could not be saved; remaining runs were stopped" };
      this.core.cancel(record.job.id);
      this.onUpdate?.(this.list());
      throw error;
    }
    this.onUpdate?.(this.list());
  }

  private commit(): void { this.commitState?.(this.list()); }

  private emitUpdate(): void {
    this.commit();
    this.onUpdate?.(this.list());
  }

  private snapshot(job: LoopJob): LoopJobSnapshot {
    return { ...job, ...(job.execution ? { execution: { ...job.execution,
      ...(job.execution.result ? { result: { ...job.execution.result } } : {}) } } : {}) };
  }
}

export const LoopParams = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")]),
  kind: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("shell")], { description: "Loop execution kind; required for create." })),
  task: Type.Optional(Type.String({ minLength: 1, description: "Prompt text or shell command; required for create." })),
  intervalMs: Type.Optional(Type.Integer({ minimum: MIN_INTERVAL_MS, maximum: MAX_INTERVAL_MS, description: "Fixed delay in milliseconds; required for create. For routine project supervision prefer 300000 (5 minutes), not 60000, unless the user specifies a cadence or a concrete latency requirement needs faster checks. Prompt delay is between enqueues, not completed agent turns." })),
  maxRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RUNS, default: DEFAULT_MAX_RUNS })),
  loopId: Type.Optional(Type.String({ minLength: 1, description: "Loop ID; required for cancel." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for shell loops." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_SHELL_TIMEOUT_MS, default: DEFAULT_SHELL_TIMEOUT_MS, description: "Per-run timeout for shell loops in milliseconds." })),
}, {
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { action: { const: "create" } }, required: ["action"] },
      then: { required: ["kind", "task", "intervalMs"] },
    },
    {
      if: { properties: { action: { const: "cancel" } }, required: ["action"] },
      then: { required: ["loopId"] },
    },
  ],
});

export interface LoopParamsInput {
  action: "create" | "list" | "cancel";
  kind?: LoopKind;
  task?: string;
  intervalMs?: number;
  maxRuns?: number;
  loopId?: string;
  cwd?: string;
  timeoutMs?: number;
}

function formatDuration(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatRelative(at: number, now: number): string {
  const delta = now - at;
  const abs = Math.abs(delta);
  const value = abs >= 86_400_000 ? `${Math.round(abs / 86_400_000)}d`
    : abs >= 3_600_000 ? `${Math.round(abs / 3_600_000)}h`
    : abs >= 60_000 ? `${Math.round(abs / 60_000)}m`
    : `${Math.max(1, Math.round(abs / 1_000))}s`;
  return delta >= 0 ? `${value} ago` : `in ${value}`;
}

/** Render one job as a single human-readable status line. Exported for tests. */
export function formatJob(job: LoopJobSnapshot, now: number = Date.now()): string {
  const parts = [
    `${STATUS_GLYPH[job.status]} ${job.id}`,
    job.detached ? (job.detached === "issued" ? "handed off" : "transfer unconfirmed") : job.status,
    job.kind,
    `every=${formatDuration(job.intervalMs)}`,
    `runs=${job.runCount}/${job.maxRuns}`,
    `"${truncateText(job.task, 40)}"`,
  ];
  if (job.nextRunAt !== undefined) parts.push(`next ${formatRelative(job.nextRunAt, now)}`);
  if (job.lastRunAt !== undefined) parts.push(`last ${formatRelative(job.lastRunAt, now)}`);
  const result = job.lastResult ? ` result=${truncateText(job.lastResult, 120)}` : "";
  const log = job.logDir ? ` log=${job.logDir}` : "";
  return `${parts.join(" ")}${result}${log}${job.execution ? ` current command ${{ pending: "still running", returned: "returned", unknown: "result unconfirmed" }[job.execution.state]}${job.execution.reason ? ` (${truncateText(job.execution.reason, 100)})` : ""}` : ""}`;
}

function formatJobCardRows(job: LoopJobSnapshot, now: number, expanded: boolean): string[] {
  const timing = [
    job.nextRunAt !== undefined ? `next ${formatRelative(job.nextRunAt, now)}` : "",
    job.lastRunAt !== undefined ? `last ${formatRelative(job.lastRunAt, now)}` : "",
  ].filter(Boolean).join(" · ");
  return [
    `${STATUS_GLYPH[job.status]} ${job.id} · ${job.detached ? (job.detached === "issued" ? "handed off" : "transfer unconfirmed") : job.status}`,
    `${job.kind} · every ${formatDuration(job.intervalMs)} · runs ${job.runCount}/${job.maxRuns}`,
    `task ${truncateText(job.task, expanded ? 240 : 80)}`,
    timing,
    job.lastResult ? `result ${truncateText(job.lastResult, expanded ? 400 : 120)}` : "",
    job.execution ? `current command ${{ pending: "still running", returned: "returned", unknown: "result unconfirmed" }[job.execution.state]}${job.execution.reason ? ` · ${truncateText(job.execution.reason, expanded ? 400 : 120)}` : ""}` : "",
    expanded && job.cwd ? `cwd ${job.cwd}` : "",
    expanded && job.logDir ? `log ${job.logDir}` : "",
  ].filter(Boolean);
}

/** Resolve a user-supplied loop id against known jobs: exact match, else unique prefix. */
export function resolveLoopId(requested: string, jobs: LoopJobSnapshot[]): { id: string } | { error: string } {
  const exact = jobs.find((j) => j.id === requested);
  if (exact) return { id: exact.id };
  const matches = jobs.filter((j) => j.id.startsWith(requested));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) return { error: `Unknown loopId: ${requested}` };
  return { error: `Ambiguous loopId "${requested}" matches: ${matches.map((j) => j.id).join(", ")}` };
}

function cancelledNotice(job: LoopJobSnapshot): string {
  return `Future runs cancelled for ${job.id}.${job.execution?.state === "pending"
    ? " The current command is still running."
    : job.execution?.state === "unknown" ? " The current command result is unconfirmed."
      : job.execution?.state === "returned" ? " The current command has returned." : ""}`;
}

export function parseLoopDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const result = amount * multiplier;
  return Number.isInteger(result) ? result : undefined;
}

type LoopBranchEntry = { type: string; id?: string; customType?: string; data?: unknown };
interface LoopSessionIdentity { sessionId: string; cwd: string }
interface LoopStateData extends LoopSessionIdentity { commitId: string; loops: LoopJobSnapshot[]; updatedAt: number }
function loopSessionIdentity(ctx: Pick<ExtensionContext, "sessionManager" | "cwd">): LoopSessionIdentity {
  return { sessionId: ctx.sessionManager.getSessionId(), cwd: fs.realpathSync(ctx.cwd) };
}
const loopDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unsavedSession = "This session has not saved its history yet; command was not started. Send an ordinary message, then retry.";

/** Same SDK journal, no side store: unacknowledged RAM entries never authorize a restart. */
export function commitLoopState(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: Pick<ExtensionContext, "sessionManager" | "cwd">,
  jobs: LoopJobSnapshot[],
): void {
  const file = ctx.sessionManager.getSessionFile();
  // The SDK buffers entries before its first real conversation. Reject before append, not after creating a RAM ghost.
  if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(unsavedSession);
  const prior = fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as { type?: string; message?: { role?: string } });
  if (!prior.some(row => row.type === "message" && (row.message?.role === "user" || row.message?.role === "assistant"))) throw new Error(unsavedSession);
  const data: LoopStateData = { ...loopSessionIdentity(ctx), commitId: randomUUID(), loops: jobs, updatedAt: Date.now() };
  pi.appendEntry("loop-state", data);
  const entry = ctx.sessionManager.getBranch().findLast((row) => row.type === "custom"
    && row.customType === "loop-state" && (row.data as Partial<LoopStateData> | undefined)?.commitId === data.commitId);
  if (!entry?.id) throw new Error("Loop state could not be verified in the current session branch; command was not started.");
  const expected = loopDigest(entry);
  let saved = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (row && typeof row === "object" && "id" in row && row.id === entry.id && loopDigest(row) === expected) { saved = true; break; }
  }
  if (!saved) throw new Error("Loop state was not saved to the session history; command was not started.");
  // This marker is issued only after the state above was verified durable. Failure here does not retract
  // that successful commit: later RAM flush is honest, while a missing marker makes restart conservative.
  try { pi.appendEntry("loop-state-committed", { commitId: data.commitId, entryId: entry.id, digest: expected }); }
  catch { /* Saved state remains true; recovery requires the original marker and otherwise stops this loop. */ }
}

/** Only current-branch records may supply authority. A newer unconfirmed change cannot revive an older queue. */
export function readLoopRecovery(entries: readonly LoopBranchEntry[], identity: LoopSessionIdentity): Array<{ job: LoopJobSnapshot; confirmed: boolean }> {
  let latest: LoopStateData | undefined;
  let latestEntry: LoopBranchEntry | undefined;
  const verified = new Map<string, string>();
  const candidates = new Map<string, { entry: LoopBranchEntry; data: LoopStateData }>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "loop-state") {
      const data = entry.data as Partial<LoopStateData> | undefined;
      if (!Array.isArray(data?.loops)) continue;
      latest = data as LoopStateData; latestEntry = entry;
      if (typeof data.commitId === "string") candidates.set(data.commitId, { entry, data: data as LoopStateData });
    } else if (entry.customType === "loop-state-committed") {
      const proof = entry.data as { commitId?: string; entryId?: string; digest?: string } | undefined;
      const candidate = typeof proof?.commitId === "string" ? candidates.get(proof.commitId) : undefined;
      if (!proof || !candidate || candidate.entry.id !== proof.entryId || loopDigest(candidate.entry) !== proof.digest) continue;
      if (candidate.data.sessionId !== identity.sessionId || candidate.data.cwd !== identity.cwd) continue;
      verified.clear();
      for (const job of candidate.data.loops) if (job.birthId) verified.set(job.id, loopDigest(job));
    }
  }
  if (!latest || !latestEntry) return [];
  return latest.loops.map((job) => ({ job, confirmed: !!job.birthId && latest!.sessionId === identity.sessionId && latest!.cwd === identity.cwd
    && verified.get(job.id) === loopDigest(job) }));
}

export function registerLoop(pi: ExtensionAPI): void {
  const shell = getShellConfig();
  let currentContext: ExtensionContext | undefined;
  const warnedExecutions = new Set<string>();
  let hasLoopState = false;

  const publishSnapshot = (jobs: LoopJobSnapshot[]): void => {
    pi.events.emit(LOOP_UPDATE_EVENT, { jobs });
  };

  const persistLoopState = (jobs: LoopJobSnapshot[]): void => {
    if (jobs.length === 0 && !hasLoopState) return;
    if (!currentContext) throw new Error("Loop session is not ready; command was not started.");
    commitLoopState(pi, currentContext, jobs);
    hasLoopState = true;
  };

  const scheduler = new LoopScheduler({
    commit: persistLoopState,
    onExecutionObservation(job) {
      pi.events.emit(LOOP_EXECUTION_EVENT, { job });
      if (job.execution?.state === "unknown" && !warnedExecutions.has(job.execution.id)) {
        warnedExecutions.add(job.execution.id);
        currentContext?.ui.notify(`Loop ${job.id}: current command result is unconfirmed; no further runs were started.`, "warning");
      }
    },
    onError(error) { currentContext?.ui.notify(error instanceof Error ? error.message : String(error), "warning"); },
    onUpdate(jobs) {
      publishSnapshot(jobs);
    },
    onTerminal(job, outcome) {
      // Terminal states must stay visible (ui-conventions-007): announce
      // failure/completion instead of leaving them discoverable only via list.
      const headline = outcome === "failed"
        ? `Loop ${job.id} failed at run ${job.runCount}/${job.maxRuns}`
        : `Loop ${job.id} completed (${job.runCount}/${job.maxRuns} runs)`;
      const summary = job.lastResult ? truncateText(job.lastResult, 160) : undefined;
      pi.sendMessage({
        customType: "loop-event",
        content: summary ? `${headline}: ${summary}` : headline,
        display: true,
        details: { loopId: job.id, outcome, runCount: job.runCount, maxRuns: job.maxRuns },
      });
    },
    async execute(job) {
      if (job.kind === "prompt") {
        pi.sendMessage(
          {
            customType: "loop-tick",
            content: `[loop ${job.id}] tick ${job.runCount + 1}/${job.maxRuns}\n${job.task}`,
            display: true,
            details: { loopId: job.id, kind: job.kind, run: job.runCount + 1, maxRuns: job.maxRuns },
          },
          { triggerTurn: true },
        );
        return { ok: true, summary: "prompt queued" };
      }
      const result = await pi.exec(shell.shell, [...shell.args, job.task], {
        cwd: job.cwd || process.cwd(),
        timeout: job.timeoutMs,
      });
      const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
      // Write run output to log file.
      if (job.logDir) {
        try {
          fs.mkdirSync(job.logDir, { recursive: true });
          fs.writeFileSync(
            path.join(job.logDir, `run-${job.runCount + 1}.log`),
            `${new Date().toISOString()} exit=${result.code}\n${output}\n`,
          );
        } catch { /* best-effort logging */ }
      }
      return {
        ok: result.code === 0 && !result.killed,
        summary: result.killed ? `Command was signalled; outcome unknown (exit ${result.code})` : output || `exit ${result.code}`,
        ...(result.killed ? { outcomeUnknown: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "loop",
    label: "Loop",
    description:
      "Create, list, or cancel session-scoped recurring tasks. Create requires kind, task, and intervalMs (milliseconds); cancel requires loopId. Prefer 300000 (5 minutes) for routine project supervision unless the user requests another cadence. A loop enqueues a prompt or runs a shell command after each fixed delay, never overlaps shell runs, and stops after maxRuns; prompt ticks do not wait for the agent turn to finish. Prompt loops are cancelled on session shutdown; shell loops with remaining runs are detached and keep running, and are reported/restored on the next session start.",
    promptSnippet: "Schedule bounded recurring prompt or shell tasks for the current session.",
    promptGuidelines: [
      "Use action=create only when the user explicitly asks for recurring or delayed work.",
      "Prefer prompt loops for recurring agent work and shell loops only for commands the user has authorized.",
      "Choose the interval from the user's requested cadence and expected task duration. For routine multi-minute project supervision use intervalMs=300000 (5 minutes); sub-minute or 1-minute checks need a concrete latency reason, not the scheduler's 1000ms minimum. Prompt ticks only enqueue work, so short intervals can accumulate while the agent is busy.",
      "For window completion use Monitor lifecycle subscriptions when available instead of a prompt polling loop; use a slow loop only as a bounded watchdog for stalls or deadlines. Keep each tick compact and inspect summaries/cursors first; unchanged state needs no repeated full transcript read, status ping, or user-facing broadcast.",
      "Set maxRuns from the bounded supervision horizon (for example 2 hours at 5 minutes is 24 runs). When replacing a loop to change cadence, cancel the old loop first and calculate runs from the remaining time; do not silently restart or extend the deadline.",
      "Loops default to 10 runs (maxRuns); use list to inspect and cancel to stop one early. Prompt loops are session-scoped; shell loops survive session shutdown.",
    ],
    parameters: LoopParams,
    async execute(_id, params: LoopParamsInput): Promise<FlowToolResult<{ jobs: LoopJobSnapshot[] }>> {
      try {
        if (params.action === "list") {
          const jobs = scheduler.list();
          return {
            content: [{ type: "text", text: jobs.length ? jobs.map((job) => formatJob(job)).join("\n") : "No loops." }],
            details: { jobs },
          };
        }
        if (params.action === "cancel") {
          if (!params.loopId) throw new Error("loopId is required for cancel.");
          const resolved = resolveLoopId(params.loopId, scheduler.list());
          if ("error" in resolved) throw new Error(resolved.error);
          const job = scheduler.cancel(resolved.id);
          if (!job) throw new Error(`Unknown loopId: ${params.loopId}`);
          return { content: [{ type: "text", text: cancelledNotice(job) }], details: { jobs: [job] } };
        }
        if (!params.kind || !params.task || params.intervalMs === undefined) {
          throw new Error("kind, task, and intervalMs are required for create.");
        }
        const job = scheduler.create({
          kind: params.kind,
          task: params.task,
          intervalMs: params.intervalMs,
          maxRuns: params.maxRuns,
          cwd: params.cwd ?? currentContext?.cwd,
          timeoutMs: params.timeoutMs,
        });
        return {
          content: [{ type: "text", text: `Created ${formatJob(job)}` }],
          details: { jobs: [job] },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true, details: { jobs: [] } };
      }
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      if (context?.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "list");
      const detail = action === "create"
        ? `${action} ${String(args.kind ?? "?")}${typeof args.intervalMs === "number" ? ` · every ${formatDuration(args.intervalMs)}` : ""}`
        : action === "cancel"
          ? `${action} ${String(args.loopId ?? "?")}`
          : action;
      return toolCallLine(theme, "loop", detail);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text("", 0, 0);
      const action = String(context.args.action ?? "list");
      const jobs = result.details?.jobs ?? [];
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = context.isError || (result as { isError?: boolean }).isError === true;
      const collapsedJobCount = jobs.length > 8 ? 7 : 8;
      const visibleJobs = options.expanded ? jobs : jobs.slice(0, collapsedJobCount);
      const now = Date.now();
      const groups = visibleJobs.map((job) => formatJobCardRows(job, now, options.expanded));
      if (visibleJobs.length < jobs.length) groups.push([`… ${jobs.length - visibleJobs.length} more loops · expand for details`]);
      if (groups.length === 0 && text) groups.push(text.split("\n"));
      const summary = isError
        ? (text.split("\n").find((line) => line.trim()) ?? "failed")
        : action === "list"
          ? `${jobs.length} loop${jobs.length === 1 ? "" : "s"}`
          : `${action === "create" ? "created" : "cancelled"} ${jobs[0]?.id ?? "loop"}`;
      return toolResultCard(theme, {
        name: "loop",
        ok: !isError && !jobs.some((job) => job.execution?.state === "unknown"),
        arg: action,
        summary,
        groups,
      });
    },
  });

  pi.registerCommand("loop", {
    description: "Recurring session task: /loop prompt|shell <interval> [--max=N] <task> | /loop list | /loop cancel [id] (bare cancel opens a picker)",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase();
      if (!action || action === "list") {
        const jobs = scheduler.list();
        ctx.ui.notify(jobs.length ? jobs.map((job) => formatJob(job)).join("\n") : "No loops.", "info");
        return;
      }
      if (action === "cancel") {
        const id = tokens[1];
        if (!id) {
          const active = scheduler.list().filter((j) => j.status === "scheduled" || j.status === "running");
          if (active.length === 0) {
            ctx.ui.notify("No active loops.", "info");
            return;
          }
          const labels = active.map((j) => formatJob(j));
          const picked = await ctx.ui.select("Cancel which loop?", labels);
          if (picked === undefined) return;
          const job = scheduler.cancel(active[labels.indexOf(picked)]?.id);
          if (!job) return;
          ctx.ui.notify(cancelledNotice(job), job.execution?.state === "unknown" ? "warning" : "info");
          return;
        }
        const resolved = resolveLoopId(id, scheduler.list());
        if ("error" in resolved) {
          ctx.ui.notify(resolved.error, "warning");
          return;
        }
        const job = scheduler.cancel(resolved.id);
        if (!job) {
          ctx.ui.notify(`Unknown loopId: ${id}`, "warning");
          return;
        }
        ctx.ui.notify(cancelledNotice(job), job.execution?.state === "unknown" ? "warning" : "info");
        return;
      }
      if (action !== "prompt" && action !== "shell") {
        ctx.ui.notify("Usage: /loop prompt|shell <interval> [--max=N] <task> | /loop list | /loop cancel <id>", "warning");
        return;
      }
      const intervalMs = parseLoopDuration(tokens[1] ?? "");
      let taskStart = 2;
      let maxRuns: number | undefined;
      const maxMatch = /^--max=(\d+)$/.exec(tokens[taskStart] ?? "");
      if (maxMatch) {
        maxRuns = Number(maxMatch[1]);
        taskStart++;
      }
      const task = tokens.slice(taskStart).join(" ");
      try {
        if (intervalMs === undefined) throw new Error("Interval must use ms, s, m, or h, for example 30s or 5m.");
        const job = scheduler.create({ kind: action, task, intervalMs, maxRuns, cwd: ctx.cwd });
        ctx.ui.notify(`Created ${formatJob(job)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  // Cockpit can subscribe after this tool is registered, then request the
  // authoritative in-memory snapshot without importing Flow internals.
  pi.events.on(LOOP_QUERY_EVENT, () => publishSnapshot(scheduler.list()));

  pi.registerMessageRenderer("loop-tick", (msg, _opts, theme) => {
    const details = msg.details as { loopId?: string; run?: number; maxRuns?: number } | undefined;
    const label = details?.loopId ?? "loop";
    const progress = details?.run !== undefined && details?.maxRuns !== undefined
      ? ` ${details.run}/${details.maxRuns}`
      : "";
    const content = typeof msg.content === "string" ? msg.content.split("\n").slice(1).join(" ") : "";
    const summary = content.length > 80 ? `${content.slice(0, 77)}…` : content;
    return new Text(`${theme.fg("muted", "⟳")} ${theme.fg("dim", label)}${theme.fg("dim", progress)} ${summary}`, 0, 0);
  });

  pi.registerMessageRenderer("loop-event", (msg, options, theme) => {
    const details = msg.details as { loopId?: string; outcome?: string; runCount?: number; maxRuns?: number } | undefined;
    const failed = details?.outcome === "failed";
    const outcome = details?.outcome === "failed" || details?.outcome === "completed"
      ? details.outcome
      : sanitizeCardText(details?.outcome ?? (failed ? "failed" : "completed"), 40);
    const progress = details?.runCount !== undefined && details?.maxRuns !== undefined
      ? sanitizeCardText(`${details.runCount}/${details.maxRuns}`, 40)
      : "";
    const content = typeof msg.content === "string" ? sanitizeCardText(msg.content) : "";
    const summary = [
      sanitizeCardText(details?.loopId ?? "loop", 80),
      outcome,
      progress,
    ].filter(Boolean).join(" · ");
    return toolResultCard(theme, {
      name: "loop-event",
      ok: !failed,
      summary,
      groups: content ? [[content]] : [],
      maxBodyRows: options.expanded ? undefined : 8,
    });
  });

  // Restore persisted loops on session resume/reload; discover independent
  // shell loops on fresh startup.
  pi.on("session_start", (event, ctx) => {
    currentContext = ctx;
    const branch = ctx.sessionManager.getBranch();
    const identity = loopSessionIdentity(ctx);
    const recovered = readLoopRecovery(branch, identity);
    hasLoopState = recovered.length > 0 || branch.some(entry => entry.type === "custom" && entry.customType === "loop-state"
      && (entry.data as Partial<LoopStateData> | undefined)?.sessionId === identity.sessionId
      && (entry.data as Partial<LoopStateData> | undefined)?.cwd === identity.cwd);
    if (event.reason === "reload") {
      // The previous shutdown already reconciled this owner's original calls.
      scheduler.shutdown();
    }
    scheduler.reset();
    for (const def of recovered) {
      if (def.job.detached || (def.job.status === "cancelled" && def.job.execution)) scheduler.restore(def.job, def.confirmed);
    }
    if (event.reason === "startup") {
      // Check for independent shell loops still running from a previous session.
      const entries = readRegistry().filter((e) => isPidAlive(e.pid));
      if (entries.length > 0) {
        const lines = entries.map((e) => `- ${e.id} (pid ${e.pid}): ${e.task} [${e.runCount}/${e.maxRuns}]`);
        ctx.ui.notify(`${entries.length} independent loop(s) still running:\n${lines.join("\n")}`, "info");
      }
      // Prune dead entries.
      const all = readRegistry();
      const alive = all.filter((e) => isPidAlive(e.pid));
      if (alive.length !== all.length) writeRegistry(alive);
      return;
    }
    if (event.reason !== "resume" && event.reason !== "reload") return;
    if (!recovered.length) return;
    let restored = 0;
    for (const { job: def, confirmed } of recovered) {
      if (!def.detached && def.runCount < def.maxRuns && def.status !== "cancelled" && def.status !== "failed") {
        const job = scheduler.restore(def, confirmed);
        if (job.status === "scheduled") restored++;
      }
    }
    if (restored > 0) {
      ctx.ui.notify(`Restored ${restored} loop(s) from previous session.`, "info");
    }
  });

  // Re-announce active loops after compaction so the agent retains awareness.
  pi.on("session_compact", () => {
    const active = scheduler.list().filter((j) => j.status === "scheduled" || j.status === "running");
    if (active.length === 0) return;
    const lines = active.map((j) => `- ${formatJob(j)}`);
    pi.sendMessage(
      {
        customType: "loop-active",
        content: `${active.length} loop(s) still active after compaction:\n${lines.join("\n")}`,
        display: true,
        details: { loops: active.map((j) => j.id) },
      },
      { deliverAs: "nextTurn" },
    );
  });

  let quitTransfer: Promise<void> | undefined;
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") {
      if (!quitTransfer) quitTransfer = (async () => {
        const pending = scheduler.prepareQuitHandoff();
        try {
          persistLoopState(scheduler.list());
          const handoff = await pending;
          persistLoopState(scheduler.list());
          for (const job of handoff.jobs) {
            scheduler.markDetached(job.id, "transferring");
            spawnDetachedScheduler(shell, job);
            scheduler.markDetached(job.id, "issued");
          }
          if (handoff.unknown.length > 0) {
            throw new Error(`Loop shutdown cannot confirm prior execution; remaining work was not handed off: ${handoff.unknown.map((job) => job.id).join(", ")}`);
          }
        } finally {
          scheduler.shutdown();
        }
      })();
      return quitTransfer;
    }
    if (event.reason === "reload") {
      return scheduler.prepareReloadHandoff();
    }
    // Preserve the final resource snapshot before ordinary shutdown clears its owner map.
    let failed = false; let primary: unknown;
    try { scheduler.pause(); } catch (error) { failed = true; primary = error; }
    try { persistLoopState(scheduler.list()); } catch (error) { if (!failed) { failed = true; primary = error; } }
    try { scheduler.shutdown(); } catch (error) { if (!failed) { failed = true; primary = error; } }
    currentContext = undefined;
    if (failed) throw primary;
  });
}

/**
 * Generate and spawn a self-contained Node.js script that continues a shell
 * loop independently of the pi session. The script uses only Node builtins.
 */
function spawnDetachedScheduler(
  shell: { shell: string; args: string[] },
  job: LoopJobSnapshot,
): void {
  const logDir = loopLogDir(job.id);
  fs.mkdirSync(logDir, { recursive: true });
  const scriptPath = path.join(logDir, "scheduler.mjs");

  const script = `#!/usr/bin/env node
// Auto-generated detached loop scheduler for ${job.id}
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const CONFIG = ${JSON.stringify({
    id: job.id,
    task: job.task,
    intervalMs: job.intervalMs,
    maxRuns: job.maxRuns,
    runCount: job.runCount,
    cwd: job.cwd || process.cwd(),
    timeoutMs: job.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
    shell: shell.shell,
    shellArgs: shell.args,
    logDir,
    registryPath: REGISTRY_PATH,
  }, null, 2)};

const registryEntry = {
  id: CONFIG.id, task: CONFIG.task, intervalMs: CONFIG.intervalMs,
  maxRuns: CONFIG.maxRuns, runCount: CONFIG.runCount,
  cwd: CONFIG.cwd, pid: process.pid, startedAt: Date.now(),
};

function updateRegistry(entry, remove) {
  let entries = [];
  try { entries = JSON.parse(readFileSync(CONFIG.registryPath, "utf8")); } catch {}
  entries = entries.filter(e => e.id !== entry.id);
  if (!remove) entries.push(entry);
  const tmp = CONFIG.registryPath + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, CONFIG.registryPath);
}

updateRegistry(registryEntry, false);

let run = CONFIG.runCount;
function tick() {
  if (run >= CONFIG.maxRuns) {
    updateRegistry(registryEntry, true);
    process.exit(0);
  }
  run++;
  registryEntry.runCount = run;
  let output = "";
  let code = 0;
  let unknown = false;
  try {
    output = execFileSync(CONFIG.shell, [...CONFIG.shellArgs, CONFIG.task], {
      cwd: CONFIG.cwd, timeout: CONFIG.timeoutMs, encoding: "utf8", windowsHide: true,
    });
  } catch (e) {
    code = e.status ?? 1;
    unknown = e.status === null || e.status === undefined;
    output = (unknown ? "Prior execution outcome unknown; no remaining loop runs will be dispatched.\\n" : "")
      + (e.stdout || "") + (e.stderr || "");
  }
  writeFileSync(
    join(CONFIG.logDir, "run-" + run + ".log"),
    new Date().toISOString() + " exit=" + code + "\\n" + output + "\\n",
  );
  const stopped = code !== 0 || unknown || run >= CONFIG.maxRuns;
  updateRegistry(registryEntry, stopped);
  if (code !== 0 || unknown) process.exitCode = 1;
  if (!stopped) setTimeout(tick, CONFIG.intervalMs);
}

setTimeout(tick, CONFIG.intervalMs);
`;

  fs.writeFileSync(scriptPath, script);

  const child = spawn("node", [scriptPath], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
