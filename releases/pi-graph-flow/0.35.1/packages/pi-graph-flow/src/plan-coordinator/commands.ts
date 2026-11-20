/** commands responsibility; composed by the existing tools/plan entry. */
import { join } from "node:path";
import { clearPlanAutoTaskContext, beginPlanAutoCycle, endPlanAutoCycle, updatePlanAutoTaskContext, getPlanAutoSnapshot, planAutoStatusLabel } from "../tools/plan-auto.ts";
import { type LoadedPlan } from "../tools/plan-store.ts";
import { openPlanEditor } from "../tools/plan-editor.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { buildPlanDecomposeContract } from "../tools/plan-decompose.ts";
import { PLAN_MODE_TOOL_NAMES } from "./presentation.ts";
import { PLAN_ENTER_TOOL } from "./presentation.ts";
import type { PlanState } from "./state.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "./types.ts";
import type { PlanHost } from "./host.ts";

export function createPlanCommands(state: PlanState, calls: Pick<PlanCalls, "ensureStore" | "bindPlanOperation" | "isCurrentPlanOperation" | "applyLoadedPlan" | "buildPlanEnterNote" | "activatePlanToolSurface" | "syncModeStatus" | "restoreActToolSurface" | "beginPlanOperation" | "buildPlanExitReminder" | "hasPlan" | "reviewPlan" | "result" | "currentDetails" | "supersededResult" | "errorMessage" | "appendApprovalAudit" | "buildPlanExitMessage" | "isPlanMode">, host: PlanHost) {
async function loadCurrentPlanArtifacts(ctx: PlanContext): Promise<LoadedPlanArtifactDocument[]> {
    if (!state.canReadContext(ctx))
        return [];
    const store = await calls.ensureStore(ctx);
    const identity = state.captureRead(ctx, store);
    if (!state.isCurrentRead(ctx, identity))
        return [];
    const entries = await store.listArtifacts();
    const documents = await Promise.all(entries.map(async (entry) => ({ entry, markdown: await store.readArtifact(entry), absolutePath: join(store.plansDir, entry.path) })));
    if (!state.publishArtifactAvailability(ctx, identity, entries.length > 0))
        return [];
    host.onPlanModeChanged?.(ctx);
    return documents;
}
function clearPlan(): void { clearPlanAutoTaskContext(); state.clearPlan(); }
async function enterPlanMode(ctx: PlanContext, operation: PlanOperationIdentity): Promise<boolean> {
    const store = await calls.ensureStore(ctx);
    if (!calls.bindPlanOperation(ctx, operation, store))
        return false;
    const loaded = await store.loadQuick();
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return false;
    calls.applyLoadedPlan(loaded);
    state.enterPlanning(calls.buildPlanEnterNote());
    beginPlanAutoCycle(ctx, { markdown: state.latestPlan ?? "", revision: state.latestRevision });
    calls.activatePlanToolSurface();
    calls.syncModeStatus(ctx);
    host.onPlanModeChanged?.(ctx);
    ctx.ui.notify(`Plan mode · ${store.currentPath}`, "info");
    return true;
}
function exitPlanMode(ctx: PlanContext, approved = false): void {
    if (!approved)
        endPlanAutoCycle();
    state.leavePlanning();
    calls.restoreActToolSurface();
    calls.syncModeStatus(ctx);
}
/** Leave Plan mode without approving or discarding the current draft. */
function exitMode(ctx: PlanContext, operation = calls.beginPlanOperation(ctx)): Mode {
    if (!calls.isCurrentPlanOperation(ctx, operation, false))
        return state.mode;
    if (state.mode === "plan") {
        exitPlanMode(ctx);
        ctx.ui.notify("Act mode · draft preserved", "info");
        state.notePlanExit(calls.buildPlanExitReminder());
        host.onPlanModeChanged?.(ctx);
    }
    return state.mode;
}
async function exitModeAndRestore(ctx: PlanContext, operation = calls.beginPlanOperation(ctx)): Promise<Mode> {
    const wasPlanMode = state.mode === "plan";
    const nextMode = exitMode(ctx, operation);
    if (wasPlanMode && nextMode === "act")
        await host.restorePlanActModel(ctx);
    return nextMode;
}
async function toggleMode(ctx: PlanContext, operation = calls.beginPlanOperation(ctx)): Promise<Mode> {
    if (state.mode === "act") {
        await enterPlanMode(ctx, operation);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return state.mode;
        return state.mode;
    }
    if (calls.hasPlan() && ctx.hasUI !== false) {
        const outcome = await calls.reviewPlan(ctx, true, "message", operation);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return state.mode;
        if (!outcome.approved && !outcome.exited)
            ctx.ui.notify("Staying in Plan mode", "info");
        host.onPlanModeChanged?.(ctx);
        return state.mode;
    }
    return exitModeAndRestore(ctx, operation);
}
async function savePlan(ctx: PlanContext, markdown: string, expectedRevision: number, operation: PlanOperationIdentity): Promise<LoadedPlan | undefined> {
    const store = await calls.ensureStore(ctx);
    if (!calls.bindPlanOperation(ctx, operation, store))
        return undefined;
    const saved = await store.saveDraft(markdown, expectedRevision);
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return undefined;
    calls.applyLoadedPlan(saved);
    if (!saved.markdown.trim())
        clearPlanAutoTaskContext();
    updatePlanAutoTaskContext(ctx, { markdown: saved.markdown, revision: state.latestRevision });
    state.observeSavedArtifact(Boolean(saved.markdown.trim()));
    calls.syncModeStatus(ctx);
    host.onPlanModeChanged?.(ctx);
    return saved;
}
async function editPlan(ctx: PlanContext, pathLabel: string, operation: PlanOperationIdentity, signal?: AbortSignal): Promise<void> {
    await openPlanEditor(ctx, {
        markdown: state.latestPlan ?? "",
        revision: state.latestRevision,
        allowConfirm: false,
        pathLabel,
        signal,
        async onSave(markdown, expectedRevision) {
            if (!calls.isCurrentPlanOperation(ctx, operation))
                throw new Error("Plan operation was superseded");
            const saved = await savePlan(ctx, markdown, expectedRevision, operation);
            if (!calls.isCurrentPlanOperation(ctx, operation) || !saved)
                throw new Error("Plan operation was superseded");
            return saved.manifest.revision;
        },
        async onConfirm() { },
    });
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return;
}
function requirePlanMode(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> | undefined {
    if (state.mode === "plan")
        return;
    return calls.result(`plan-${action} requires Plan mode. Call plan-enter first.`, {
        ...calls.currentDetails(action),
        error: "E_PLAN_MODE_REQUIRED",
    }, true);
}
const executeEnterTool: PlanCalls["executeEnterTool"] = async (_id, _params, _signal, _onUpdate, ctx, onUserAttention) => {
    const operation = calls.beginPlanOperation(ctx);
    if (state.mode !== "plan")
        await enterPlanMode(ctx, operation);
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return calls.supersededResult("enter");
    return calls.result(`Plan mode active. Draft: ${state.currentStore?.currentPath ?? ""}`, calls.currentDetails("enter"));
};
const executeUpdateTool: PlanCalls["executeUpdateTool"] = async (_id, params, _signal, _onUpdate, ctx, onUserAttention) => {
    const operation = calls.beginPlanOperation(ctx);
    const blocked = requirePlanMode("update");
    if (blocked)
        return blocked;
    const expectedRevision = params.expectedRevision ?? state.latestRevision;
    try {
        const saved = await savePlan(ctx, params.markdown, expectedRevision, operation);
        if (!calls.isCurrentPlanOperation(ctx, operation) || !saved)
            return calls.supersededResult("update");
        return calls.result(`Plan draft saved at revision ${saved.manifest.revision}.`, calls.currentDetails("update"));
    }
    catch (error) {
        if (!calls.isCurrentPlanOperation(ctx, operation, operation.store !== undefined))
            return calls.supersededResult("update");
        return calls.result(calls.errorMessage(error), { ...calls.currentDetails("update"), error: calls.errorMessage(error) }, true);
    }
};
const executeReviewTool: PlanCalls["executeReviewTool"] = async (_id, _params, signal, _onUpdate, ctx, onUserAttention) => {
    const operation = calls.beginPlanOperation(ctx);
    const blocked = requirePlanMode("review");
    if (blocked)
        return blocked;
    await calls.reviewPlan(ctx, false, "message", operation, signal, onUserAttention);
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return calls.supersededResult("review");
    return calls.result("Plan review closed; Plan mode remains active.", calls.currentDetails("review"));
};
const executeConfirmTool: PlanCalls["executeConfirmTool"] = async (_id, _params, signal, _onUpdate, ctx, onUserAttention) => {
    const operation = calls.beginPlanOperation(ctx);
    const blocked = requirePlanMode("confirm");
    if (blocked)
        return blocked;
    const snapshot = getPlanAutoSnapshot(ctx);
    const autoGrant = snapshot?.confirmPending ? snapshot : undefined;
    const outcome = await calls.reviewPlan(ctx, true, "tool-result", operation, signal, onUserAttention, autoGrant);
    if (calls.isCurrentPlanOperation(ctx, operation))
        host.onPlanModeChanged?.(ctx);
    if (outcome.canHandoff && !outcome.canHandoff()) {
        outcome.executionMessage = undefined;
        outcome.approvalAudit = { ...outcome.approvalAudit!, result: "committed-handoff-stopped",
            reason: "Approval committed; execution was not started because preauthorization or context changed before tool-result delivery." };
    }
    else if (outcome.approvalAudit?.result === "handoff-ready" && !outcome.compactDeferred) {
        outcome.approvalAudit = { ...outcome.approvalAudit, result: "handed-off" };
    }
    if (outcome.approvalAudit) {
        try {
            calls.appendApprovalAudit(ctx, operation, outcome.approvalAudit);
        }
        catch { /* result retains the outcome */ }
    }
    // The host audit append is synchronous, but may notify lifecycle listeners.
    // No await or host callback remains between this fence and result delivery.
    if (outcome.canHandoff && !outcome.canHandoff() && outcome.executionMessage) {
        outcome.executionMessage = undefined;
        outcome.approvalAudit = { ...outcome.approvalAudit!, result: "committed-handoff-stopped",
            reason: "Approval committed; execution was not started because preauthorization or context changed during audit delivery." };
        try {
            calls.appendApprovalAudit(ctx, operation, outcome.approvalAudit);
        }
        catch { /* result retains the outcome */ }
    }
    if (!calls.isCurrentPlanOperation(ctx, operation) && !outcome.approvalAudit)
        return calls.supersededResult("confirm");
    if (outcome.compactDeferred) {
        try {
            ctx.abort?.();
        }
        catch (error) {
            ctx.ui.notify(`Plan could not stop the current tool batch before compaction: ${calls.errorMessage(error)}`, "warning");
        }
    }
    const summary = outcome.approvalAudit?.result === "committed-handoff-stopped"
        ? `Plan approval is committed and preserved; execution was not started. ${outcome.approvalAudit.reason ?? ""}${autoGrant ? " No automatic retry or recovery handoff will run." : ""}`
        : outcome.approved
            ? outcome.executionChoice?.backend === "workflow" && state.latestWorkflowBinding?.status === "failed"
                ? "Plan approved; Workflow binding failed and execution was not started."
                : outcome.compactDeferred
                    ? `Plan approved; Act mode restored (New Context, ${outcome.executionChoice?.backend ?? "standalone"}). The Plan conversation will be saved as a checkpoint after this turn settles, then execution resumes automatically.`
                    : `Plan approved; Act mode restored (${outcome.executionMode ?? "current"} context, ${outcome.executionChoice?.backend ?? "standalone"}).`
            : outcome.exited
                ? calls.buildPlanExitMessage()
                : outcome.discussionMessage
                    ? "Plan feedback returned; Plan mode remains active."
                    : "Plan not approved; Plan mode remains active.";
    const toolMessage = outcome.executionMessage ?? outcome.discussionMessage;
    const text = toolMessage
        ? `${summary}\n\n${toolMessage}`
        : summary;
    return calls.result(text, {
        ...calls.currentDetails("confirm"),
        ...(outcome.committedPlan ? {
            revision: outcome.committedPlan.manifest.revision,
            status: "approved" as const, sessionId: outcome.committedPlan.manifest.sessionId ?? operation.sessionId,
            path: outcome.committedPlan.currentPath, handoffKey: outcome.committedPlan.manifest.handoffKey,
            execution: outcome.committedPlan.manifest.execution,
        } : {}),
        approved: outcome.approved,
        ...(outcome.approvalAudit ? { approvalAudit: outcome.approvalAudit } : {}),
        ...(!calls.isCurrentPlanOperation(ctx, operation) ? { error: "E_PLAN_OPERATION_SUPERSEDED" } : {}),
    }, !calls.isCurrentPlanOperation(ctx, operation), outcome.compactDeferred === true);
};
const executeDecomposeTool: PlanCalls["executeDecomposeTool"] = async (_id, params, _signal, _onUpdate, ctx, onUserAttention) => {
    const operation = calls.beginPlanOperation(ctx);
    if (state.mode !== "act") {
        return calls.result("plan-decompose requires Act mode after Plan approval.", {
            ...calls.currentDetails("decompose"),
            error: "E_PLAN_ACT_MODE_REQUIRED",
        }, true);
    }
    try {
        const store = await calls.ensureStore(ctx);
        if (!calls.bindPlanOperation(ctx, operation, store))
            return calls.supersededResult("decompose");
        const loaded = await store.loadApprovedSnapshotReadOnly();
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return calls.supersededResult("decompose");
        const manifest = loaded.manifest;
        if (manifest.status !== "approved"
            || !manifest.handoffKey
            || !manifest.approvedPath
            || !manifest.approvedChecksum) {
            return calls.result("plan-decompose requires a currently approved Plan with complete approval identity.", {
                ...calls.currentDetails("decompose"),
                error: "E_PLAN_APPROVAL_REQUIRED",
            }, true);
        }
        if (params.planHandoffKey !== manifest.handoffKey) {
            return calls.result("plan-decompose requires the exact handoff key of the currently approved Plan.", {
                ...calls.currentDetails("decompose"),
                error: "E_PLAN_HANDOFF_KEY_MISMATCH",
            }, true);
        }
        const contract = buildPlanDecomposeContract({
            planHandoffKey: params.planHandoffKey,
            approvedPlanPath: loaded.approvedPath,
            approvedChecksum: manifest.approvedChecksum,
        });
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return calls.supersededResult("decompose");
        return calls.result(contract, calls.currentDetails("decompose"));
    }
    catch (error) {
        if (!calls.isCurrentPlanOperation(ctx, operation, operation.store !== undefined))
            return calls.supersededResult("decompose");
        if (calls.errorMessage(error) === "Plan has no complete approved snapshot") {
            return calls.result("plan-decompose requires a currently approved Plan with complete approval identity.", {
                ...calls.currentDetails("decompose"),
                error: "E_PLAN_APPROVAL_REQUIRED",
            }, true);
        }
        return calls.result(calls.errorMessage(error), {
            ...calls.currentDetails("decompose"),
            error: "E_PLAN_DECOMPOSE_INVALID",
        }, true);
    }
};
const executeExitTool: PlanCalls["executeExitTool"] = async (_id, _params, _signal, _onUpdate, ctx, onUserAttention) => {
    const operation = calls.beginPlanOperation(ctx);
    const blocked = requirePlanMode("exit");
    if (blocked)
        return blocked;
    await exitModeAndRestore(ctx, operation);
    return calls.result(calls.buildPlanExitMessage(), calls.currentDetails("exit"));
};
const executeStatusTool: PlanCalls["executeStatusTool"] = async (_id, _params, _signal, _onUpdate, ctx, onUserAttention) => {
    calls.beginPlanOperation(ctx);
    const blocked = requirePlanMode("status");
    if (blocked)
        return blocked;
    const snapshot = getPlanAutoSnapshot(ctx);
    const details = { ...calls.currentDetails("status"), planAuto: {
            enabled: !!snapshot,
            ...(snapshot ? { generation: snapshot.generation, confirmPending: snapshot.confirmPending } : {}),
        } };
    return calls.result(`${details.mode} · ${details.status} · r${details.revision} · ${details.sessionId} · ${details.path} · ${planAutoStatusLabel(ctx)}`, details);
};
async function executePlanCommand(args: string, ctx: PlanContext): Promise<void> {
    const operation = calls.beginPlanOperation(ctx);
    const trimmed = args.trim();
    const command = trimmed.toLowerCase();
    if (command === "exit" || command === "off") {
        if (calls.isPlanMode()) {
            await exitModeAndRestore(ctx, operation);
        }
        else if (calls.isCurrentPlanOperation(ctx, operation, false)) {
            ctx.ui.notify("Act mode · draft preserved", "info");
        }
        return;
    }
    if (command === "show") {
        if (!calls.isPlanMode()) {
            await enterPlanMode(ctx, operation);
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return;
        }
        await calls.reviewPlan(ctx, false, "message", operation);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        return;
    }
    if (command === "approve") {
        if (!calls.isPlanMode()) {
            await enterPlanMode(ctx, operation);
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return;
        }
        if (!calls.hasPlan()) {
            ctx.ui.notify("No Plan draft to approve.", "warning");
            return;
        }
        await calls.reviewPlan(ctx, true, "message", operation);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        host.onPlanModeChanged?.(ctx);
        return;
    }
    if (command === "clear") {
        if (!calls.isPlanMode()) {
            await enterPlanMode(ctx, operation);
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return;
        }
        const saved = await savePlan(ctx, "", state.latestRevision, operation);
        if (!calls.isCurrentPlanOperation(ctx, operation) || !saved)
            return;
        ctx.ui.notify("Plan draft cleared.", "info");
        return;
    }
    if (command === "tools") {
        if (calls.isCurrentPlanOperation(ctx, operation, operation.store !== undefined)) {
            ctx.ui.notify(calls.isPlanMode() ? PLAN_MODE_TOOL_NAMES.join(", ") : PLAN_ENTER_TOOL, "info");
        }
        return;
    }
    if (trimmed) {
        if (!calls.isPlanMode()) {
            await enterPlanMode(ctx, operation);
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return;
        }
        if (ctx.isIdle?.() === false) {
            ctx.ui.notify("Plan mode active. Planning prompt was not queued because the agent is still busy.", "warning");
            return;
        }
        host.extensionApi?.sendUserMessage(trimmed);
        return;
    }
    await toggleMode(ctx, operation);
    if (!calls.isCurrentPlanOperation(ctx, operation, operation.store !== undefined))
        return;
}
return { loadCurrentPlanArtifacts, clearPlan, enterPlanMode, exitPlanMode, exitMode, exitModeAndRestore, toggleMode, savePlan, editPlan, requirePlanMode, executeEnterTool, executeUpdateTool, executeReviewTool, executeConfirmTool, executeDecomposeTool, executeExitTool, executeStatusTool, executePlanCommand };
}
