/** host responsibility; composed by the existing tools/plan entry. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type PlanSessionIdentity, PlanStore, type LoadedPlan, type PlanExecutionChoice } from "../tools/plan-store.ts";
import { type CompactionArbiter, COMPACTION_LEASE_TIMEOUT_MS } from "../compaction/compaction-arbiter.ts";
import { type PlanWorkflowConfirmationOptions } from "../tools/plan-confirm.ts";
import { getVisibleTasks } from "../tools/todo.ts";
import { type PlanTransportResult, type PlanTransportRequest, type PlanTransportHandle, getPlanTransports } from "../plan-transport.ts";
import { ALL_PLAN_TOOL_NAMES } from "./presentation.ts";
import type { PlanState } from "./state.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "./types.ts";

export function createPlanHost(state: PlanState, calls: Pick<PlanCalls, "resetRuntimeState">) {
let extensionApi: ExtensionAPI | undefined;
let onPlanModeChanged: ((ctx: PlanContext) => void) | undefined;
let storeFactory: (cwd: string, session: PlanSessionIdentity) => PlanStore = (cwd, session) => new PlanStore(cwd, { session });
let compactionArbiter: CompactionArbiter | undefined;
let planCompactionHandoffTimeoutMs = COMPACTION_LEASE_TIMEOUT_MS;
let schedulePlanNewContext: PlanRuntimeOptions["scheduleNewContext"];
let restorePlanActModel: NonNullable<PlanRuntimeOptions["restoreActModel"]> = async () => true;
let describePlanModelTransition: NonNullable<PlanRuntimeOptions["describeModelTransition"]> = () => undefined;
let workflowConfirmation = async (_ctx: PlanContext): Promise<PlanWorkflowConfirmationOptions> => ({ allowNew: false });
let publishWorkflowPlan: (ctx: PlanContext, approved: LoadedPlan, execution: PlanExecutionChoice) => Promise<PlanWorkflowPublicationResult> = async () => {
    throw new Error("Workflow-backed Plan execution is unavailable");
};
// The handoff gate reads todos only. Goal state was decoupled from it in 39a5f2dc;
// the getters that used to feed it are gone so they cannot be wired back by accident.
let hasExecutableTodoForHandoff = (handoffKey: string) => getVisibleTasks().some((task) => task.planHandoffKey === handoffKey
    && (task.status === "pending" || task.status === "in_progress")
    && task.blockedBy.length === 0);
async function ensureStore(ctx: PlanContext): Promise<PlanStore> { const session = currentPlanSession(ctx); return state.getOrBindStore(ctx, () => storeFactory(ctx.cwd, session)); }
function currentPlanSession(ctx: PlanContext): PlanSessionIdentity {
    const file = ctx.sessionManager.getSessionFile();
    const name = ctx.sessionManager.getSessionName();
    return {
        id: ctx.sessionManager.getSessionId(),
        ...(file ? { file } : {}),
        ...(name ? { name } : {}),
    };
}
function ensureActToolSurface(): void {
    if (!extensionApi)
        return;
    const active = extensionApi.getActiveTools();
    const missing = [...ALL_PLAN_TOOL_NAMES].filter((name) => !active.includes(name));
    if (missing.length > 0)
        extensionApi.setActiveTools([...active, ...missing]);
}
function activatePlanToolSurface(): void { }
function restoreActToolSurface(): void { }
function isRecordValue(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPlanTransportResult(value: unknown): value is PlanTransportResult {
    if (!isRecordValue(value) || (value.status !== "decision" && value.status !== "edited" && value.status !== "cancelled"))
        return false;
    if (value.status === "cancelled")
        return true;
    if (value.status === "edited") {
        return typeof value.markdown === "string"
            && typeof value.expectedRevision === "number"
            && Number.isInteger(value.expectedRevision)
            && value.expectedRevision >= 0;
    }
    const decision = value.decision;
    if (!isRecordValue(decision)
        || !["execute", "modify", "continue", "refine", "rollback", "exit-plan", "close"].includes(String(decision.action)))
        return false;
    if (decision.discussion !== undefined && typeof decision.discussion !== "string")
        return false;
    const execution = decision.execution;
    if (execution === undefined)
        return true;
    if (!isRecordValue(execution)
        || (execution.backend !== "standalone" && execution.backend !== "workflow")
        || (execution.context !== "current" && execution.context !== "compact"))
        return false;
    if (execution.sourceDocument !== undefined && typeof execution.sourceDocument !== "string")
        return false;
    return execution.backend === "standalone"
        ? execution.workflowTarget === undefined
        : execution.workflowTarget === "current" || execution.workflowTarget === "new";
}
function openPlanTransport(request: PlanTransportRequest): PlanTransportHandle | undefined {
    for (const transport of getPlanTransports()) {
        try {
            const handle = transport.open(request);
            if (handle)
                return handle;
        }
        catch (error) {
            console.error(`[maestro] Plan transport open failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return undefined;
}
async function racePlanTransport<T>(local: (signal: AbortSignal) => Promise<T>, remote: PlanTransportHandle, signal: AbortSignal): Promise<{
    source: "local";
    value: T;
} | {
    source: "remote";
    result: PlanTransportResult;
}> {
    const localController = new AbortController();
    const localSignal = AbortSignal.any([signal, localController.signal]);
    let localPending = true;
    let remotePending = true;
    const localPromise = local(localSignal).then((value) => ({ source: "local" as const, value }));
    const remotePromise: Promise<{
        source: "remote";
        result: PlanTransportResult;
    } | {
        source: "remote-error";
    }> = remote.promise.then((result): {
        source: "remote";
        result: PlanTransportResult;
    } => ({
        source: "remote",
        result: isPlanTransportResult(result) ? result : { status: "cancelled" },
    }), () => ({ source: "remote-error" as const }));
    while (localPending || remotePending) {
        const candidates: Array<Promise<{
            source: "local";
            value: T;
        } | {
            source: "remote";
            result: PlanTransportResult;
        } | {
            source: "remote-error";
        }>> = [];
        if (localPending)
            candidates.push(localPromise);
        if (remotePending)
            candidates.push(remotePromise);
        const winner = await Promise.race(candidates);
        if (winner.source === "local") {
            localPending = false;
            try {
                await remote.cancel("tui_answered");
            }
            catch { /* transport cleanup is best-effort */ }
            return winner;
        }
        remotePending = false;
        if (winner.source === "remote-error") {
            // A remote transport error only removes that projection. Keep the local
            // TUI alive; a reconnect replays the same request identity.
            continue;
        }
        if (winner.result.status === "cancelled") {
            localController.abort();
            void localPromise.catch(() => undefined);
            return winner;
        }
        localController.abort();
        void localPromise.catch(() => undefined);
        return winner;
    }
    return await localPromise;
}
function transportRequest(ctx: PlanContext, operation: PlanOperationIdentity, kind: PlanTransportRequest["kind"], signal: AbortSignal, options: Omit<PlanTransportRequest, "kind" | "sessionId" | "operationId" | "cwd" | "mode" | "sessionFile" | "markdown" | "revision" | "pathLabel" | "signal">): PlanTransportRequest {
    return {
        kind,
        sessionId: operation.sessionId,
        operationId: operation.operationId,
        cwd: ctx.cwd,
        mode: ctx.mode,
        sessionFile: ctx.sessionManager.getSessionFile(),
        markdown: state.latestPlan ?? "",
        revision: state.latestRevision,
        pathLabel: operation.store?.currentPath ?? "current.md",
        signal,
        ...options,
    };
}
function queuePlanDiscussion(ctx: PlanContext, discussion: string): void {
    const busy = ctx.isIdle?.() === false;
    extensionApi?.sendUserMessage(discussion, busy ? { deliverAs: "followUp" } : undefined);
    if (busy)
        abortPlanTurn(ctx);
}
function abortPlanTurn(ctx: PlanContext): void {
    try {
        ctx.abort?.();
    }
    catch {
        // 关闭确认页不应因宿主中断失败而阻塞。
    }
}
function sendImplementationMessage(ctx: PlanContext, message: string): void {
    if (!extensionApi)
        throw new Error("Plan extension API is not initialized");
    const opts = ctx.isIdle?.() === false
        ? { deliverAs: "followUp" as const }
        : undefined;
    extensionApi.sendUserMessage(message, opts);
}
function configure(pi: ExtensionAPI, options: PlanRuntimeOptions = {}): void {
    extensionApi = pi;
    storeFactory = options.storeFactory ?? ((cwd, session) => new PlanStore(cwd, { session }));
    hasExecutableTodoForHandoff = options.hasExecutableTodo ?? ((handoffKey) => getVisibleTasks().some((task) => task.planHandoffKey === handoffKey
        && (task.status === "pending" || task.status === "in_progress")
        && task.blockedBy.length === 0));
    compactionArbiter = options.compactionArbiter;
    planCompactionHandoffTimeoutMs = Math.max(1, options.compactionHandoffTimeoutMs ?? COMPACTION_LEASE_TIMEOUT_MS);
    schedulePlanNewContext = options.scheduleNewContext;
    restorePlanActModel = options.restoreActModel ?? (async () => true);
    describePlanModelTransition = options.describeModelTransition ?? (() => undefined);
    workflowConfirmation = async (ctx) => options.workflowConfirmation?.(ctx) ?? { allowNew: false };
    publishWorkflowPlan = options.publishWorkflowPlan ?? (async () => {
        throw new Error("Workflow-backed Plan execution is unavailable");
    });
}
return { ensureStore, currentPlanSession, ensureActToolSurface, activatePlanToolSurface, restoreActToolSurface, isRecordValue, isPlanTransportResult, openPlanTransport, racePlanTransport, transportRequest, queuePlanDiscussion, abortPlanTurn, sendImplementationMessage, configure, observeModeChanges(listener: ((ctx: PlanContext) => void) | undefined) { onPlanModeChanged = listener; }, get extensionApi() { return extensionApi; }, get onPlanModeChanged() { return onPlanModeChanged; }, get storeFactory() { return storeFactory; }, get compactionArbiter() { return compactionArbiter; }, get planCompactionHandoffTimeoutMs() { return planCompactionHandoffTimeoutMs; }, get schedulePlanNewContext() { return schedulePlanNewContext; }, get restorePlanActModel() { return restorePlanActModel; }, get describePlanModelTransition() { return describePlanModelTransition; }, get workflowConfirmation() { return workflowConfirmation; }, get publishWorkflowPlan() { return publishWorkflowPlan; }, get hasExecutableTodoForHandoff() { return hasExecutableTodoForHandoff; } };
}
export type PlanHost = ReturnType<typeof createPlanHost>;
