/** review responsibility; composed by the existing tools/plan entry. */
import type { UserAttentionHandler } from "../notify/user-attention.ts";
import { type PlanAutoGrantSnapshot, updatePlanAutoTaskContext } from "../tools/plan-auto.ts";
import { detectDecisionDocuments } from "../tools/plan-sources.ts";
import { openPlanConfirmation } from "../tools/plan-confirm.ts";
import { type RefineRole, openRefinePanel, REFINE_ROLES } from "../tools/plan-refine.ts";
import { type LoadedPlan } from "../tools/plan-store.ts";
import { renderRollbackOverlay } from "../tui/plan-rollback-overlay.ts";
import type { PlanState } from "./state.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "./types.ts";
import type { PlanHost } from "./host.ts";

export function createPlanReview(state: PlanState, calls: Pick<PlanCalls, "ensureStore" | "bindPlanOperation" | "approveAndImplement" | "isCurrentPlanOperation" | "enterPlanMode" | "openPlanTransport" | "transportRequest" | "racePlanTransport" | "editPlan" | "savePlan" | "applyLoadedPlan" | "syncModeStatus" | "errorMessage" | "abortPlanTurn" | "exitModeAndRestore" | "queuePlanDiscussion">, host: PlanHost) {
async function reviewPlan(ctx: PlanContext, allowConfirm: boolean, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, signal?: AbortSignal, onUserAttention?: UserAttentionHandler, autoGrant?: PlanAutoGrantSnapshot): Promise<PlanReviewOutcome> {
    signal = signal && ctx.signal ? AbortSignal.any([signal, ctx.signal])
        : signal ?? ctx.signal ?? new AbortController().signal;
    if (autoGrant) {
        const store = await calls.ensureStore(ctx);
        if (!calls.bindPlanOperation(ctx, operation, store))
            return { approved: false, exited: false };
        return calls.approveAndImplement(ctx, store, { backend: "standalone", context: "current" }, handoffDelivery, operation, signal, autoGrant);
    }
    if (signal.aborted)
        return { approved: false, exited: false };
    if (!ctx.hasUI) {
        if (calls.isCurrentPlanOperation(ctx, operation, false)) {
            ctx.ui.notify("Plan review requires an interactive UI.", "warning");
        }
        return { approved: false, exited: false };
    }
    const store = await calls.ensureStore(ctx);
    if (!calls.bindPlanOperation(ctx, operation, store))
        return { approved: false, exited: false };
    if (state.mode !== "plan") {
        await calls.enterPlanMode(ctx, operation);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return { approved: false, exited: false };
    }
    if (!allowConfirm) {
        onUserAttention?.({
            id: `plan-review:${operation.sessionId}:${operation.operationId}`,
            kind: "plan-review",
        }, ctx);
        const remote = calls.openPlanTransport(calls.transportRequest(ctx, operation, "review", signal, {
            availableActions: [],
            decisionDocuments: [],
            drafts: [],
        }));
        if (remote) {
            const raced = await calls.racePlanTransport((localSignal) => calls.editPlan(ctx, store.currentPath, operation, localSignal).then(() => undefined), remote, signal);
            if (raced.source === "remote") {
                if (raced.result.status === "edited") {
                    await calls.savePlan(ctx, raced.result.markdown, raced.result.expectedRevision, operation);
                }
                return { approved: false, exited: false };
            }
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return { approved: false, exited: false };
            return { approved: false, exited: false };
        }
        await calls.editPlan(ctx, store.currentPath, operation, signal);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return { approved: false, exited: false };
        return { approved: false, exited: false };
    }
    let attentionIndex = 0;
    while (calls.isCurrentPlanOperation(ctx, operation)) {
        const workflow = await host.workflowConfirmation(ctx);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return { approved: false, exited: false };
        let drafts: {
            revision: number;
            archivedAt: string;
            checksum: string;
        }[];
        try {
            drafts = (await store.listDrafts()).map((entry) => ({
                revision: entry.revision,
                archivedAt: entry.archivedAt,
                checksum: entry.checksum,
            }));
        }
        catch {
            drafts = [];
        }
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return { approved: false, exited: false };
        onUserAttention?.({
            id: `plan-confirm:${operation.sessionId}:${operation.operationId}:${++attentionIndex}`,
            kind: "plan-confirm",
        }, ctx);
        const decisionDocuments = await detectDecisionDocuments(state.latestPlan ?? "", ctx.cwd).catch(() => []);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return { approved: false, exited: false };
        const remote = calls.openPlanTransport(calls.transportRequest(ctx, operation, "confirm", signal, {
            availableActions: [
                "execute",
                "modify",
                "refine",
                ...(drafts.length > 0 ? ["rollback" as const] : []),
                "continue",
                "exit-plan",
            ],
            defaultExecution: state.latestExecution,
            workflow,
            modelTransition: host.describePlanModelTransition(ctx),
            decisionDocuments,
            drafts,
        }));
        let decision: Awaited<ReturnType<typeof openPlanConfirmation>>;
        if (remote) {
            const raced = await calls.racePlanTransport((localSignal) => openPlanConfirmation(ctx, {
                markdown: state.latestPlan ?? "",
                pathLabel: store.currentPath,
                canCompactContext: true,
                contextPercent: ctx.getContextUsage?.()?.percent ?? undefined,
                defaultExecution: state.latestExecution,
                workflow,
                modelTransition: host.describePlanModelTransition(ctx),
                decisionDocuments,
                drafts,
                signal: localSignal,
            }), remote, signal);
            if (raced.source === "remote") {
                if (raced.result.status === "edited") {
                    await calls.savePlan(ctx, raced.result.markdown, raced.result.expectedRevision, operation);
                    continue;
                }
                if (raced.result.status === "cancelled")
                    return { approved: false, exited: false };
                decision = raced.result.decision;
            }
            else {
                decision = raced.value;
            }
        }
        else {
            decision = await openPlanConfirmation(ctx, {
                markdown: state.latestPlan ?? "",
                pathLabel: store.currentPath,
                canCompactContext: true,
                contextPercent: ctx.getContextUsage?.()?.percent ?? undefined,
                defaultExecution: state.latestExecution,
                workflow,
                modelTransition: host.describePlanModelTransition(ctx),
                decisionDocuments,
                drafts,
                signal,
            });
        }
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return { approved: false, exited: false };
        const action = decision.action;
        if (action === "modify") {
            state.resetRefinement(-1);
            await calls.editPlan(ctx, store.currentPath, operation, signal);
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return { approved: false, exited: false };
            continue;
        }
        if (action === "refine") {
            if (!host.extensionApi) {
                ctx.ui.notify("Review & Refine is unavailable: extension API is not initialized.", "warning");
                continue;
            }
            if (state.refineSessionRevision !== state.latestRevision) {
                state.resetRefinement(state.latestRevision);
            }
            const initialRole: RefineRole = state.refineSession?.currentRole ?? "reviewer";
            const reviewedRevision = state.latestRevision;
            const outcome = await openRefinePanel(host.extensionApi, ctx, {
                markdown: state.latestPlan ?? "",
                revision: reviewedRevision,
                initialRole,
                session: state.refineSession,
                signal,
                async onOutput(turn) {
                    await store.saveReviewArtifact({
                        revision: reviewedRevision,
                        role: turn.role,
                        markdown: turn.output,
                        createdAt: turn.createdAt,
                    });
                    if (!calls.isCurrentPlanOperation(ctx, operation))
                        return;
                    state.observeSavedArtifact(true);
                    host.onPlanModeChanged?.(ctx);
                },
            });
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return { approved: false, exited: false };
            state.acceptRefinement(outcome, state.latestRevision, outcome.latestRole ? REFINE_ROLES[outcome.latestRole].label : undefined);
            if (outcome.action === "apply") {
                const output = state.refineSessionRevision === state.latestRevision ? state.refineLatestOutput : undefined;
                if (!output) {
                    ctx.ui.notify("No refine result is available to apply; run review/refine first.", "warning");
                    continue;
                }
                if (state.refineLatestAppliesAs === "draft") {
                    // Optimizer-style roles return a full draft: write it directly as the new current.md.
                    let saved: LoadedPlan | undefined;
                    try {
                        saved = await calls.savePlan(ctx, output, state.latestRevision, operation);
                    }
                    catch (error) {
                        ctx.ui.notify(`Failed to save refined plan: ${error instanceof Error ? error.message : String(error)}`, "warning");
                    }
                    if (!calls.isCurrentPlanOperation(ctx, operation))
                        return { approved: false, exited: false };
                    if (saved) {
                        // Only a committed PlanStore write may report the business terminal.
                        try {
                            await outcome.finalize?.({
                                action: "apply",
                                turnId: outcome.session.turns.at(-1)?.turnId,
                                terminal: "applied",
                            });
                        }
                        catch (error) {
                            console.error(`[maestro] Failed to finalize applied refine: ${error instanceof Error ? error.message : String(error)}`);
                        }
                        if (!calls.isCurrentPlanOperation(ctx, operation))
                            return { approved: false, exited: false };
                        state.resetRefinement();
                        ctx.ui.notify("Refine result applied to the Plan draft.", "info");
                    }
                    else {
                        await outcome.finalize?.({
                            action: "apply",
                            terminal: "failed",
                        });
                    }
                    continue;
                }
                // Reviewer/decomposer/brainstormer output continues the Plan discussion.
                const feedback = buildRefineFeedbackMessage(output, state.refineLatestRoleLabel);
                state.discardRefineOutput();
                const discussionResult = deliverPlanDiscussion(ctx, handoffDelivery, feedback);
                await outcome.finalize?.({ action: "cancel", terminal: "cancelled" });
                return discussionResult;
            }
            if (outcome.action === "discard" || outcome.action === "cancel") {
                state.discardRefineOutput();
                // The mirror must learn the session ended even when the user walks away.
                await outcome.finalize?.({
                    action: outcome.action,
                    terminal: outcome.action === "discard" ? "discarded" : "cancelled",
                });
                if (outcome.action === "discard") {
                    ctx.ui.notify("Refine result discarded; returning to the Plan preview.", "info");
                }
                // An aborted signal is not a user decision; re-opening the confirm
                // overlay in a dead turn would strand the user on it.
                if (signal.aborted)
                    return { approved: false, exited: false };
            }
            continue;
        }
        if (action === "rollback") {
            const entries = await store.listDrafts();
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return { approved: false, exited: false };
            if (entries.length === 0) {
                ctx.ui.notify("No archived drafts are available to roll back to.", "warning");
                continue;
            }
            const rollback = await renderRollbackOverlay(ctx, {
                drafts: entries,
                readDraft: (path) => store.readDraft(path),
                signal,
            });
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return { approved: false, exited: false };
            if (rollback.action === "restore" && rollback.selected) {
                try {
                    const restored = await store.restoreDraft(rollback.selected.revision, state.latestRevision);
                    if (!calls.isCurrentPlanOperation(ctx, operation))
                        return { approved: false, exited: false };
                    calls.applyLoadedPlan(restored);
                    updatePlanAutoTaskContext(ctx, { markdown: restored.markdown, revision: state.latestRevision });
                    state.resetRefinement(-1);
                    calls.syncModeStatus(ctx);
                    ctx.ui.notify(`Restored Plan draft revision ${rollback.selected.revision} as r${restored.manifest.revision}.`, "info");
                }
                catch (error) {
                    ctx.ui.notify(`Rollback failed: ${calls.errorMessage(error)}`, "warning");
                }
            }
            continue;
        }
        if (action === "continue") {
            const discussion = decision.discussion !== undefined
                ? decision.discussion
                : await ctx.ui.input("Continue discussing the Plan", "Enter feedback or a question", { signal });
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return { approved: false, exited: false };
            if (!discussion?.trim())
                continue;
            return deliverPlanDiscussion(ctx, handoffDelivery, discussion.trim());
        }
        if (action === "close") {
            calls.abortPlanTurn(ctx);
            return { approved: false, exited: false };
        }
        if (action === "exit-plan") {
            await calls.exitModeAndRestore(ctx, operation);
            return { approved: false, exited: true };
        }
        if (action !== "execute") {
            calls.abortPlanTurn(ctx);
            ctx.ui.notify("Plan confirmation closed without an explicit Execute decision.", "warning");
            return { approved: false, exited: false };
        }
        const executionChoice = decision.execution ?? { backend: "standalone", context: "current" };
        return calls.approveAndImplement(ctx, store, executionChoice, handoffDelivery, operation, signal);
    }
    return { approved: false, exited: false };
}
function buildRefineFeedbackMessage(output: string, roleLabel?: string): string {
    return [
        "## Refine Feedback (Plan)",
        `The following is the Review & Refine output${roleLabel ? ` from ${roleLabel}` : ""} for the current Plan draft. Revise the Plan with plan-update to incorporate the valid findings, then present it again with plan-confirm. If you disagree with a point, explain why in the discussion.`,
        "",
        output,
    ].join("\n");
}
function deliverPlanDiscussion(ctx: PlanContext, handoffDelivery: PlanHandoffDelivery, discussion: string): PlanReviewOutcome {
    if (handoffDelivery === "tool-result") {
        return { approved: false, exited: false, discussionMessage: discussion };
    }
    calls.queuePlanDiscussion(ctx, discussion);
    return { approved: false, exited: false };
}
return { reviewPlan, buildRefineFeedbackMessage, deliverPlanDiscussion };
}
