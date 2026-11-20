/** Physical human/SDK adapter; session authorization has exactly one core owner. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createSessionAutoOwner, PLAN_AUTO_KEY } from "pi-graph-permission-core";
export { PLAN_AUTO_KEY, PLAN_AUTO_AUDIT_ENTRY, AUTO_AUDIT_ENTRY } from "pi-graph-permission-core";
export type { AskAutoGrantSnapshot, PlanAutoContext, PlanAutoTaskContext, PlanAutoGrantSnapshot } from "pi-graph-permission-core";
const owner = createSessionAutoOwner();
export const revokePlanAuto = owner.revokePlanAuto;
export const beginPlanAutoCycle = owner.beginPlanAutoCycle;
export const clearPlanAutoTaskContext = owner.clearPlanAutoTaskContext;
export const endPlanAutoCycle = owner.endPlanAutoCycle;
export const resetPlanAuto = owner.resetPlanAuto;
export const updatePlanAutoTaskContext = owner.updatePlanAutoTaskContext;
export const getPlanAutoSnapshot = owner.getPlanAutoSnapshot;
export const getAskAutoSnapshot = owner.getAskAutoSnapshot;
export const isCurrentAskAutoGrant = owner.isCurrentAskAutoGrant;
export const isCurrentPlanAutoGrant = owner.isCurrentPlanAutoGrant;
export const isCurrentPlanAutoTask = owner.isCurrentPlanAutoTask;
export const markPlanAutoConfirmed = owner.markPlanAutoConfirmed;
export const getPlanAutoState = owner.getPlanAutoState;
export const planAutoStatusLabel = owner.planAutoStatusLabel;
const scope = (ctx: Pick<ExtensionContext,"cwd"|"sessionManager">) => ({cwd:ctx.cwd,sessionId:ctx.sessionManager.getSessionId()});
const sameScope = (a: {cwd:string;sessionId:string}, b:{cwd:string;sessionId:string}) => !!a.cwd && !!a.sessionId && a.cwd===b.cwd && a.sessionId===b.sessionId;
export function registerPlanAuto(pi: ExtensionAPI, options: {
  isPlanMode(): boolean;
  onStateChange(ctx: ExtensionContext): void;
}): void {
  resetPlanAuto("reload");
  owner.setAskStatusPublisher(undefined);
  let terminalDispose: (() => void) | undefined;
  let activeCtx: ExtensionContext | undefined;
  let promptDepth = 0;

  function isHuman(ctx: ExtensionContext, origin: "terminal" | "shortcut" | "unattested"): boolean {
    if (origin === "unattested" || ctx.mode !== "tui" || !ctx.hasUI
      || process.env.PI_TEAMMATE_CHILD === "1" || activeCtx === undefined || promptDepth) return false;
    try { return sameScope(scope(activeCtx), scope(ctx)); } catch { return false; }
  }

  const {handle,handleAuto} = owner.createCommands<ExtensionContext>({
    isHuman, audit: (type,data) => pi.appendEntry(type,data),
    notify: (ctx,text,level) => ctx.ui.notify(text,level),
  },options);
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
    owner.setAskStatusPublisher(text => ctx.ui.setStatus("maestro-ask-auto",text));
    owner.refreshAskStatus();
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
    owner.revokeSessionAuto(reason);
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
    owner.setAskStatusPublisher(undefined);
  });
}
