/** Goal host owner. */
import { type GoalContext } from "./types.ts";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export function currentSessionId(ctx: GoalContext): string | undefined {
  const manager = ctx.sessionManager as {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  } | undefined;
  return manager?.getSessionId?.() ?? manager?.getSessionFile?.();
}

export function abortTurn(ctx: GoalContext) { try { ctx.abort?.(); } catch { /* best effort */ } }

export function hasPending(ctx: GoalContext) { return ctx.hasPendingMessages?.() ?? false; }

export function currentTokenTotal(ctx: GoalContext): number | undefined {
  const sm = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; message?: { role?: string; usage?: unknown } }>;
  } | undefined;
  let total = 0;
  try {
    for (const entry of sm?.getBranch?.() ?? []) {
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const u = entry.message.usage as { input?: number; output?: number } | undefined;
      total += (u?.input ?? 0) + (u?.output ?? 0);
    }
  } catch {
    ctx.ui.notify("Goal token usage could not be refreshed; preserving the last known total.", "warning");
    return undefined;
  }
  return total;
}

export function appendGoalEntry(api: ExtensionAPI | undefined, type: string, data: unknown): void {
  if (!api?.appendEntry) throw new Error("Goal persistence unavailable.");
  api.appendEntry(type, structuredClone(data));
}

export function postGoalMessage(api: ExtensionAPI | undefined, prompt: string): boolean {
  if (!api) return false;
  api.sendMessage({customType: "maestro-goal-internal", content: prompt, display: false, details: {source: "goal", internal: true}}, {deliverAs: "followUp", triggerTurn: true});
  return true;
}

export const goalClock = { now: () => Date.now(), newId: () => randomUUID(), setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args), clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args), setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args), clearInterval: (...args: Parameters<typeof clearInterval>) => clearInterval(...args) };

export { getVisibleTasks, detachTasksFromGoal, persistLoadedTodoStateForGoalDetachRecovery } from "../tools/todo.ts";

export { getDeliveryGroups } from "../task-workflow/commands.ts";

export { readTaskHost } from "../task-workflow/delivery-group.ts";
