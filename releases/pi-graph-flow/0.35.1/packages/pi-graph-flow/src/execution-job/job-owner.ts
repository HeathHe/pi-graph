import type {
  observeTargets,
  ObservationProvider,
  ObservationSnapshot,
  ObservationWaitOptions,
} from "pi-maestro-teammate/v1/observation";

const MAX_TAIL_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 16;
const MAX_RETAINED_COMPLETED_JOBS = 64;
const MAX_SNAPSHOT_TAIL_LINES = 200;
const SNAPSHOT_THROTTLE_MS = 100;
const OUTPUT_DRAIN_GRACE_MS = 100;
const TERMINATION_GRACE_MS = 1_000;
const TERMINATION_POLL_MS = 25;

export type BashBgJobStatus = "running" | "stopping" | "completed" | "failed" | "killed";

export interface BashBgJobSnapshot {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  status: BashBgJobStatus;
  /** False only while action=run still owns the foreground tool call. */
  background: boolean;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  outputTail: string;
  outputBytes: number;
  logPath: string;
  /** Present after a stop request; false means only the leader exit is known. */
  treeCleanupConfirmed?: boolean;
}

export interface BashBgSnapshotPayload {
  jobs: BashBgJobSnapshot[];
}

export interface BashBgDetails {
  action: string;
  jobId?: string;
  pid?: number;
  running?: boolean;
  exitCode?: number | null;
  command?: string;
  logPath?: string;
  viewCommand?: string;
  treeCleanupConfirmed?: boolean;
}

export interface BashBgCompletionDetails {
  jobId: string;
  exitCode: number | null;
  status?: BashBgJobStatus;
  command?: string;
  outputTail?: string;
  logPath?: string;
  viewCommand?: string;
}

interface Job {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  child: BashBgJobProcess;
  outFile: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  done: boolean;
  stopRequested: boolean;
  tail: string;
  tailTruncated: boolean;
  outputBytes: number;
  logBytes: number;
  logLimitBytes: number;
  logTruncated: boolean;
  background: boolean;
  completionNotified: boolean;
  outputFinalized: boolean;
  terminationInProgress: boolean;
  treeCleanupConfirmed: boolean;
  terminationFailure?: string;
  outputFailure?: string;
  termination?: Promise<void>;
  terminal: Promise<void>;
  resolveTerminal: () => void;
  cachedSnapshot?: BashBgJobSnapshot;
  releaseProcess?: () => void;
  finishTermination?: (error?: Error) => void;
  outputDrainTimer?: ReturnType<typeof setTimeout>;
}

export interface RegisterBashBgOptions {
  maxActiveJobs?: number;
  maxRetainedCompletedJobs?: number;
  maxLogBytes?: number;
}

export interface BashBgJobRequest {
  action: "run" | "start" | "status" | "wait" | "kill" | "list";
  command?: string;
  jobId?: string;
  cwd?: string;
  timeout?: number;
  tail?: number;
}

export interface BashBgJobResult {
  content: { type: "text"; text: string }[];
  details: BashBgDetails;
  isError?: boolean;
}

export interface BashBgProcessHooks {
  onData(data: Buffer): void;
  onStdoutError(error: Error): void;
  onStderrError(error: Error): void;
  onExit(code: number | null): void;
  onClose(code: number | null): void;
  onError(error: Error): void;
}

export interface BashBgJobProcess {
  readonly pid: number;
  observe(hooks: BashBgProcessHooks): void;
  release(hooks: BashBgProcessHooks): void;
  signalTree(signal: NodeJS.Signals): void;
}

export interface BashBgJobLog {
  write(bytes: Buffer): void;
  end(): void;
  destroy(): void;
}

export interface BashBgShellConfig {
  shell: string;
  args: readonly string[];
}

