import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { observeTargets, registerObservationProvider } from "pi-maestro-teammate/v1/observation";
import { registerForegroundDetach } from "pi-maestro-teammate/v1/foreground-detach";
import { sanitizeCardText, toolCallLine, toolResultCard, toolResultLine, resultFirstLine } from "pi-cockpit/src/quiet-tools.ts";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runToolNotification } from "./tool-result.ts";

import {
  createBashBgJobOwner,
  type BashBgCompletionDetails,
  type BashBgDetails,
  type BashBgJobProcess,
  type BashBgJobStatus,
  type BashBgShellConfig,
  type RegisterBashBgOptions,
} from "../execution-job/job-owner.ts";

export { classifyWindowsTaskkill, windowsTaskkillFailure } from "../execution-job/job-owner.ts";
export type {
  BashBgDetails,
  BashBgJobSnapshot,
  BashBgJobStatus,
  BashBgSnapshotPayload,
  RegisterBashBgOptions,
  WindowsTaskkillOutcome,
  WindowsTaskkillResult,
} from "../execution-job/job-owner.ts";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

export const BASH_BG_UPDATE_EVENT = "bash-bg:update";
export const BASH_BG_QUERY_EVENT = "bash-bg:query";

function isBashBgJobStatus(value: unknown): value is BashBgJobStatus {
  return value === "running"
    || value === "stopping"
    || value === "completed"
    || value === "failed"
    || value === "killed";
}

export const BashBgParams = Type.Object({
  action: Type.Union(
    [Type.Literal("run"), Type.Literal("start"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")],
    { description: "run: block up to timeout, or press Alt+B in the TUI to detach, then continue in background (recommended for uncertain-duration commands); start: background immediately; status: snapshot; wait: block until done/timeout; kill: terminate; list: all jobs" },
  ),
  command: Type.Optional(Type.String({ minLength: 1, description: "Shell command (required for run/start)" })),
  jobId: Type.Optional(Type.String({ description: "Job id returned by run/start (required for status/wait/kill)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for run/start (default: session cwd)" })),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "run: foreground seconds before auto-backgrounding; wait: max seconds to block (default 30)" })),
  tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "output lines to include (default 20)" })),
});

function signalProcessTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  if (pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when it has already left its process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

function processGroupRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function spawnJob(shellConfig: BashBgShellConfig, command: string, workdir: string): BashBgJobProcess {
  const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
    cwd: workdir,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid ?? -1;
  return {
    pid,
    observe(hooks) {
      // Error listeners intentionally survive pipe destruction and late cleanup.
      child.stdout?.on("error", hooks.onStdoutError);
      child.stderr?.on("error", hooks.onStderrError);
      child.stdout?.on("data", hooks.onData);
      child.stderr?.on("data", hooks.onData);
      child.on("exit", hooks.onExit);
      child.on("close", hooks.onClose);
      child.on("error", hooks.onError);
      // Do not let the child keep pi's loop alive; close still fires while pi is interactive.
      child.unref();
    },
    release(hooks) {
      child.stdout?.off("data", hooks.onData);
      child.stderr?.off("data", hooks.onData);
      child.off("exit", hooks.onExit);
      child.off("close", hooks.onClose);
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    signalTree: (signal) => signalProcessTree(child, pid, signal),
  };
}

/** Register the original SDK tool and wire the runtime to real OS and UI effects. */
export function registerBashBg(pi: ExtensionAPI, options: RegisterBashBgOptions = {}): void {
  const owner = createBashBgJobOwner({
    platform: () => process.platform,
    cwd: () => process.cwd(),
    makeRuntimeDirectory() {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-bg-"));
      if (process.platform !== "win32") fs.chmodSync(baseDir, 0o700);
      return baseDir;
    },
    removeRuntimeDirectory: (root) => { fs.rmSync(root, { recursive: true, force: true }); },
    logPath: (baseDir, id) => path.join(baseDir, `${id}.log`),
    openLog(file, onError) {
      const logFd = fs.openSync(file, "wx", 0o600);
      const stream = fs.createWriteStream(file, { fd: logFd, autoClose: true });
      // Keep this listener even after end/destroy: disk failures can arrive late.
      stream.on("error", onError);
      return {
        write: (bytes) => { stream.write(bytes); },
        end: () => { stream.end(); },
        destroy: () => { stream.destroy(); },
      };
    },
    readLog: (file) => fs.readFileSync(file, "utf8"),
    removeLog: (file) => { fs.rmSync(file, { force: true }); },
    getShellConfig,
    spawnJob,
    processGroupRunning,
    taskkill(pid) {
      // Async spawn of taskkill silently fails to complete under pi's jiti loader on Windows.
      return spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
    },
    registerObservation: registerObservationProvider,
    onSnapshotQuery(publish) {
      // Cockpit may subscribe after tool registration, then query the same owner.
      const dispose = pi.events.on(BASH_BG_QUERY_EVENT, publish);
      return typeof dispose === "function" ? dispose : undefined;
    },
    observeTargets,
    publishSnapshot: (payload) => {
      runToolNotification("bash_bg snapshot", () => pi.events.emit(BASH_BG_UPDATE_EVENT, payload));
    },
    sendCompletion: (content, details) => {
      runToolNotification("bash_bg completion", () => pi.sendMessage(
        { customType: "bash-bg-complete", content, display: true, details },
        { triggerTurn: true },
      ));
    },
    announceRunning: (content, ids) => {
      pi.sendMessage(
        { customType: "bash-bg-running", content, display: true, details: { jobs: ids } },
        { deliverAs: "nextTurn" },
      );
    },
    reportLogError: (error) => { runToolNotification("bash_bg log stream", () => { throw error; }); },
  }, options);

  owner.initializeRuntime();
  pi.on("session_start", owner.initializeRuntime);

  pi.registerMessageRenderer<BashBgCompletionDetails>("bash-bg-complete", (message, renderOptions, theme) => {
    const details = message.details;
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((entry) => entry.type === "text" ? entry.text : "").filter(Boolean).join("\n");
    const status = isBashBgJobStatus(details?.status)
      ? details.status
      : ((details?.exitCode ?? 1) === 0 ? "completed" : "failed");
    const failed = status !== "completed" || details?.exitCode !== 0;
    const groups: string[][] = [];
    const command = details?.command ? sanitizeCardText(details.command) : "";
    if (command) groups.push([`command ${command}`]);

    const outputLines = (details?.outputTail ?? "")
      .split("\n")
      .map((line) => sanitizeCardText(line))
      .filter(Boolean);
    if (outputLines.length > 0) {
      const visible = renderOptions.expanded || outputLines.length <= 6
        ? outputLines
        : [`… ${outputLines.length - 6} earlier output lines`, ...outputLines.slice(-6)];
      groups.push(visible);
    }
    const access = [
      details?.logPath ? `log ${sanitizeCardText(details.logPath)}` : "",
      details?.viewCommand ? `view ${sanitizeCardText(details.viewCommand)}` : "",
    ].filter(Boolean);
    if (access.length > 0) groups.push(access);
    if (groups.length === 0) {
      const fallback = content.split("\n").map((line) => sanitizeCardText(line)).filter(Boolean);
      if (fallback.length > 0) groups.push(renderOptions.expanded ? fallback : fallback.slice(0, 8));
    }

    const exit = details?.exitCode === null || details?.exitCode === undefined ? "" : ` · exit ${details.exitCode}`;
    return toolResultCard(theme, {
      name: "bash-bg-complete",
      ok: !failed,
      summary: `${sanitizeCardText(details?.jobId ?? "job", 80)} · ${status}${exit}`,
      groups,
      maxBodyRows: renderOptions.expanded ? undefined : 8,
    });
  });

  pi.registerTool({
    name: "bash_bg",
    label: "Background Bash",
    description:
      "Run shell commands with adaptive foreground/background execution and job control. " +
      "action=run (recommended) blocks like the bash tool for up to timeout seconds and returns the output inline if the command finishes in time; press Alt+B in the TUI to detach sooner, otherwise a still-running command automatically moves to the background at timeout and returns a jobId, with a bash-bg-complete notification (a new turn) on completion. " +
      "action=start backgrounds immediately (ack now). action=status returns a live snapshot + output tail; action=wait blocks an existing job until done or timeout; action=kill terminates the job's process tree; action=list shows all jobs. " +
      "Example: { action: \"run\", command: \"npm run build\", timeout: 60 }.",
    promptSnippet: "Run shell commands adaptively: action=run blocks like bash, Alt+B detaches it in the TUI, and timeout auto-backgrounds it; start/status/wait/kill/list provide job control, with a completion notification that triggers a new turn.",
    promptGuidelines: [
      "Default to the bash tool for ordinary commands — blocking for tens of seconds is fine. Reach for bash_bg when a command is unbounded (dev server, watcher, tail -f), expected to run for minutes, or you want to keep working concurrently.",
      "When unsure how long a command will take, use bash_bg action=run: it blocks like bash for up to timeout seconds and returns output inline if fast; Alt+B detaches it sooner in the TUI, otherwise it auto-backgrounds at timeout and notifies you (bash-bg-complete, a new turn) when done.",
      "Use action=start to background immediately without blocking. After a job backgrounds, do not poll; wait for the notification or call action=wait once. action=status peeks at output and action=kill stops a job.",
    ],
    parameters: BashBgParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<BashBgDetails>> {
      return owner.execute(params, signal, (detach) => ctx?.hasUI
        ? registerForegroundDetach(detach, ctx.ui)
        : undefined);
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "start");
      const target = (args.action === "start" || args.action === "run") ? String(args.command ?? "").slice(0, 50) : String(args.jobId ?? "");
      return toolCallLine(theme, "bash_bg", target ? `${action} ${target}` : action);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as BashBgDetails | undefined;
      const isError = ctx.isError || (result as { isError?: boolean }).isError === true;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      const running = !isError && details?.running === true;
      const mark = running
        ? theme.fg("warning", "•")
        : (!isError && (details?.exitCode ?? 0) === 0
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗"));
      return toolResultLine(theme, {
        name: "bash_bg",
        mark,
        summary: resultFirstLine(result),
        expanded: opts.expanded,
        detail: text,
      });
    },
  });

  pi.on("session_compact", owner.compact);
  pi.on("session_shutdown", owner.shutdown);
}
