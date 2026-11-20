/** lifecycle responsibility; composed by the existing tools/plan entry. */
import { prewarmProcessIdentity } from "../tools/plan-store.ts";
import { resetPlanAuto, updatePlanAutoTaskContext } from "../tools/plan-auto.ts";
import { STATUS_KEY } from "./presentation.ts";
import { PLAN_MODE_REMINDER_TYPE } from "./presentation.ts";
import type { PlanState } from "./state.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "./types.ts";
import type { PlanHost } from "./host.ts";
export const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
export function createPlanLifecycle(state: PlanState, calls: Pick<PlanCalls, "restoreActToolSurface" | "beginPlanOperation" | "ensureActToolSurface" | "syncModeStatus" | "ensureStore" | "bindPlanOperation" | "isCurrentPlanOperation" | "applyLoadedPlan" | "recoverWorkflowBinding" | "clearPlan" | "errorMessage">, host: PlanHost) {
async function onSessionStartPlan(ctx: PlanContext): Promise<void> {
    calls.restoreActToolSurface();
    resetRuntimeState();
    const operation = calls.beginPlanOperation(ctx);
    const artifactEpoch = state.artifactReadEpoch;
    calls.ensureActToolSurface();
    calls.syncModeStatus(ctx);
    prewarmProcessIdentity();
    try {
        const store = await calls.ensureStore(ctx);
        if (!calls.bindPlanOperation(ctx, operation, store))
            return;
        const loaded = await store.load();
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        calls.applyLoadedPlan(loaded);
        const artifactIdentity = state.captureRead(ctx, store);
        const artifactAvailable = await store.hasArtifacts();
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        state.publishArtifactAvailability(ctx, artifactIdentity, artifactAvailable);
        if (loaded.manifest.status === "approved"
            && loaded.manifest.execution?.backend === "workflow"
            && (loaded.manifest.workflowBinding?.status !== "bound"
                || loaded.manifest.workflowBinding.deliveryStatus === "pending")) {
            await calls.recoverWorkflowBinding(ctx, store, loaded, operation);
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return;
        }
        if (calls.isCurrentPlanOperation(ctx, operation))
            state.openArtifactReads(ctx, artifactIdentity, artifactEpoch);
    }
    catch (error) {
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        state.releaseFailedStore();
        calls.clearPlan();
        ctx.ui.notify(`Plan draft unavailable: ${calls.errorMessage(error)}`, "warning");
    }
}
function onSessionShutdownPlan(ctx: PlanContext): void {
    calls.restoreActToolSurface();
    resetRuntimeState();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setStatus("maestro-plan-auto", undefined);
}
function resetRuntimeState(): void { resetPlanAuto("plan-runtime-reset"); state.resetRuntimeState(); }
function onBeforeAgentStartPlan(_event: {
    systemPrompt: string;
}): {
    message: {
        customType: string;
        content: string;
        display: boolean;
    };
} | undefined {
    if (state.pendingPlanEnterNote) {
        const note = state.pendingPlanEnterNote;
        state.consumeEnterNote();
        return {
            message: {
                customType: PLAN_MODE_REMINDER_TYPE,
                content: note,
                display: false,
            },
        };
    }
    if (!state.pendingPlanExitReminder)
        return;
    const reminder = state.pendingPlanExitReminder;
    state.consumeExitReminder();
    return {
        message: {
            customType: PLAN_MODE_REMINDER_TYPE,
            content: reminder,
            display: false,
        },
    };
}
function onToolCallPlan(event: {
    toolName: string;
    input: Record<string, unknown>;
}, _bypassHandoff = false): {
    block: true;
    reason: string;
} | undefined {
    if (state.mode !== "plan")
        return undefined;
    // Plan mode blocks only the built-in file-editing tools. Everything else —
    // bash, run-control, todo, teammate, MCP, unknown tools — stays available.
    // A lexical mutation scanner is an incomplete guard anyway, and a long
    // blocklist false-blocks read-only tools (e.g. mcp search); the plan-mode
    // prompt carries the read-only planning convention instead.
    if (["edit", "write", "notebookedit", "notebook_edit"].includes(event.toolName.toLowerCase())) {
        return planMutationBlock(event.toolName);
    }
    return undefined;
}
function planMutationBlock(operation: string, detail?: string): {
    block: true;
    reason: string;
} {
    return {
        block: true,
        reason: `Plan mode is read-only before approval; ${operation} is blocked${detail ? ` (${detail})` : ""}. Approve or exit the Plan first.`,
    };
}
async function onAgentEndPlan(event: {
    messages: unknown[];
}, ctx: PlanContext): Promise<void> {
    if (state.mode !== "plan" || state.latestStatus === "approved")
        return;
    const proposedPlan = extractProposedPlan(latestAssistantText(event.messages));
    if (!proposedPlan)
        return;
    const operation = calls.beginPlanOperation(ctx);
    try {
        const store = await calls.ensureStore(ctx);
        if (!calls.bindPlanOperation(ctx, operation, store))
            return;
        const saved = await store.saveDraft(proposedPlan, state.latestRevision);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        calls.applyLoadedPlan(saved);
        updatePlanAutoTaskContext(ctx, { markdown: saved.markdown, revision: state.latestRevision });
        state.observeSavedArtifact(Boolean(saved.markdown.trim()));
        calls.syncModeStatus(ctx);
        host.onPlanModeChanged?.(ctx);
        ctx.ui.notify("Compatibility plan captured to current.md. Use plan-review or plan-confirm.", "info");
    }
    catch (error) {
        if (!calls.isCurrentPlanOperation(ctx, operation, operation.store !== undefined))
            return;
        ctx.ui.notify(`Plan compatibility capture failed: ${calls.errorMessage(error)}`, "warning");
    }
}
function extractProposedPlan(text: string): string | undefined {
    return PROPOSED_PLAN_PATTERN.exec(text)?.[1]?.trim() || undefined;
}
function latestAssistantText(messages: unknown): string {
    if (!Array.isArray(messages))
        return "";
    for (let index = messages.length - 1; index >= 0; index--) {
        const entry = messages[index] as Record<string, unknown>;
        const message = (entry?.message as Record<string, unknown>) ?? entry;
        if (message?.role !== "assistant")
            continue;
        const text = contentText(message.content);
        if (text)
            return text;
    }
    return "";
}
function contentText(content: unknown): string {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.map((block) => {
        const value = block as {
            type?: string;
            text?: string;
        };
        return value.type === "text" && typeof value.text === "string" ? value.text : "";
    }).filter(Boolean).join("\n");
}
return { onSessionStartPlan, onSessionShutdownPlan, resetRuntimeState, onBeforeAgentStartPlan, onToolCallPlan, planMutationBlock, onAgentEndPlan, extractProposedPlan, latestAssistantText, contentText };
}