/** The host supplies real OS, log and SDK effects; none owns job state. */
export interface BashBgJobEffects {
  platform(): NodeJS.Platform;
  cwd(): string;
  makeRuntimeDirectory(): string;
  removeRuntimeDirectory(root: string): void;
  logPath(root: string, id: string): string;
  openLog(file: string, onError: (error: Error) => void): BashBgJobLog;
  readLog(file: string): string;
  removeLog(file: string): void;
  getShellConfig(): BashBgShellConfig;
  spawnJob(shell: BashBgShellConfig, command: string, cwd: string): BashBgJobProcess;
  processGroupRunning(pid: number): boolean;
  taskkill(pid: number): WindowsTaskkillResult;
  registerObservation(provider: ObservationProvider): () => void;
  onSnapshotQuery(publish: () => void): (() => void) | undefined;
  observeTargets: typeof observeTargets;
  publishSnapshot(payload: BashBgSnapshotPayload): void;
  sendCompletion(content: string, details: BashBgCompletionDetails): void;
  announceRunning(content: string, ids: string[]): void;
  reportLogError(error: Error): void;
}

type RegisterForegroundDetach = (detach: () => void) => (() => void) | undefined;

/** @internal Exported for process-reclamation regression tests. */
export interface WindowsTaskkillResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
}

export interface WindowsTaskkillOutcome {
  failure?: string;
  treeCleanupConfirmed: boolean;
}

/** @internal Exported for process-reclamation regression tests. */
export function classifyWindowsTaskkill(
  result: WindowsTaskkillResult,
  targetWasRunningBeforeCleanup = true,
): WindowsTaskkillOutcome {
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") return { failure: "taskkill timed out", treeCleanupConfirmed: false };
  if (error) return { failure: `taskkill failed to start: ${error.message}`, treeCleanupConfirmed: false };
  if (result.status === 0) return { treeCleanupConfirmed: true };
  // Status 128 can be an idempotent leader-exit race, but it does not confirm
  // that every descendant was reclaimed.
  if (result.status === 128 && targetWasRunningBeforeCleanup) {
    return { treeCleanupConfirmed: false };
  }
  const outcome = result.status === null
    ? result.signal ? `signal ${result.signal}` : "unknown status"
    : `exit ${result.status}`;
  return { failure: `taskkill failed (${outcome})`, treeCleanupConfirmed: false };
}

/** @internal Backward-compatible failure projection for existing consumers. */
export function windowsTaskkillFailure(
  result: WindowsTaskkillResult,
  targetWasRunningBeforeCleanup = true,
): string | undefined {
  return classifyWindowsTaskkill(result, targetWasRunningBeforeCleanup).failure;
}

