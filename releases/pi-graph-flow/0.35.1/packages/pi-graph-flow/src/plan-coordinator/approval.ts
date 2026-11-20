/** approval responsibility; composed by the existing tools/plan entry. */
import { PlanStore, type LoadedPlan, type PlanWorkflowBinding, type PlanExecutionChoice, PlanApprovalError } from "../tools/plan-store.ts";
import { join } from "node:path";
import { type PlanAutoGrantSnapshot, getPlanAutoSnapshot, isCurrentPlanAutoGrant, markPlanAutoConfirmed, updatePlanAutoTaskContext, PLAN_AUTO_AUDIT_ENTRY } from "../tools/plan-auto.ts";
import { createHash } from "node:crypto";
import type { PlanState } from "./state.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "./types.ts";
import type { PlanHost } from "./host.ts";

export function createPlanApproval(state: PlanState, calls: Pick<PlanCalls, "isCurrentPlanOperation" | "applyLoadedPlan" | "deliverImplementation" | "errorMessage" | "planOperationMatchesContext" | "exitPlanMode">, host: PlanHost) {
async function recoverWorkflowBinding(ctx: PlanContext, store: PlanStore, approved: LoadedPlan, operation: PlanOperationIdentity): Promise<void> {
    const execution = approved.manifest.execution;
    const handoffKey = approved.manifest.handoffKey;
    const sourceChecksum = approved.manifest.approvedChecksum;
    const approvedPath = approved.manifest.approvedPath;
    if (!execution || execution.backend !== "workflow" || !handoffKey || !sourceChecksum || !approvedPath)
        return;
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return;
    const priorBinding = approved.manifest.workflowBinding;
    let publicationInput = approved;
    try {
        if (priorBinding?.status !== "bound") {
            publicationInput = await store.updateWorkflowBinding(handoffKey, {
                status: "pending",
                handoffKey,
                sourceChecksum,
                updatedAt: new Date().toISOString(),
            });
            if (!calls.isCurrentPlanOperation(ctx, operation))
                return;
            calls.applyLoadedPlan(publicationInput);
        }
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        const published = await host.publishWorkflowPlan(ctx, publicationInput, execution);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        if (published.binding.status !== "bound") {
            throw new Error("Workflow publisher did not return a bound result");
        }
        const pendingDelivery = withPendingWorkflowDelivery(published.binding);
        const bound = await store.updateWorkflowBinding(handoffKey, pendingDelivery);
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        calls.applyLoadedPlan(bound);
        ctx.ui.notify(`Recovered approved Plan binding to Workflow Session ${published.binding.workflowSessionId}.`, "info");
        const planPath = join(bound.plansDir, approvedPath);
        const executionMessage = `${published.executionMessage}\n\n${buildPlanExecutionContract(planPath, handoffKey, undefined, undefined, bound.manifest.sourceDocuments?.[0])}`;
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        await calls.deliverImplementation(ctx, planPath, bound.markdown, execution.context, executionMessage, "message", operation, () => acknowledgeWorkflowDelivery(ctx, store, handoffKey, pendingDelivery, operation));
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
    }
    catch (error) {
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        if (priorBinding?.status !== "bound") {
            try {
                const failed = await store.updateWorkflowBinding(handoffKey, {
                    status: "failed",
                    handoffKey,
                    sourceChecksum,
                    error: calls.errorMessage(error),
                    updatedAt: new Date().toISOString(),
                });
                if (!calls.isCurrentPlanOperation(ctx, operation))
                    return;
                calls.applyLoadedPlan(failed);
            }
            catch (persistError) {
                if (!calls.isCurrentPlanOperation(ctx, operation))
                    return;
                ctx.ui.notify(`Approved Plan Workflow binding retry failed and its failure state could not be persisted: ${calls.errorMessage(persistError)}.`, "warning");
                return;
            }
        }
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        ctx.ui.notify(priorBinding?.status === "bound"
            ? `Approved Plan Workflow delivery retry failed: ${calls.errorMessage(error)}. The canonical binding is preserved.`
            : `Approved Plan Workflow binding retry failed: ${calls.errorMessage(error)}. Approval is preserved; execution was not started.`, "warning");
    }
}
function withPendingWorkflowDelivery(binding: PlanWorkflowBinding): PlanWorkflowBinding {
    if (binding.status !== "bound" || !binding.requestId)
        return binding;
    return {
        ...binding,
        deliveryId: binding.deliveryId ?? `${binding.requestId}:implementation`,
        deliveryStatus: "pending",
        updatedAt: new Date().toISOString(),
    };
}
async function acknowledgeWorkflowDelivery(ctx: PlanContext, store: PlanStore, handoffKey: string, binding: PlanWorkflowBinding, operation: PlanOperationIdentity): Promise<void> {
    if (binding.status !== "bound" || binding.deliveryStatus !== "pending")
        return;
    if (!calls.isCurrentPlanOperation(ctx, operation))
        return;
    const deliveredAt = new Date().toISOString();
    try {
        const delivered = await store.updateWorkflowBinding(handoffKey, {
            ...binding,
            deliveryStatus: "delivered",
            deliveredAt,
            updatedAt: deliveredAt,
        });
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        calls.applyLoadedPlan(delivered);
    }
    catch (error) {
        if (!calls.isCurrentPlanOperation(ctx, operation))
            return;
        ctx.ui.notify(`Workflow execution handoff was delivered but could not be acknowledged: ${calls.errorMessage(error)}`, "warning");
    }
}
/** Both human UI decisions and host preauthorization use this one approval transaction. */
async function approveAndImplement(ctx: PlanContext, store: PlanStore, executionChoice: PlanExecutionChoice, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, signal: AbortSignal, autoGrant?: PlanAutoGrantSnapshot): Promise<PlanReviewOutcome> {
    const markdown = state.latestPlan ?? "";
    const revision = state.latestRevision;
    const consumptionGrant = autoGrant ?? getPlanAutoSnapshot(ctx);
    const fresh = () => !signal.aborted && calls.isCurrentPlanOperation(ctx, operation)
        && (!autoGrant || isCurrentPlanAutoGrant(autoGrant, ctx));
    const assertCurrent = () => {
        if (!fresh() || (autoGrant && !getPlanAutoSnapshot(ctx)?.confirmPending)) {
            throw new Error("Plan approval cancelled, superseded, or preauthorization revoked/consumed");
        }
    };
    let audit: PlanApprovalAudit = {
        source: autoGrant ? "human-preauthorization" : "human-confirmation",
        ...(autoGrant ? { generation: autoGrant.generation } : {}),
        revision, checksum: createHash("sha256").update(markdown).digest("hex"), result: "requested",
    };
    let approved: LoadedPlan;
    try {
        assertCurrent();
        if (!markdown.trim())
            throw new Error("Cannot approve an empty Plan");
        if (autoGrant)
            appendApprovalAudit(ctx, operation, audit);
        approved = await store.approve(markdown, revision, {
            execution: executionChoice, assertCurrent,
            onCommitted(committed) {
                // Consume after manifest rename, not after cleanup. This also fences a
                // duplicate confirm captured while cleanup is still in flight.
                if (consumptionGrant)
                    markPlanAutoConfirmed(ctx, consumptionGrant, {
                        markdown: committed.markdown, revision: committed.manifest.revision,
                        handoffKey: committed.manifest.handoffKey,
                    });
            },
        });
    }
    catch (error) {
        audit = { ...audit, result: "not-approved", reason: calls.errorMessage(error) };
        if (calls.isCurrentPlanOperation(ctx, operation)) {
            const loaded = await store.load();
            if (calls.isCurrentPlanOperation(ctx, operation)) {
                calls.applyLoadedPlan(loaded);
                updatePlanAutoTaskContext(ctx, { markdown: loaded.markdown, revision: state.latestRevision });
                const draftNote = error instanceof PlanApprovalError && error.draftPersisted
                    ? ` Your draft is intact at revision ${error.revision}; retry the approval.` : "";
                ctx.ui.notify(`Plan approval failed: ${calls.errorMessage(error)}${draftNote}`, "warning");
            }
        }
        try {
            appendApprovalAudit(ctx, operation, audit);
        }
        catch { /* tool result retains the outcome */ }
        return { approved: false, exited: false, approvalAudit: audit };
    }
    audit = { ...audit, revision: approved.manifest.revision,
        checksum: approved.manifest.approvedChecksum!, handoffKey: approved.manifest.handoffKey, result: "committed" };
    if (calls.isCurrentPlanOperation(ctx, operation))
        calls.applyLoadedPlan(approved);
    const stopped = (reason: string): PlanReviewOutcome => {
        const stoppedAudit: PlanApprovalAudit = { ...audit, result: "committed-handoff-stopped", reason };
        try {
            appendApprovalAudit(ctx, operation, stoppedAudit);
        }
        catch { /* tool result retains the outcome */ }
        return { approved: true, exited: state.mode === "act", executionChoice,
            executionMode: executionChoice.context, committedPlan: approved, approvalAudit: stoppedAudit };
    };
    if (!fresh())
        return stopped("Approval committed; execution was not started because the operation, signal, or preauthorization changed.");
    try {
        appendApprovalAudit(ctx, operation, audit);
        const executionMessage = await startImplementation(ctx, store, approved, executionChoice, handoffDelivery, operation, fresh, autoGrant !== undefined);
        if (!fresh())
            return stopped("Approval committed; execution was not started because the operation, signal, or preauthorization changed.");
        const compactDeferred = state.pendingPlanCompactHandoff?.operation === operation;
        return { approved: true, exited: true, executionMode: executionChoice.context, executionChoice,
            executionMessage, compactDeferred, committedPlan: approved,
            ...(autoGrant ? { canHandoff: fresh } : {}),
            approvalAudit: { ...audit, result: compactDeferred || handoffDelivery === "tool-result" ? "handoff-ready" : "handed-off" } };
    }
    catch (error) {
        return stopped(`Approval committed; execution was not started: ${calls.errorMessage(error)}`);
    }
}
function appendApprovalAudit(ctx: PlanContext, operation: PlanOperationIdentity, audit: PlanApprovalAudit): void {
    // Never append an old session's outcome to a newly selected chat. The tool
    // result carries immutable approval identity even when the operation is stale.
    if (state.planLifecycleGeneration !== operation.lifecycleGeneration || !calls.planOperationMatchesContext(ctx, operation))
        return;
    host.extensionApi?.appendEntry?.(PLAN_AUTO_AUDIT_ENTRY, {
        action: "approval", ...audit, sessionId: operation.sessionId, storeKey: operation.storeKey,
        replayable: false,
    });
}
async function startImplementation(ctx: PlanContext, store: PlanStore, approved: LoadedPlan, executionChoice: PlanExecutionChoice, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, canHandoff: () => boolean = () => calls.isCurrentPlanOperation(ctx, operation), preauthorized = false): Promise<string | undefined> {
    if (!canHandoff())
        return undefined;
    const markdown = approved.markdown;
    const planPath = approved.manifest.approvedPath
        ? join(approved.plansDir, approved.manifest.approvedPath)
        : approved.currentPath;
    const executionMode = executionChoice.context;
    const restored = await host.restorePlanActModel(ctx);
    if (!canHandoff())
        return undefined;
    if (preauthorized && !restored)
        throw new Error("Act model restoration failed");
    calls.exitPlanMode(ctx, true);
    state.activateApprovedMaterial(markdown);
    ctx.ui.notify("Plan approved · Act mode active", "info");
    const refineFeedback = state.refineSessionRevision === approved.manifest.revision
        && state.refineLatestAppliesAs === "feedback"
        ? state.refineLatestOutput : undefined;
    const executionContract = buildPlanExecutionContract(planPath, state.latestHandoffKey, refineFeedback, state.refineLatestRoleLabel, approved.manifest.sourceDocuments?.[0], preauthorized);
    let executionMessage = executionContract;
    let workflowDelivery: {
        handoffKey: string;
        binding: PlanWorkflowBinding;
    } | undefined;
    if (executionChoice.backend === "workflow") {
        try {
            const publication = await host.publishWorkflowPlan(ctx, approved, executionChoice);
            if (!canHandoff())
                return undefined;
            if (publication.binding.status !== "bound") {
                throw new Error("Workflow publisher returned a non-bound result");
            }
            const pendingDelivery = withPendingWorkflowDelivery(publication.binding);
            const bound = await store.updateWorkflowBinding(publication.binding.handoffKey, pendingDelivery);
            if (!canHandoff())
                return undefined;
            calls.applyLoadedPlan(bound);
            workflowDelivery = {
                handoffKey: publication.binding.handoffKey,
                binding: bound.manifest.workflowBinding!,
            };
            executionMessage = `${publication.executionMessage}\n\n${executionContract}`;
            ctx.ui.notify(`Approved Plan bound to Workflow Session ${publication.binding.workflowSessionId}`, "info");
        }
        catch (error) {
            if (!canHandoff())
                return undefined;
            const message = calls.errorMessage(error);
            const handoffKey = approved.manifest.handoffKey;
            const checksum = approved.manifest.approvedChecksum;
            if (handoffKey && checksum) {
                const failed: PlanWorkflowBinding = {
                    status: "failed",
                    handoffKey,
                    sourceChecksum: checksum,
                    error: message.slice(0, 2000),
                    updatedAt: new Date().toISOString(),
                };
                try {
                    const failedPlan = await store.updateWorkflowBinding(handoffKey, failed);
                    if (!canHandoff())
                        return undefined;
                    calls.applyLoadedPlan(failedPlan);
                }
                catch (bindingError) {
                    if (!canHandoff())
                        return undefined;
                    ctx.ui.notify(`Workflow binding state could not be persisted: ${calls.errorMessage(bindingError)}`, "error");
                }
            }
            if (!canHandoff())
                return undefined;
            const failureMessage = `Plan approved, but Workflow binding failed; execution was not started: ${message}`;
            ctx.ui.notify(failureMessage, "error");
            return failureMessage;
        }
    }
    if (!canHandoff())
        return undefined;
    const delivered = await calls.deliverImplementation(ctx, planPath, markdown, executionMode, executionMessage, handoffDelivery, operation, workflowDelivery
        ? () => acknowledgeWorkflowDelivery(ctx, store, workflowDelivery!.handoffKey, workflowDelivery!.binding, operation)
        : undefined);
    return calls.isCurrentPlanOperation(ctx, operation) ? delivered : undefined;
}
function buildPlanExecutionContract(planPath: string, handoffKey?: string, refineFeedback?: string, refineRoleLabel?: string, sourceDocument?: string, preauthorized = false): string {
    const base = [
        preauthorized
            ? "The user preauthorized this Plan-confirm through Plan-auto; no per-confirm click was made. Immediate implementation of this approved Plan is authorized."
            : "The user selected Execute and explicitly authorized immediate implementation of the approved Plan.",
        "Begin execution now. Do not ask the user to trigger implementation again.",
        "The approved Plan is already in the current context for current-context execution; after a deterministic reset, reload it from the source path below before decomposition.",
        `Plan source: ${planPath}`,
        ...(sourceDocument
            ? [`Decision document: ${sourceDocument} — honor its locked decisions; do not re-litigate alternatives.`]
            : []),
        "Before modifying the project:",
        "1. Load the knowledge/spec system (Knowledge Gate) before any project-related work:",
        "   - Make `maestro search \"<1-3 task keywords from this Plan>\" [--type spec|knowhow] --json` the first project-related call.",
        "   - Load every relevant governing hit with `maestro load --type <type> --id <id>`; search is exposure only, loading records consumption.",
        "   - Follow the injected knowledge_context; re-search when entering a new subsystem or before an architecture decision.",
        "2. Reconcile the Plan with every user requirement; do not shrink or reinterpret the approved scope.",
        "   - Distinguish user-required outcomes and explicit locked constraints from agent-selected implementation means. Prefer the smallest end-to-end path using existing authorities; risk enumeration alone does not make auxiliary infrastructure a delivery prerequisite.",
        "   - Explain each blocking dependency with a requirement or confirmed material defect. If a simpler equivalent implementation is supported by evidence, reconcile it with the approved Plan; obtain renewed approval for scope, explicit locked-decision, or safety-boundary changes. Never silently drop acceptance conditions or bypass existing gates.",
        "   - Carry cumulative failed-attempt counts by shared interface/state machine and delivery blocker across workers, task names, approaches, and resets. After three unsuccessful attempts, stop the correction chain and report the effect on the requested outcome plus a simpler option or need for redesign/user guidance.",
        "3. Decompose the Plan into an ordered Todo dependency graph before implementation.",
        ...(handoffKey
            ? [
                `   - For complex approved work, call plan-decompose with planHandoffKey: "${handoffKey}"; follow the returned decomposition prompt in the current main flow, then create the Todo batch it specifies.`,
                `   - For simple work, create the Todo directly with planHandoffKey: "${handoffKey}".`,
            ]
            : ["   - For complex approved work, use plan-decompose before creating Todos."]),
        "4. Goal creation is optional. Do not create a Goal solely because the Plan was approved. Create one only when this work genuinely needs cross-turn persistence, a user-requested budget, or independent completion verification and no active Workflow Session already owns execution.",
        "   - When Todos are used, attach a Goal only to a key Todo with verifiable acceptance criteria; never create one for every Todo. A Todo without a Goal completes through its own acceptance criteria.",
        "5. Prefer the teammate tool to delegate independent Todo work; use direct execution only when delegation would not help.",
        "6. Execute the Todo sequence; activating a Todo switches to its quality-gate Goal only when that Todo explicitly has one, and only that Todo waits for Goal verification.",
        "7. After implementation and verification, assess the task execution for reusable knowledge before declaring completion:",
        "   - Stage only a non-obvious pitfall, failure lesson, trade-off, or newly established prescriptive constraint through the active Run/Session knowledge workflow; do not duplicate facts already auto-staged from accepted decisions or locked constraints.",
        "   - If nothing meets the knowledge quality bar, explicitly report zero knowledge candidates. Never fabricate a candidate merely to complete the process.",
    ];
    if (refineFeedback) {
        base.push(`8. Review & Refine feedback${refineRoleLabel ? ` from ${refineRoleLabel}` : ""}: incorporate valid findings during execution.`, "<refine-feedback>", refineFeedback, "</refine-feedback>");
    }
    return base.join("\n");
}
return { recoverWorkflowBinding, withPendingWorkflowDelivery, acknowledgeWorkflowDelivery, approveAndImplement, appendApprovalAudit, startImplementation, buildPlanExecutionContract };
}
