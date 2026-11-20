/** handoff responsibility; composed by the existing tools/plan entry. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type PlanExecutionChoice } from "../tools/plan-store.ts";
import type { PlanState } from "./state.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "./types.ts";
import type { PlanHost } from "./host.ts";
export const PLAN_CLEAN_CONTEXT_COMPACTION_MARKER = "[maestro-plan-clean-context]";
export function createPlanHandoff(state: PlanState, calls: Pick<PlanCalls, "syncModeStatus" | "planOperationMatchesContext" | "isCurrentPlanOperation" | "errorMessage" | "beginPlanHandoff" | "sendImplementationMessage" | "isCurrentPlanHandoff" | "finishPlanHandoff">, host: PlanHost) {
/** True only when the clean-context marker is the leading instruction token. */
function isPlanCleanContextCompactionInstructions(customInstructions: string | undefined): boolean {
    return customInstructions?.trimStart().startsWith(PLAN_CLEAN_CONTEXT_COMPACTION_MARKER) === true;
}
function onCompactPlan(ctx: PlanContext): void {
    state.clearContextReplacement();
    calls.syncModeStatus(ctx);
    const handoff = state.pendingPlanCompactHandoff;
    if (!handoff?.waitingForCompactionSettlement
        || !calls.planOperationMatchesContext(ctx, handoff.operation)
        || !calls.isCurrentPlanOperation(ctx, handoff.operation))
        return;
    // session_compact is emitted while the host still owns its compaction
    // controller. Defer one macrotask so the host can clear that controller
    // before the void sendUserMessage call below.
    if (state.hasSettlementTimer)
        return;
    state.scheduleCompactionSettlement(() => {
        const current = state.pendingPlanCompactHandoff;
        if (!current || current !== handoff
            || !current.waitingForCompactionSettlement
            || !calls.planOperationMatchesContext(ctx, current.operation)
            || !calls.isCurrentPlanOperation(ctx, current.operation))
            return;
        state.observeCompactionSettled(current);
        state.releasePendingHandoff();
        deliverPlanHandoff(ctx, current);
    });
}
function onContextPlan(messages: AgentMessage[]): {
    messages: AgentMessage[];
} | undefined {
    const manifest = state.planContextReplacement;
    if (!manifest)
        return undefined;
    if (manifest.lifecycleGeneration !== state.planLifecycleGeneration) {
        state.clearContextReplacement();
        return undefined;
    }
    const serialized = messages.map((message) => JSON.stringify(message));
    if (!manifest.baselineMessages) {
        state.captureContextBaseline(serialized);
        return { messages: [manifest.replacement] };
    }
    const baselineMatches = manifest.baselineMessages.length <= serialized.length
        && manifest.baselineMessages.every((message, index) => message === serialized[index]);
    if (!baselineMatches) {
        // Preserve the newest unmatched user turn while rebasing the dropped prefix.
        // This avoids resurrecting rewritten history without hiding the request that
        // caused a branch or host-prefix change.
        let suffixStart = -1;
        for (let index = messages.length - 1; index >= 0; index--) {
            if (messages[index]?.role !== "user")
                continue;
            if (index >= manifest.baselineMessages.length || serialized[index] !== manifest.baselineMessages[index]) {
                suffixStart = index;
                break;
            }
        }
        if (suffixStart < 0)
            suffixStart = messages.length;
        state.captureContextBaseline(serialized.slice(0, suffixStart));
        return { messages: [manifest.replacement, ...messages.slice(suffixStart)] };
    }
    return {
        messages: [manifest.replacement, ...messages.slice(manifest.baselineMessages.length)],
    };
}
function projectPlanContextForCompaction(messages: AgentMessage[]): {
    messages: AgentMessage[];
    firstKeptEntryId: string;
} | undefined {
    const manifest = state.planContextReplacement;
    const projected = onContextPlan(messages);
    if (!manifest || !projected || manifest.lifecycleGeneration !== state.planLifecycleGeneration)
        return undefined;
    return {
        messages: projected.messages,
        firstKeptEntryId: `maestro-plan-replacement-${manifest.lifecycleGeneration}`,
    };
}
function consumePlanCleanContextCompaction(): PlanCleanContextCompactionRequest | undefined { return state.consumeCleanContext(); }
function applyPlanContextToCompaction(preparation: {
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    firstKeptEntryId: string;
    previousSummary?: string;
}, branchMessages: AgentMessage[]): boolean {
    const projected = projectPlanContextForCompaction(branchMessages);
    if (!projected)
        return false;
    preparation.messagesToSummarize = projected.messages;
    preparation.turnPrefixMessages = [];
    preparation.firstKeptEntryId = projected.firstKeptEntryId;
    preparation.previousSummary = undefined;
    return true;
}
function activatePlanContextReplacement(summary: string): void {
    const text = [
        "The conversation history before this point was intentionally reset after explicit user approval.",
        "",
        "<summary>",
        summary,
        "</summary>",
    ].join("\n");
    state.replaceContext({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    } as AgentMessage);
}
function canReplaceContextAfterCompactionFailure(error: unknown): boolean {
    const message = calls.errorMessage(error);
    return message.includes("Nothing to compact") || message.includes("Already compacted");
}
async function deliverImplementation(ctx: PlanContext, planPath: string, markdown: string, executionMode: PlanExecutionChoice["context"], executionMessage: string, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, onDelivered?: () => Promise<void>): Promise<string | undefined> {
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return undefined;
    if (executionMode === "compact") {
        const handoff: PlanCompactHandoff = {
            request: calls.beginPlanHandoff(),
            operation,
            planPath,
            markdown,
            executionMessage,
            ...(onDelivered ? { onDelivered } : {}),
        };
        if (handoffDelivery === "tool-result") {
            state.queueCompactHandoff(handoff);
            ctx.ui.notify("Plan compaction queued for the end of the current turn…", "info");
            return undefined;
        }
        startPlanCompaction(ctx, handoff);
        return undefined;
    }
    if (handoffDelivery === "tool-result") {
        await onDelivered?.();
        return calls.isCurrentPlanOperation(ctx, operation) ? executionMessage : undefined;
    }
    calls.sendImplementationMessage(ctx, executionMessage);
    await onDelivered?.();
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return undefined;
}
function hasPendingPlanCompactHandoff(ctx: PlanContext): boolean {
    const handoff = state.pendingPlanCompactHandoff ?? state.activePlanCompactHandoff;
    return Boolean(handoff
        && calls.planOperationMatchesContext(ctx, handoff.operation)
        && calls.isCurrentPlanOperation(ctx, handoff.operation));
}
function onAgentSettledPlan(ctx: PlanContext): void {
    // A compaction handoff already owns the current host boundary. A second
    // settlement must not start a duplicate compaction or execution message.
    if (state.activePlanCompactHandoff && calls.planOperationMatchesContext(ctx, state.activePlanCompactHandoff.operation)) {
        if (calls.isCurrentPlanOperation(ctx, state.activePlanCompactHandoff.operation))
            return;
        const stale = state.activePlanCompactHandoff;
        state.releaseActiveHandoff();
        if (calls.isCurrentPlanHandoff(stale.request))
            calls.finishPlanHandoff(stale.request);
    }
    const handoff = state.pendingPlanCompactHandoff;
    if (!handoff || !calls.planOperationMatchesContext(ctx, handoff.operation))
        return;
    if (!calls.isCurrentPlanOperation(ctx, handoff.operation)) {
        state.releasePendingHandoff();
        calls.finishPlanHandoff(handoff.request);
        return;
    }
    if (handoff.waitingForCompactionSettlement) {
        // The host's next settled boundary is the first point at which a denied
        // compaction can safely fall back to the current context. Keep waiting if
        // an owner/tombstone still proves that compaction is unresolved.
        if (host.compactionArbiter?.currentOwner() || host.compactionArbiter?.timeoutTombstone())
            return;
        state.observeCompactionSettled(handoff);
        state.releasePendingHandoff();
        deliverPlanHandoff(ctx, handoff);
        return;
    }
    startPlanCompaction(ctx, handoff);
}
/** Queue an approved Plan message only at a host boundary known to be safe. */
function deliverPlanHandoff(ctx: PlanContext, handoff: PlanCompactHandoff): boolean {
    if (!calls.isCurrentPlanOperation(ctx, handoff.operation) || !calls.isCurrentPlanHandoff(handoff.request))
        return false;
    try {
        calls.sendImplementationMessage(ctx, handoff.executionMessage);
    }
    catch (error) {
        // A synchronous rejection is not an acceptance signal. Preserve the
        // request so a later settled boundary can retry it.
        state.waitForCompaction(handoff);
        if (state.activePlanCompactHandoff === handoff)
            state.releaseActiveHandoff();
        state.queueCompactHandoff(handoff);
        ctx.ui.notify(`Plan execution handoff could not be queued: ${calls.errorMessage(error)}`, "error");
        return false;
    }
    if (!calls.finishPlanHandoff(handoff.request))
        return false;
    void handoff.onDelivered?.();
    return true;
}
function startPlanCompaction(ctx: PlanContext, handoff: PlanCompactHandoff): void {
    const { request, operation, planPath, markdown, executionMessage } = handoff;
    if (host.schedulePlanNewContext) {
        if (state.pendingPlanCompactHandoff === handoff)
            state.releasePendingHandoff();
        state.activateCompactHandoff(handoff);
        try {
            const receipt = host.schedulePlanNewContext(ctx, {
                executionMessage,
                plan: {
                    status: "approved",
                    revision: state.latestRevision,
                    path: planPath,
                    ...(state.latestHandoffKey ? { handoffKey: state.latestHandoffKey } : {}),
                    ...(state.latestApprovedChecksum ? { checksum: state.latestApprovedChecksum } : {}),
                    markdown,
                },
                continueAfterReset: () => deliverPlanHandoff(ctx, handoff),
                onCancelled(reason) {
                    if (state.activePlanCompactHandoff === handoff)
                        state.releaseActiveHandoff();
                    if (!calls.isCurrentPlanOperation(ctx, operation) || !calls.isCurrentPlanHandoff(request))
                        return;
                    calls.finishPlanHandoff(request);
                    ctx.ui.notify(`Plan New Context handoff was cancelled; execution was not started: ${reason}`, "warning");
                },
            });
            ctx.ui.notify(receipt.coalesced
                ? `Plan execution joined New Context request ${receipt.requestId}; the Plan conversation will be checkpointed before execution.`
                : `Plan New Context request ${receipt.requestId} scheduled; the Plan conversation will be checkpointed before execution.`, "info");
        }
        catch (error) {
            if (state.activePlanCompactHandoff === handoff)
                state.releaseActiveHandoff();
            if (calls.isCurrentPlanOperation(ctx, operation) && calls.isCurrentPlanHandoff(request)) {
                ctx.ui.notify(`Plan New Context could not be scheduled; executing with the current context: ${calls.errorMessage(error)}`, "warning");
                deliverPlanHandoff(ctx, handoff);
            }
        }
        return;
    }
    const lease = host.compactionArbiter?.request("plan-handoff", {
        owner: "plan-handoff",
        reason: "preserve-approved-plan",
    });
    if (host.compactionArbiter && !lease) {
        // Never consume the handoff while another compaction (or its timeout
        // tombstone) may still own the host controller. The next authoritative
        // settlement retries the current-context delivery exactly once.
        const firstDeferral = !handoff.waitingForCompactionSettlement;
        state.waitForCompaction(handoff);
        state.queueCompactHandoff(handoff);
        if (firstDeferral) {
            ctx.ui.notify("Compaction is already in progress; Plan execution is deferred until it settles.", "warning");
        }
        return;
    }
    // Request ownership is now established; only this transition may consume a
    // pending handoff and expose the active compaction to settlement guards.
    if (state.pendingPlanCompactHandoff === handoff)
        state.releasePendingHandoff();
    state.activateCompactHandoff(handoff);
    let delivered = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const deliver = (releaseLease = true) => {
        if (delivered)
            return false;
        delivered = true;
        if (watchdog)
            clearTimeout(watchdog);
        if (releaseLease)
            lease?.release();
        if (!calls.isCurrentPlanOperation(ctx, operation) || !calls.isCurrentPlanHandoff(request)) {
            if (state.activePlanCompactHandoff === handoff)
                state.releaseActiveHandoff();
            if (calls.isCurrentPlanHandoff(request))
                calls.finishPlanHandoff(request);
            return false;
        }
        const queued = deliverPlanHandoff(ctx, handoff);
        if (!queued)
            delivered = false;
        return queued;
    };
    const compactionInstructions = [
        "Treat the following approved Plan as the authoritative execution contract.",
        `Preserve its source path, locked boundaries, risks, acceptance checks, and current execution position: ${planPath}`,
        "",
        markdown,
    ].join("\n");
    ctx.ui.notify("Compacting context with the approved Plan preserved…", "info");
    watchdog = setTimeout(() => {
        if (calls.isCurrentPlanOperation(ctx, operation) && calls.isCurrentPlanHandoff(request)) {
            // Wall-clock expiry does not prove that the host compaction stopped. Keep
            // the handoff and wait for onComplete/onError, both invoked after the
            // host clears its compaction controller.
            ctx.ui.notify("Plan compaction did not finish in time; waiting for the host to settle before execution.", "warning");
        }
    }, host.planCompactionHandoffTimeoutMs);
    watchdog.unref?.();
    try {
        ctx.compact({
            customInstructions: lease?.tagInstructions(compactionInstructions) ?? compactionInstructions,
            onComplete() {
                deliver();
            },
            onError(error) {
                if (calls.isCurrentPlanOperation(ctx, operation) && calls.isCurrentPlanHandoff(request)) {
                    ctx.ui.notify(`Compaction failed; executing with the current context: ${error.message}`, "warning");
                }
                deliver();
            },
        });
    }
    catch (error) {
        if (calls.isCurrentPlanOperation(ctx, operation) && calls.isCurrentPlanHandoff(request)) {
            ctx.ui.notify(`Compaction failed; executing with the current context: ${calls.errorMessage(error)}`, "warning");
        }
        deliver();
    }
}
return { isPlanCleanContextCompactionInstructions, onCompactPlan, onContextPlan, projectPlanContextForCompaction, consumePlanCleanContextCompaction, applyPlanContextToCompaction, activatePlanContextReplacement, canReplaceContextAfterCompactionFailure, deliverImplementation, hasPendingPlanCompactHandoff, onAgentSettledPlan, deliverPlanHandoff, startPlanCompaction };
}
