/** Host-memory-only session preauthorization. No session entry is ever replayed. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export const PLAN_AUTO_KEY = "alt+shift+a";
export const PLAN_AUTO_AUDIT_ENTRY = "maestro-plan-auto-audit";
export const AUTO_AUDIT_ENTRY = "maestro-auto-audit";
const DEFAULT_ASK_TIMEOUT_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
export interface AskAutoGrantSnapshot {
  readonly sessionId: string;
  readonly cwd: string;
  readonly generation: number;
  readonly timeoutMs: number;
}
export type PlanAutoContext = Pick<ExtensionContext, "cwd" | "sessionManager">;
export interface PlanAutoTaskContext {
  readonly markdown: string;
  readonly revision: number;
  readonly handoffKey?: string;
}
export interface PlanAutoGrantSnapshot {
  readonly sessionId: string;
  readonly cwd: string;
  readonly planCycle: number;
  readonly generation: number;
  /** Only plan-confirm may use this; ask remains allowed after consumption. */
  readonly confirmPending: boolean;
  readonly taskContext: Readonly<PlanAutoTaskContext>;
}

let generation = 0;
let planCycle = 0;
let cycleScope: { sessionId: string; cwd: string } | undefined;
let taskContext: Readonly<PlanAutoTaskContext> = Object.freeze({ markdown: "", revision: 0 });
let grant: PlanAutoGrantSnapshot | undefined;
let lastReason = "default-off";
let askGrant: Readonly<AskAutoGrantSnapshot> | undefined;
let askGeneration = 0;
let askLastReason = "default-off";
let authorityEpoch = 0;
let askStatusUI: ExtensionContext["ui"] | undefined;

function refreshAskStatus(): void {
  askStatusUI?.setStatus("maestro-ask-auto", askGrant
    ? `ASK-AUTO on ${askGrant.timeoutMs / 1000}s g${askGrant.generation}` : undefined);
}
function revokeAskAuto(reason: string): void {
  authorityEpoch++;
  if (askGrant) askGeneration++;
  askGrant = undefined;
  askLastReason = reason;
  refreshAskStatus();
}
function revokeSessionAuto(reason: string): void {
  revokePlanAuto(reason);
  revokeAskAuto(reason);
}