/** Own one registered runtime's jobs, observations, timers and terminal transitions. */
export function createBashBgJobOwner(effects: BashBgJobEffects, options: RegisterBashBgOptions = {}) {
  interface TailOutput {
    text: string;
    truncated: boolean;
  }

  function tailOutput(job: Job, lines: number): TailOutput {
    let content = job.tail;
    if (!content) {
      try {
        content = effects.readLog(job.outFile);
      } catch {
        return { text: "", truncated: false };
      }
    }
    content = content.replace(/\r?\n$/, "");
    if (!content) return { text: "", truncated: false };
    const allLines = content.split("\n");
    return {
      text: allLines.slice(-lines).join("\n"),
      truncated: job.tailTruncated || job.logTruncated || allLines.length > lines,
    };
  }

  function jobStatus(job: Job): BashBgJobStatus {
    if (job.terminationFailure) return "failed";
    if (job.terminationInProgress) return "stopping";
    if (job.outputFailure) return "failed";
    if (!job.done) return job.stopRequested ? "stopping" : "running";
    if (job.stopRequested) return "killed";
    return job.exitCode === 0 ? "completed" : "failed";
  }

  function jobSnapshot(job: Job): BashBgJobSnapshot {
    if (job.outputFinalized && job.cachedSnapshot) return job.cachedSnapshot;
    const snapshot: BashBgJobSnapshot = {
      id: job.id,
      command: job.command,
      cwd: job.cwd,
      pid: job.pid,
      status: jobStatus(job),
      background: job.background,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      exitCode: job.exitCode,
      outputTail: tailOutput(job, MAX_SNAPSHOT_TAIL_LINES).text,
      outputBytes: job.outputBytes,
      logPath: job.outFile,
      ...(job.stopRequested ? { treeCleanupConfirmed: job.treeCleanupConfirmed } : {}),
    };
    if (job.outputFinalized) job.cachedSnapshot = snapshot;
    return snapshot;
  }

  function shellQuote(value: string): string {
    if (effects.platform() === "win32") return `'${value.replace(/'/g, "''")}'`;
    return `'${value.replace(/'/g, "'\"'\"'")}'`;
  }

  function viewLogCommand(job: Job): string {
    const file = shellQuote(job.outFile);
    if (effects.platform() === "win32") {
      return `Get-Content -LiteralPath ${file} -Tail 200${job.done ? "" : " -Wait"}`;
    }
    return `tail -n 200${job.done ? "" : " -f"} -- ${file}`;
  }

  function logAccess(job: Job): string {
    return [
      `log: ${job.outFile}`,
      ...(job.logTruncated ? [`log retention: truncated at ${job.logLimitBytes} bytes`] : []),
      `view: ${viewLogCommand(job)}`,
    ].join("\n");
  }

  function appendLogAccess(text: string, job: Job, truncated: boolean): string {
    return truncated ? `${text}\n${logAccess(job)}` : text;
  }

  function jobDetails(job: Job, action: string, truncated = false): BashBgDetails {
    return {
      action,
      jobId: job.id,
      pid: job.pid,
      running: jobIsActive(job),
      exitCode: job.exitCode,
      command: job.command,
      ...(job.stopRequested ? { treeCleanupConfirmed: job.treeCleanupConfirmed } : {}),
      ...(truncated ? { logPath: job.outFile, viewCommand: viewLogCommand(job) } : {}),
    };
  }

  function jobOwnsLiveProcessGroup(job: Job): boolean {
    return effects.platform() !== "win32" && job.done && effects.processGroupRunning(job.pid);
  }

  function jobIsActive(job: Job): boolean {
    return !job.done || job.terminationInProgress || jobOwnsLiveProcessGroup(job);
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const maxActiveJobs = options.maxActiveJobs ?? MAX_ACTIVE_JOBS;
  const maxRetainedCompletedJobs = options.maxRetainedCompletedJobs ?? MAX_RETAINED_COMPLETED_JOBS;
  const maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
  let baseDir = "";
  const jobs = new Map<string, Job>();
  const observationWaiters = new Map<string, Set<() => void>>();
  const observationCapabilities = { inspect: true, wait: true, cancel: true } as const;

  const observationSnapshot = (
    id: string,
    detail: "summary" | "tail" | "full",
    lines: number,
    waitStatus?: "timeout" | "aborted",
  ): ObservationSnapshot => {
    const job = jobs.get(id);
    if (!job) {
      return {
        target: { kind: "bash_bg", id },
        found: false,
        nativeStatus: "not-found",
        phase: "unknown",
        outcome: "failure",
        waitStatus: "not-found",
        summary: `Unknown jobId: ${id}`,
        updatedAt: Date.now(),
        capabilities: observationCapabilities,
        error: `Unknown jobId: ${id}`,
      };
    }
    const status = jobStatus(job);
    const terminal = !jobIsActive(job);
    const output = tailOutput(job, lines).text;
    return {
      target: { kind: "bash_bg", id },
      found: true,
      nativeStatus: status,
      phase: terminal ? "settled" : "active",
      ...(terminal ? { outcome: status === "completed" ? "success" as const : "failure" as const } : {}),
      ...(terminal ? { waitStatus: status === "completed" ? "completed" as const : "failed" as const } : waitStatus ? { waitStatus } : {}),
      summary: `${job.command} (${status}${job.exitCode === null ? "" : `, exit ${job.exitCode}`})`,
      ...(detail === "summary" ? {} : { detail: [
        `command: ${job.command}`,
        `cwd: ${job.cwd}`,
        ...(output ? output.split("\n") : ["(empty)"]),
      ] }),
      updatedAt: job.updatedAt,
      capabilities: observationCapabilities,
      ...(job.terminationFailure || job.outputFailure ? { error: job.terminationFailure ?? job.outputFailure } : {}),
    };
  };

  const waitForObservation = (id: string, options: ObservationWaitOptions): Promise<ObservationSnapshot> => {
    const current = observationSnapshot(id, options.detail, options.lines);
    if (!current.found || current.phase === "settled") return Promise.resolve(current);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ownershipPoll: ReturnType<typeof setInterval> | undefined;
      const waiters = observationWaiters.get(id) ?? new Set<() => void>();
      observationWaiters.set(id, waiters);
      const finish = (waitStatus?: "timeout" | "aborted"): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (ownershipPoll) clearInterval(ownershipPoll);
        options.signal.removeEventListener("abort", onAbort);
        waiters.delete(onDone);
        if (waiters.size === 0) observationWaiters.delete(id);
        resolve(observationSnapshot(id, options.detail, options.lines, waitStatus));
      };
      const onDone = () => {
        const snapshot = observationSnapshot(id, options.detail, options.lines);
        if (!snapshot.found || snapshot.phase === "settled") finish();
      };
      const onAbort = () => finish("aborted");
      waiters.add(onDone);
      options.signal.addEventListener("abort", onAbort, { once: true });
      ownershipPoll = setInterval(onDone, TERMINATION_POLL_MS);
      ownershipPoll.unref?.();
      timer = setTimeout(() => finish("timeout"), Math.max(1, options.deadline - Date.now()));
    });
  };

  const bashObservationProvider: ObservationProvider = {
    kind: "bash_bg",
    capabilities: observationCapabilities,
    snapshot: (id, options) => observationSnapshot(id, options.detail, options.lines),
    wait: waitForObservation,
  };
  let counter = 0;
  let runtimeGeneration = 0;
  let disposed = true;
  let disposeObservationProvider: (() => void) | undefined;
  let disposeQueryListener: (() => void) | undefined;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  const pruneCompletedJobs = (): void => {
    const completed = [...jobs.values()]
      .filter((job) => job.done && !jobIsActive(job))
      .sort((a, b) => (a.finishedAt ?? a.updatedAt) - (b.finishedAt ?? b.updatedAt));
    while (completed.length > maxRetainedCompletedJobs) {
      const evicted = completed.shift();
      if (!evicted || !evicted.outputFinalized) continue;
      jobs.delete(evicted.id);
      try { effects.removeLog(evicted.outFile); } catch { /* best effort for externally held log handles */ }
    }
  };

  const publishSnapshot = (): void => {
    if (disposed) return;
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    const payload: BashBgSnapshotPayload = {
      jobs: [...jobs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(jobSnapshot),
    };
    effects.publishSnapshot(payload);
  };
  const publishSnapshotSoon = (): void => {
    if (disposed || snapshotTimer) return;
    snapshotTimer = setTimeout(publishSnapshot, SNAPSHOT_THROTTLE_MS);
    snapshotTimer.unref?.();
  };

  const initializeRuntime = (): void => {
    if (!disposed) return;
    runtimeGeneration += 1;
    baseDir = effects.makeRuntimeDirectory();
    disposed = false;
    disposeObservationProvider = effects.registerObservation(bashObservationProvider);
    disposeQueryListener = effects.onSnapshotQuery(publishSnapshot);
  };

  const notifyComplete = (job: Job): void => {
    if (disposed || !job.background || job.completionNotified) return;
    job.completionNotified = true;
    const tail = tailOutput(job, 20);
    const status = jobStatus(job);
    const body = [
      `Background bash job ${job.id} ${status} (exit ${job.exitCode}).`,
      `command: ${job.command}`,
      tail.text ? `output (tail):\n${tail.text}` : "output: (empty)",
      ...(tail.truncated ? [logAccess(job)] : []),
    ].join("\n");
    effects.sendCompletion(body, {
      jobId: job.id,
      exitCode: job.exitCode,
      status,
      command: job.command,
      outputTail: tail.text,
      ...(tail.truncated ? { logPath: job.outFile, viewCommand: viewLogCommand(job) } : {}),
    });
  };

  const waitForTerminationBoundary = async (job: Job, includeProcessGroup: boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (job.done && (!includeProcessGroup || !effects.processGroupRunning(job.pid))) return true;
      await delay(Math.min(TERMINATION_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    return job.done && (!includeProcessGroup || !effects.processGroupRunning(job.pid));
  };

  const terminateJob = (job: Job): Promise<void> => {
    if (job.termination) return job.termination;
    const includeProcessGroup = effects.platform() !== "win32";
    const boundaryReached = job.done && (includeProcessGroup
      ? !effects.processGroupRunning(job.pid)
      : job.treeCleanupConfirmed);
    if (boundaryReached) {
      if (job.stopRequested) job.finishTermination?.();
      return Promise.resolve();
    }

    job.stopRequested = true;
    job.terminationInProgress = true;
    job.terminationFailure = undefined;
    job.cachedSnapshot = undefined;
    job.updatedAt = Date.now();
    publishSnapshot();

    const termination = (async () => {
      let terminated = false;
      let taskkillFailure: string | undefined;
      let treeCleanupConfirmed = effects.platform() !== "win32";
      if (effects.platform() === "win32") {
        if (job.pid > 0) {
          const targetWasRunningBeforeCleanup = !job.done;
          const result = effects.taskkill(job.pid);
          const taskkillOutcome = classifyWindowsTaskkill(result, targetWasRunningBeforeCleanup);
          taskkillFailure = taskkillOutcome.failure;
          treeCleanupConfirmed = taskkillOutcome.treeCleanupConfirmed;
        }
        terminated = await waitForTerminationBoundary(job, false, TERMINATION_GRACE_MS);
      } else {
        job.child.signalTree("SIGTERM");
        terminated = await waitForTerminationBoundary(job, true, TERMINATION_GRACE_MS);
        if (!terminated) {
          job.child.signalTree("SIGKILL");
          terminated = await waitForTerminationBoundary(job, true, TERMINATION_GRACE_MS);
        }
      }

      if (taskkillFailure) {
        throw new Error(`Failed to terminate bash job ${job.id}: ${taskkillFailure}; Windows process-tree cleanup is unconfirmed.`);
      }
      if (!terminated) {
        const boundary = includeProcessGroup ? `POSIX process group ${job.pid}` : `process ${job.pid}`;
        throw new Error(`Failed to terminate bash job ${job.id}: ${boundary} is still alive.`);
      }
      job.treeCleanupConfirmed = treeCleanupConfirmed;
      job.finishTermination?.();
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      job.finishTermination?.(failure);
      throw failure;
    });
    job.termination = termination;
    void termination.then(
      () => { if (job.termination === termination) job.termination = undefined; },
      () => { if (job.termination === termination) job.termination = undefined; },
    );
    return termination;
  };

  const startJob = (command: string, workdir: string, background: boolean): Job => {
    if (disposed) throw new Error("bash_bg is unavailable outside an active session runtime.");
    const generation = runtimeGeneration;
    const activeJobs = [...jobs.values()].filter(jobIsActive).length;
    if (activeJobs >= maxActiveJobs) {
      throw new Error(`Too many active background jobs (${activeJobs}/${maxActiveJobs}). Wait for or stop an existing job.`);
    }
    const id = `bg-${(++counter).toString(36)}-${Date.now().toString(36)}`;
    const outFile = effects.logPath(baseDir, id);
    let logFailed = false;
    let reportLogError = (error: Error): void => effects.reportLogError(error);
    const log = effects.openLog(outFile, (error) => {
      logFailed = true;
      reportLogError(error);
    });
    const shellConfig = effects.getShellConfig();
    let child: BashBgJobProcess;
    try {
      child = effects.spawnJob(shellConfig, command, workdir);
    } catch (error) {
      log.destroy();
      effects.removeLog(outFile);
      throw error;
    }
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const job: Job = {
      id,
      command,
      cwd: workdir,
      pid: child.pid,
      child,
      outFile,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      exitCode: null,
      done: false,
      stopRequested: false,
      tail: "",
      tailTruncated: false,
      outputBytes: 0,
      logBytes: 0,
      logLimitBytes: maxLogBytes,
      logTruncated: false,
      background,
      completionNotified: false,
      outputFinalized: false,
      terminationInProgress: false,
      treeCleanupConfirmed: false,
      terminal,
      resolveTerminal,
    };
    jobs.set(id, job);
    publishSnapshot();
    const appendTail = (d: Buffer): void => {
      job.tail += d.toString("utf8");
      if (job.tail.length > MAX_TAIL_BYTES) {
        job.tail = job.tail.slice(-MAX_TAIL_BYTES);
        job.tailTruncated = true;
      }
      job.outputBytes += d.byteLength;
      job.updatedAt = Date.now();
      publishSnapshotSoon();
    };
    const onStreamError = (source: string, error: Error): void => {
      if (disposed || generation !== runtimeGeneration) return;
      const firstFailure = !job.outputFailure;
      job.outputFailure ??= `${source} stream failed: ${error.message}`;
      job.cachedSnapshot = undefined;
      // Never send diagnostics through the possibly broken log writer.
      appendTail(Buffer.from(`\n${source} stream failed: ${error.message}\n`));
      publishSnapshot();
      if (firstFailure && jobIsActive(job)) {
        // terminateJob owns the cleanup result; a rejected stop remains visible
        // and retryable, not an unhandled rejection or a fabricated leader exit.
        void terminateJob(job).catch(() => {});
      }
    };
    reportLogError = (error) => onStreamError("log", error);
    const append = (d: Buffer): void => {
      if (disposed || generation !== runtimeGeneration) return;
      appendTail(d);
      const remainingLogBytes = Math.max(0, maxLogBytes - job.logBytes);
      if (!logFailed && remainingLogBytes > 0) {
        const retained = d.byteLength <= remainingLogBytes ? d : d.subarray(0, remainingLogBytes);
        try {
          log.write(retained);
          job.logBytes += retained.byteLength;
        } catch (error) {
          logFailed = true;
          reportLogError(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (d.byteLength > remainingLogBytes) job.logTruncated = true;
    };
    let exitCode: number | null = null;
    let processReleased = false;
    let processHooks: BashBgProcessHooks;
    const releaseProcess = (): void => {
      if (processReleased) return;
      processReleased = true;
      child.release(processHooks);
      log.end();
      job.releaseProcess = undefined;
    };
    job.releaseProcess = releaseProcess;
    const markDone = (code: number | null): void => {
      if (job.done) return;
      job.done = true;
      job.exitCode = code;
      job.updatedAt = Date.now();
      job.finishedAt = job.updatedAt;
      if (!disposed && generation === runtimeGeneration) pruneCompletedJobs();
      job.resolveTerminal();
      if (disposed || generation !== runtimeGeneration) return;
      publishSnapshot();
      if (!job.terminationInProgress) {
        for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
      }
    };
    const finalizeOutput = (): void => {
      if (job.outputFinalized) return;
      job.outputFinalized = true;
      if (job.outputDrainTimer) {
        clearTimeout(job.outputDrainTimer);
        job.outputDrainTimer = undefined;
      }
      releaseProcess();
      if (disposed || generation !== runtimeGeneration) return;
      notifyComplete(job);
      pruneCompletedJobs();
      publishSnapshot();
    };
    job.finishTermination = (error) => {
      job.cachedSnapshot = undefined;
      job.updatedAt = Date.now();
      if (error) {
        job.terminationInProgress = false;
        job.terminationFailure = error.message;
        job.finishedAt ??= job.updatedAt;
        publishSnapshot();
        for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
        return;
      }
      job.terminationInProgress = false;
      job.terminationFailure = undefined;
      const outputWasFinalized = job.outputFinalized;
      markDone(job.exitCode);
      finalizeOutput();
      if (outputWasFinalized && !disposed && generation === runtimeGeneration) publishSnapshot();
      for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
    };
    const onExit = (code: number | null): void => {
      exitCode = code;
      // Process exit is the lifecycle boundary. Waiting indefinitely for close
      // misclassifies a finished shell as running when a descendant inherited
      // its stdout/stderr pipes.
      markDone(code);
      if (job.terminationInProgress) return;
      if (disposed || generation !== runtimeGeneration) {
        finalizeOutput();
        return;
      }
      job.outputDrainTimer = setTimeout(finalizeOutput, OUTPUT_DRAIN_GRACE_MS);
      job.outputDrainTimer.unref?.();
    };
    const onClose = (code: number | null): void => {
      markDone(code ?? exitCode);
      if (!job.terminationInProgress) finalizeOutput();
    };
    const onError = (error: Error): void => {
      if (processReleased) return;
      append(Buffer.from(`\n${error.message}\n`));
      markDone(exitCode ?? -1);
      if (!job.terminationInProgress) finalizeOutput();
    };
    processHooks = {
      onData: append,
      onStdoutError: (error) => onStreamError("stdout", error),
      onStderrError: (error) => onStreamError("stderr", error),
      onExit,
      onClose,
      onError,
    };
    child.observe(processHooks);
    return job;
  };

  const waitForRunBoundary = (
    job: Job,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    manualDetach: Promise<void>,
  ): Promise<"completed" | "timeout" | "manual" | "aborted"> => {
    if (signal?.aborted) return Promise.resolve("aborted");
    if (job.done) return Promise.resolve("completed");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: "completed" | "timeout" | "manual" | "aborted"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      void job.terminal.then(() => finish("completed"));
      void manualDetach.then(() => finish("manual"));
    });
  };

  const execute = async (
    params: BashBgJobRequest,
    signal: AbortSignal | undefined,
    registerDetach: RegisterForegroundDetach,
  ): Promise<BashBgJobResult> => {
    const tailCount = params.tail ?? 20;

    if (params.action === "start") {
      if (!params.command) throw new Error("bash_bg start requires 'command'.");
      const job = startJob(params.command, params.cwd || effects.cwd(), true);
      return {
        content: [{
          type: "text",
          text:
            `Started background job ${job.id} (pid ${job.pid}).\ncommand: ${job.command}\n` +
            `You will receive a bash-bg-complete notification when it finishes. ` +
            `Use bash_bg action=status jobId=${job.id} to peek, or action=wait to block.`,
        }],
        details: jobDetails(job, "start"),
      };
    }

    if (params.action === "run") {
      if (!params.command) throw new Error("bash_bg run requires 'command'.");
      let detachResolve: (() => void) | undefined;
      const detachPromise = new Promise<void>((resolve) => { detachResolve = resolve; });
      const removeDetach = registerDetach(() => detachResolve?.());
      try {
        const job = startJob(params.command, params.cwd || effects.cwd(), false);
        const windowMs = (params.timeout ?? 30) * 1000;
        const outcome = await waitForRunBoundary(job, windowMs, signal, detachPromise);
        if (outcome === "aborted") {
          job.background = false;
          await terminateJob(job);
          throw new Error("aborted");
        }
        if (outcome === "completed" || job.done) {
          const out = tailOutput(job, params.tail ?? 200);
          return {
            content: [{
              type: "text",
              text: appendLogAccess(`${out.text || "(no output)"}\n(exit ${job.exitCode})`, job, out.truncated),
            }],
            ...(job.outputFailure ? { isError: true } : {}),
            details: jobDetails(job, "run", out.truncated),
          };
        }
        job.background = true;
        job.updatedAt = Date.now();
        job.cachedSnapshot = undefined;
        publishSnapshot();
        const transfer = outcome === "manual"
          ? `Detached to background as job ${job.id} (pid ${job.pid}).`
          : `Still running after ${Math.round(windowMs / 1000)}s — moved to background as job ${job.id} (pid ${job.pid}).`;
        return {
          content: [{
            type: "text",
            text:
              `${transfer}\ncommand: ${job.command}\n` +
              `You will receive a bash-bg-complete notification when it finishes. ` +
              `Use bash_bg action=status jobId=${job.id} to peek, or action=wait to block.`,
          }],
          details: jobDetails(job, "run"),
        };
      } finally {
        removeDetach?.();
      }
    }

    if (params.action === "list") {
      if (jobs.size === 0) return { content: [{ type: "text", text: "No background jobs." }], details: { action: "list" } };
      const lines = [...jobs.values()].map(
        (j) => `${j.id}\t${jobStatus(j)}${j.done ? `(exit ${j.exitCode})` : ""}\tpid ${j.pid}\t${j.command}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }], details: { action: "list" } };
    }

    if (!params.jobId) throw new Error(`bash_bg ${params.action} requires 'jobId'.`);
    const job = jobs.get(params.jobId);
    if (!job) throw new Error(`Unknown jobId: ${params.jobId}`);

    if (params.action === "status") {
      await effects.observeTargets({
        action: "status",
        targets: [{ kind: "bash_bg", id: job.id }],
        detail: "full",
        lines: tailCount,
      }, signal);
      const state = job.done ? `${jobStatus(job)} (exit ${job.exitCode})` : jobStatus(job);
      const out = tailOutput(job, tailCount);
      const text = `job ${job.id}: ${state}\ncommand: ${job.command}\noutput (tail):\n${out.text || "(empty)"}`;
      return {
        content: [{ type: "text", text: appendLogAccess(text, job, out.truncated) }],
        ...(job.outputFailure ? { isError: true } : {}),
        details: jobDetails(job, "status", out.truncated),
      };
    }

    if (params.action === "kill") {
      const alreadyFinished = job.done
        && !job.terminationFailure
        && (effects.platform() === "win32" || !effects.processGroupRunning(job.pid));
      await terminateJob(job);
      const cleanupNote = effects.platform() === "win32" && !job.treeCleanupConfirmed
        ? " Leader exited; Windows descendant cleanup is unconfirmed."
        : "";
      return {
        content: [{ type: "text", text: `${alreadyFinished ? "Job already finished" : job.done ? "Stopped job" : "Stopping job"} ${job.id} (pid ${job.pid}).${cleanupNote}` }],
        details: jobDetails(job, "kill"),
      };
    }

    const timeoutMs = (params.timeout ?? 30) * 1000;
    const observed = await effects.observeTargets({
      action: "wait",
      targets: [{ kind: "bash_bg", id: job.id }],
      detail: "full",
      lines: tailCount,
      timeoutMs,
    }, signal);
    if (observed.reason === "aborted") throw new Error("aborted");
    const state = job.done
      ? `${jobStatus(job)} (exit ${job.exitCode})`
      : `${jobStatus(job)} after ${Math.round(timeoutMs / 1000)}s`;
    const out = tailOutput(job, tailCount);
    const text = `job ${job.id}: ${state}\ncommand: ${job.command}\noutput (tail):\n${out.text || "(empty)"}`;
    return {
      content: [{ type: "text", text: appendLogAccess(text, job, out.truncated) }],
      ...(job.outputFailure ? { isError: true } : {}),
      details: jobDetails(job, "wait", out.truncated),
    };
  };

  const compact = (): void => {
    const running = [...jobs.values()].filter(jobIsActive);
    if (running.length === 0) return;
    const lines = running.map((job) => `- ${job.id} (pid ${job.pid}): ${job.command}`);
    const body = [
      `${running.length} background bash job${running.length === 1 ? " is" : "s are"} still running after compaction:`,
      ...lines,
      "Each sends a bash-bg-complete notification when finished. Use bash_bg action=status jobId=<id> to peek or action=kill jobId=<id> to stop one.",
    ].join("\n");
    effects.announceRunning(body, running.map((job) => job.id));
  };

  const shutdown = async (): Promise<void> => {
    if (disposed) return;
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    const retiringBaseDir = baseDir;
    const retiringJobs = [...jobs.values()];
    for (const job of retiringJobs) job.background = false;
    const terminationTargets = retiringJobs.filter(jobIsActive);
    const terminationResults = await Promise.allSettled(terminationTargets.map((job) => terminateJob(job)));
    const shutdownFailures: unknown[] = terminationResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );

    for (const job of retiringJobs) {
      if (job.outputDrainTimer) {
        clearTimeout(job.outputDrainTimer);
        job.outputDrainTimer = undefined;
      }
      try {
        job.releaseProcess?.();
      } catch (error) {
        shutdownFailures.push(error);
      }
      job.releaseProcess = undefined;
      job.finishTermination = undefined;
      job.outputFinalized = true;
      job.cachedSnapshot = undefined;
      for (const settle of [...(observationWaiters.get(job.id) ?? [])]) {
        try {
          settle();
        } catch (error) {
          shutdownFailures.push(error);
        }
      }
    }
    publishSnapshot();

    disposed = true;
    runtimeGeneration += 1;
    if (typeof disposeQueryListener === "function") disposeQueryListener();
    if (typeof disposeObservationProvider === "function") disposeObservationProvider();
    disposeQueryListener = undefined;
    disposeObservationProvider = undefined;
    jobs.clear();
    observationWaiters.clear();
    baseDir = "";
    try { effects.removeRuntimeDirectory(retiringBaseDir); } catch { /* open Windows handles may finish after shutdown */ }
    if (shutdownFailures.length > 0) {
      const reasons = shutdownFailures.map((failure) => failure instanceof Error ? failure.message : String(failure));
      throw new AggregateError(
        shutdownFailures,
        `Failed to fully reclaim ${shutdownFailures.length} bash background resource${shutdownFailures.length === 1 ? "" : "s"} during session shutdown: ${reasons.join("; ")}`,
      );
    }
  };

  return { initializeRuntime, execute, compact, shutdown };
}
