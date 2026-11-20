import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { resolveCoreCliInvocation } from "./core-cli-invocation.ts";
import { reclaimOwnedProcessTree } from "../process/owned-process-tree.ts";

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const PI_PACKAGE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

function advertisedPiPackageRoot(): string {
  if (existsSync(resolvePath(PI_PACKAGE_ROOT, ".pi", "skills"))) return PI_PACKAGE_ROOT;
  const sourceWorkspaceRoot = resolvePath(PI_PACKAGE_ROOT, "../..");
  return existsSync(resolvePath(sourceWorkspaceRoot, ".pi", "skills"))
    ? sourceWorkspaceRoot
    : PI_PACKAGE_ROOT;
}

import { RunCliAdapter as CoreRunCliAdapter, errorMessage } from "pi-graph-provider-backend/engine/adapter";
import type { RunCliResult, RunCliRunner, RunCliRunnerOptions } from "pi-graph-provider-backend/engine";
export type * from "pi-graph-provider-backend/engine/contracts";
export { UnsupportedRunCapabilityError } from "pi-graph-provider-backend/engine/adapter";

/** Host assembly keeps the original constructor default and physical CLI lifetime. */
export class RunCliAdapter extends CoreRunCliAdapter {
  constructor(workflowRoot: string, runner: RunCliRunner = defaultRunner) {
    super(workflowRoot, runner);
  }
}

export interface DefaultRunCliOptions extends RunCliRunnerOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  executable?: string;
  spawnProcess?: typeof crossSpawn;
  /** Optional caller-owned environment. Omitted preserves the legacy inherited environment. */
  environment?: NodeJS.ProcessEnv;
}

export async function defaultRunner(
  args: readonly string[],
  cwd: string,
  options: DefaultRunCliOptions = {},
): Promise<RunCliResult> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, "timeoutMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
  const spawnProcess = options.spawnProcess ?? crossSpawn;
  if (options.signal?.aborted) {
    return {
      argv: [...args],
      stdout: "",
      stderr: "maestro CLI aborted",
      exitCode: 1,
    };
  }
  const invocation = resolveCoreCliInvocation(args, PI_PACKAGE_ROOT, options.executable);
  return new Promise((resolve) => {
    const child = spawnProcess(invocation.executable, invocation.args, {
      cwd,
      // POSIX group isolation only: the CLI remains referenced and its group
      // is reclaimed on normal exit as well as abort/timeout/failure.
      detached: process.platform !== "win32",
      env: options.environment ?? {
        ...process.env,
        MAESTRO_PI_PACKAGE_ROOT: process.env.MAESTRO_PI_PACKAGE_ROOT ?? advertisedPiPackageRoot(),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failure: string | undefined;
    let reclamationStarted = false;
    let closeSeen = false;
    let normalExitCode: number | null = null;
    let normalReclamationComplete = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stdout?.removeListener("error", onStdoutError);
      child.stderr?.removeListener("data", onStderr);
      child.stderr?.removeListener("error", onStderrError);
    };
    const finish = (exitCode: number, message?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const capturedStderr = Buffer.concat(stderr).toString("utf8");
      resolve({
        argv: [...args],
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: message ? boundedDiagnostic(capturedStderr, message, maxOutputBytes) : capturedStderr,
        exitCode,
      });
    };
    const stopWith = (message: string): void => {
      if (failure !== undefined || settled || reclamationStarted) return;
      failure = message;
      reclamationStarted = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      void reclaimOwnedProcessTree(child, { label: "maestro CLI" }).then(
        () => finish(1, message),
        (error) => finish(1, `${message}; process-tree cleanup failed: ${errorMessage(error)}`),
      );
    };
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      if (failure !== undefined || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (outputBytes + buffer.byteLength > maxOutputBytes) {
        stopWith(`maestro CLI output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      outputBytes += buffer.byteLength;
      target.push(buffer);
    };
    const finishNormalClose = (): void => {
      if (!closeSeen || !normalReclamationComplete || failure !== undefined || settled) return;
      finish(normalExitCode ?? 1);
    };
    const startNormalReclamation = (code: number | null): void => {
      if (failure !== undefined || settled || reclamationStarted) return;
      reclamationStarted = true;
      normalExitCode = code;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void reclaimOwnedProcessTree(child, { label: "maestro CLI" }).then(
        () => {
          normalReclamationComplete = true;
          finishNormalClose();
        },
        (error) => finish(1, `maestro CLI exited but process-tree cleanup was unconfirmed: ${errorMessage(error)}`),
      );
    };
    const onStdout = (chunk: Buffer | string): void => collect(stdout, chunk);
    const onStderr = (chunk: Buffer | string): void => collect(stderr, chunk);
    const onStdoutError = (error: Error): void => stopWith(`maestro CLI stdout failed: ${errorMessage(error)}`);
    const onStderrError = (error: Error): void => stopWith(`maestro CLI stderr failed: ${errorMessage(error)}`);
    const onError = (error: Error): void => {
      const message = errorMessage(error);
      if (child.pid) stopWith(message);
      else finish(1, message);
    };
    const onExit = (code: number | null): void => startNormalReclamation(code);
    const onClose = (code: number | null): void => {
      closeSeen = true;
      startNormalReclamation(code);
      finishNormalClose();
    };
    const onAbort = (): void => stopWith("maestro CLI aborted");
    const timer = setTimeout(
      () => stopWith(`maestro CLI timed out after ${timeoutMs}ms`),
      timeoutMs,
    );
    timer.unref?.();

    child.stdout?.on("data", onStdout);
    child.stdout?.on("error", onStdoutError);
    child.stderr?.on("data", onStderr);
    child.stderr?.on("error", onStderrError);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedDiagnostic(stderr: string, message: string, maxBytes: number): string {
  const combined = stderr ? `${stderr}\n${message}` : message;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  if (Buffer.byteLength(message, "utf8") <= maxBytes) return message;
  let truncated = "";
  let usedBytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) break;
    truncated += character;
    usedBytes += characterBytes;
  }
  return truncated;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