function scope(ctx: PlanAutoContext) {
  return { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
}
function sameScope(a: { sessionId: string; cwd: string }, b: { sessionId: string; cwd: string }): boolean {
  return !!a.sessionId && !!a.cwd && a.sessionId === b.sessionId && a.cwd === b.cwd;
}

/** Explicit revocation fences every outstanding snapshot. Does not stop already-started execution. */
export function revokePlanAuto(reason: string): void {
  authorityEpoch++;
  if (grant) generation++;
  grant = undefined;
  lastReason = reason;
}

/** Rebind session authorization on an actual Act -> Plan transition. */
export function beginPlanAutoCycle(ctx: PlanAutoContext, task: PlanAutoTaskContext): void {
  const current = getPlanAutoSnapshot(ctx);
  planCycle++;
  cycleScope = scope(ctx);
  taskContext = Object.freeze({ ...task });
  if (current) grant = Object.freeze({ ...current, planCycle, confirmPending: true, taskContext });
}

/** Clear task authority without disabling the human session preference. */
export function clearPlanAutoTaskContext(): void {
  taskContext = Object.freeze({ markdown: "", revision: 0 });
  if (grant) grant = Object.freeze({ ...grant, generation: ++generation, taskContext });
}

export function endPlanAutoCycle(): void {
  clearPlanAutoTaskContext();
  cycleScope = undefined;
  if (grant) grant = Object.freeze({ ...grant, confirmPending: false });
}

export function resetPlanAuto(reason: string): void {
  revokeSessionAuto(reason);
  cycleScope = undefined;
  taskContext = Object.freeze({ markdown: "", revision: 0 });
}

/** Revision changes preserve authorization but update its bounded task context. */
export function updatePlanAutoTaskContext(ctx: PlanAutoContext, task: PlanAutoTaskContext): void {
  if (!cycleScope) {
    revokePlanAuto("scope-changed");
    return;
  }
  if (!sameScope(cycleScope, scope(ctx))) {
    revokeSessionAuto("scope-changed");
    return;
  }
  taskContext = Object.freeze({ ...task });
  if (grant) grant = Object.freeze({ ...grant, taskContext });
}

/** Call at each async boundary; reading from another session/cwd permanently revokes. */
function observeScope(ctx: PlanAutoContext): boolean {
  if (!grant && !askGrant) return true;
  let observed: ReturnType<typeof scope>;
  try { observed = scope(ctx); } catch {
    // Stale Pi context getters must not revoke a newer session's authority.
    return false;
  }
  if ((grant && !sameScope(grant, observed)) || (askGrant && !sameScope(askGrant, observed))) {
    revokeSessionAuto("scope-changed");
  }
  return true;
}
export function getPlanAutoSnapshot(ctx: PlanAutoContext): PlanAutoGrantSnapshot | undefined {
  return observeScope(ctx) ? grant : undefined;
}

/** Independent Ask preference; only attested human commands can create it. */
export function getAskAutoSnapshot(ctx: PlanAutoContext): Readonly<AskAutoGrantSnapshot> | undefined {
  return observeScope(ctx) ? askGrant : undefined;
}

/** Check at every asynchronous boundary, including the final answer delivery. */
export function isCurrentAskAutoGrant(snapshot: Readonly<AskAutoGrantSnapshot>, ctx: PlanAutoContext): boolean {
  if (!askGrant || askGrant.generation !== snapshot.generation) return false;
  const current = getAskAutoSnapshot(ctx);
  return !!current && current.generation === snapshot.generation && sameScope(current, snapshot)
    && current.timeoutMs === snapshot.timeoutMs;
}

/** Identity fence for confirm/approval/handoff; consumption does not invalidate this fence. */
export function isCurrentPlanAutoGrant(snapshot: PlanAutoGrantSnapshot, ctx: PlanAutoContext): boolean {
  if (!grant || grant.generation !== snapshot.generation || grant.planCycle !== snapshot.planCycle) return false;
  const current = getPlanAutoSnapshot(ctx);
  return !!current && current.generation === snapshot.generation && current.planCycle === snapshot.planCycle
    && sameScope(current, snapshot);
}

/** Ask additionally fences changes to the task material used for classification/advice. */
export function isCurrentPlanAutoTask(snapshot: PlanAutoGrantSnapshot, ctx: PlanAutoContext): boolean {
  return isCurrentPlanAutoGrant(snapshot, ctx) && grant!.taskContext.markdown === snapshot.taskContext.markdown
    && grant!.taskContext.revision === snapshot.taskContext.revision
    && grant!.taskContext.handoffKey === snapshot.taskContext.handoffKey;
}

/** T2 calls only after a successful manifest commit, before switching to Act. */
export function markPlanAutoConfirmed(ctx: PlanAutoContext, snapshot: PlanAutoGrantSnapshot, task: PlanAutoTaskContext): boolean {
  if (!isCurrentPlanAutoGrant(snapshot, ctx) || !grant!.confirmPending) return false;
  updatePlanAutoTaskContext(ctx, task);
  grant = Object.freeze({ ...grant!, confirmPending: false });
  return true;
}

export function getPlanAutoState(ctx: PlanAutoContext) {
  const snapshot = getPlanAutoSnapshot(ctx);
  return Object.freeze({ enabled: !!snapshot, generation, planCycle, reason: lastReason, snapshot });
}

export function planAutoStatusLabel(ctx: PlanAutoContext): string {
  const snapshot = getPlanAutoSnapshot(ctx);
  return snapshot ? `PLAN-AUTO ${snapshot.confirmPending ? "confirm+ask" : snapshot.taskContext.markdown.trim() ? "ask" : "on"} g${snapshot.generation}` : "PLAN-AUTO off";
}

/**
 * Pi 0.99 dispatches registered commands BEFORE source-aware input hooks and
 * creates an identical CommandContext for interactive/rpc/extension input.
 * hasUI (even mode=tui) therefore cannot attest a command's human origin.
 * Register discovery/completion, but deny grant creation in that callback.
 * The TUI raw terminal callback consumes a physical Enter submission itself;
 * it never leaves a reusable provenance token for a machine command to steal.
 * Source-aware input hooks reject sendUserMessage (source=extension) and RPC.
 */
export function registerPlanAuto(pi: ExtensionAPI, options: {
  isPlanMode(): boolean;
  onStateChange(ctx: ExtensionContext): void;
}): void {
  resetPlanAuto("reload");
  askStatusUI = undefined;
  let terminalDispose: (() => void) | undefined;
  let activeCtx: ExtensionContext | undefined;
  let promptDepth = 0;
  let authorizing = false;

  function isHuman(ctx: ExtensionContext, origin: "terminal" | "shortcut" | "unattested"): boolean {
    if (origin === "unattested" || ctx.mode !== "tui" || !ctx.hasUI
      || process.env.PI_TEAMMATE_CHILD === "1" || activeCtx === undefined || promptDepth) return false;
    try { return sameScope(scope(activeCtx), scope(ctx)); } catch { return false; }
  }

  function handle(args: string, ctx: ExtensionContext, origin: "terminal" | "shortcut" | "unattested"): void {
    const action = args.trim().toLowerCase();
    if (action && !["on", "off", "status"].includes(action)) {
      ctx.ui.notify("用法：/plan-auto [on|off|status]（无参数切换）", "warning");
      return;
    }
    const current = getPlanAutoSnapshot(ctx);
    if (action === "status") {
      ctx.ui.notify(`Plan-auto: ${planAutoStatusLabel(ctx)} · ${lastReason}`, "info");
      options.onStateChange(ctx);
      return;
    }
    const enabling = action === "on" || (!action && !current);
    if (enabling) {
      if (!isHuman(ctx, origin) || authorizing) {
        ctx.ui.notify("Plan-auto 未开启：无法认证真人交互来源。请在父会话 TUI 输入 /plan-auto on 或按 Alt+Shift+A。", "warning");
        options.onStateChange(ctx);
        return;
      }
      if (!current) {
        if (!cycleScope || !sameScope(cycleScope, scope(ctx))) {
          cycleScope = scope(ctx);
          taskContext = Object.freeze({ markdown: "", revision: 0 });
        }
        generation++;
        grant = Object.freeze({ ...scope(ctx), planCycle, generation, confirmPending: options.isPlanMode(), taskContext });
        lastReason = "human-preauthorization";
        try {
          pi.appendEntry(PLAN_AUTO_AUDIT_ENTRY, { action: "on", origin,
            sessionId: grant.sessionId, cwd: grant.cwd, planCycle, generation, replayable: false });
        } catch {
          revokePlanAuto("audit-failed");
          options.onStateChange(ctx);
          ctx.ui.notify("Plan-auto 未开启：宿主审计写入失败。", "warning");
          return;
        }
      }
      ctx.ui.notify("Plan-auto 已开启（当前会话持续有效，Act 中也可开启，退出/清空 Plan 不关闭）：每个 Plan 周期的 plan-confirm 自动批准并执行，固定 standalone/current；内部问答可能使用 classifier 和现有 LLM fallback。敏感操作、权限、配置、发布、支付、凭证、知识晋升仍须人工；不启用 classifier、不修改项目 policy。/plan-auto off 或 Alt+Shift+A 关闭（不会终止已开始执行）。", "info");
    } else {
      revokePlanAuto("off");
      if (current) pi.appendEntry(PLAN_AUTO_AUDIT_ENTRY, { action: "off", origin, generation, replayable: false });
      ctx.ui.notify("Plan-auto 已关闭；后续自动决策停止，已开始的执行不受影响。", "info");
    }
    options.onStateChange(ctx);
  }

  function handleAuto(args: string, ctx: ExtensionContext, origin: "terminal" | "unattested"): void {
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const target = parts[0] === "plan" || parts[0] === "ask" ? parts.shift()! : "all";
    const action = parts.shift() ?? "status";
    const seconds = parts.shift();
    let timeoutMs = DEFAULT_ASK_TIMEOUT_MS;
    if (parts.length || !["on", "off", "status"].includes(action)
      || (seconds !== undefined && (target !== "ask" || action !== "on"))) {
      ctx.ui.notify("用法：/auto [on|off|status]；/auto plan [on|off|status]；/auto ask [on|off|status] [seconds]（无参数 status）", "warning");
      return;
    }
    if (seconds !== undefined) {
      timeoutMs = Number(seconds) * 1000;
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(seconds)
        || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
        ctx.ui.notify("Ask-auto seconds 必须为正有限数，范围 0.001–2147483.647 秒。", "warning");
        return;
      }
    }
    // Parse everything before observing scope or changing either preference.
    if (action === "on" && (!isHuman(ctx, origin) || authorizing)) {
      ctx.ui.notify("Auto 未开启：无法认证真人交互来源。请在父会话 TUI 输入 /auto on。", "warning");
      return;
    }
    const currentPlan = getPlanAutoSnapshot(ctx);
    const currentAsk = getAskAutoSnapshot(ctx);
    if (action === "status") {
      ctx.ui.notify(`Auto · Plan: ${planAutoStatusLabel(ctx)} · ${lastReason}; Ask: ${currentAsk
        ? `ASK-AUTO on ${currentAsk.timeoutMs / 1000}s g${currentAsk.generation}` : "ASK-AUTO off"} · ${askLastReason}`, "info");
      refreshAskStatus();
      options.onStateChange(ctx);
      return;
    }
    const affectsPlan = target !== "ask";
    const affectsAsk = target !== "plan";
    if (action === "off") {
      if (affectsPlan) revokePlanAuto("off");
      if (affectsAsk) revokeAskAuto("off");
      try {
        if ((affectsPlan && currentPlan) || (affectsAsk && currentAsk)) {
          pi.appendEntry(AUTO_AUDIT_ENTRY, { action, target, origin, ...scope(ctx),
            generation, askGeneration, replayable: false });
        }
      } catch {
        ctx.ui.notify("Auto 已关闭；宿主审计写入失败，授权不会恢复。", "warning");
        options.onStateChange(ctx);
        return;
      }
    } else {
      const observed = scope(ctx);
      const reuseTask = !!cycleScope && sameScope(cycleScope, observed);
      const nextPlan = affectsPlan && !currentPlan ? Object.freeze({ ...observed, planCycle,
        generation: generation + 1, confirmPending: options.isPlanMode(),
        taskContext: reuseTask ? taskContext : Object.freeze({ markdown: "", revision: 0 }) }) : currentPlan;
      const nextAsk = affectsAsk && (!currentAsk || currentAsk.timeoutMs !== timeoutMs)
        ? Object.freeze({ ...observed, generation: askGeneration + 1, timeoutMs }) : currentAsk;
      if (nextPlan !== currentPlan || nextAsk !== currentAsk) {
        const epoch = authorityEpoch;
        authorizing = true;
        try {
          // Audit precedes publication; a failed or synchronously revoked audit
          // can never create partial /auto on authority.
          pi.appendEntry(AUTO_AUDIT_ENTRY, { action, target, origin, ...observed,
            planCycle, generation: nextPlan?.generation, askGeneration: nextAsk?.generation,
            timeoutMs: nextAsk?.timeoutMs, replayable: false });
          if (authorityEpoch !== epoch || grant !== currentPlan || askGrant !== currentAsk
            || !isHuman(ctx, origin) || !sameScope(observed, scope(ctx))) {
            ctx.ui.notify("Auto 未开启：审计期间会话或授权已变更。", "warning");
            options.onStateChange(ctx);
            return;
          }
          if (affectsPlan && nextPlan) {
            if (!reuseTask) { cycleScope = observed; taskContext = nextPlan.taskContext; }
            grant = nextPlan;
            generation = nextPlan.generation;
            lastReason = "human-preauthorization";
          }
          if (affectsAsk && nextAsk) {
            askGrant = nextAsk;
            askGeneration = nextAsk.generation;
            askLastReason = "human-preauthorization";
          }
        } catch {
          ctx.ui.notify("Auto 未开启：宿主审计写入失败。", "warning");
          options.onStateChange(ctx);
          return;
        } finally { authorizing = false; }
      }
    }
    refreshAskStatus();
    options.onStateChange(ctx);
    ctx.ui.notify(`Auto ${target}: ${action === "on" ? "已开启（当前会话）" : "已关闭"}。敏感操作仍须人工；不修改 classifier 或项目 policy，不终止已开始执行。`, "info");
  }

  pi.registerCommand("auto", {
    description: "真人会话自动化：/auto [on|off|status]；/auto plan …；/auto ask on [seconds]，默认 60 秒",
    getArgumentCompletions(prefix) {
      return ["on", "off", "status", "plan", "ask", "plan on", "plan off", "plan status", "ask on", "ask off", "ask status"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) { handleAuto(args, ctx, "unattested"); },
  });

  function commandMatch(text: string) {
    return /^\/(plan-auto|auto)(?:\s+(.*))?$/i.exec(text.trim());
  }
  function dispatch(match: RegExpExecArray, ctx: ExtensionContext, origin: "terminal" | "unattested") {
    if (match[1].toLowerCase() === "auto") handleAuto(match[2] ?? "", ctx, origin);
    else handle(match[2] ?? "", ctx, origin);
  }

  pi.registerCommand("plan-auto", {
    description: "真人会话预授权：/plan-auto [on|off|status]，默认关闭；Alt+Shift+A 切换",
    getArgumentCompletions(prefix) {
      return ["on", "off", "status"].filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) { handle(args, ctx, "unattested"); },
  });
  pi.registerShortcut(PLAN_AUTO_KEY, {
    description: "Toggle human Plan-auto preauthorization (Alt+Shift+A)",
    async handler(ctx) { if (!promptDepth) handle("", ctx, "shortcut"); },
  });
  pi.on("input", (event, ctx) => {
    const match = commandMatch(event.text);
    if (!match) return;
    // Registered-command dispatch is not source-aware. Only terminal submission
    // and the native shortcut can enable; this hook can safely revoke/report.
    dispatch(match, ctx, "unattested");
    return { action: "handled" };
  });
  pi.on("ui_prompt_start", () => { promptDepth++; });
  pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1); });
  pi.on("session_start", (_event, ctx) => {
    terminalDispose?.();
    terminalDispose = undefined;
    activeCtx = ctx;
    promptDepth = 0;
    resetPlanAuto("session-start");
    askStatusUI = ctx.ui;
    refreshAskStatus();
    if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
      terminalDispose = ctx.ui.onTerminalInput((data) => {
        if (promptDepth || !matchesKey(data, "enter")) return;
        const match = commandMatch(ctx.ui.getEditorText());
        if (!match) return;
        ctx.ui.setEditorText("");
        dispatch(match, ctx, "terminal");
        return { consume: true };
      });
    }
    options.onStateChange(ctx);
  });
  const revokeForSession = (reason: string, ctx: ExtensionContext) => {
    revokeSessionAuto(reason);
    options.onStateChange(ctx);
  };
  pi.on("session_before_switch", (_event, ctx) => { revokeForSession("session-switch", ctx); });
  pi.on("session_before_fork", (_event, ctx) => { revokeForSession("session-fork", ctx); });
  // History navigation is not an authority to recover an earlier audit entry.
  pi.on("session_before_tree", (_event, ctx) => { revokeForSession("history-navigation", ctx); });
  pi.on("session_shutdown", () => {
    terminalDispose?.();
    terminalDispose = undefined;
    activeCtx = undefined;
    resetPlanAuto("shutdown");
    askStatusUI = undefined;
  });
}
