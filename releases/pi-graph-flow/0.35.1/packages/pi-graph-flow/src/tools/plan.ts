/** Compatibility composition root. Algorithms live in plan-coordinator; PlanStore remains durable authority. */
import { PlanState } from "../plan-coordinator/state.ts";
import { createPlanHost } from "../plan-coordinator/host.ts";
import { createPlanCommands } from "../plan-coordinator/commands.ts";
import { createPlanReview } from "../plan-coordinator/review.ts";
import { createPlanApproval } from "../plan-coordinator/approval.ts";
import { createPlanHandoff } from "../plan-coordinator/handoff.ts";
import { createPlanLifecycle } from "../plan-coordinator/lifecycle.ts";
import { createPlanPresentation } from "../plan-coordinator/presentation.ts";
import type { PlanAutoGrantSnapshot } from "./plan-auto.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { UserAttentionHandler } from "../notify/user-attention.ts";
import type { PlanTransportHandle, PlanTransportRequest, PlanTransportResult } from "../plan-transport.ts";
import type { PlanConfirmationModelTransition, PlanWorkflowConfirmationOptions } from "./plan-confirm.ts";
import type { PlanStore, LoadedPlan, PlanArtifactEntry, PlanExecutionChoice, PlanExecutionContextMode, PlanSessionIdentity, PlanWorkflowBinding } from "./plan-store.ts";
import type { CompactionArbiter } from "../compaction/compaction-arbiter.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "../plan-coordinator/types.ts";
export type { PlanHandoffStatus, PlanContext, PlanApprovalAudit, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest } from "../plan-coordinator/types.ts";
export { PLAN_TOGGLE_KEY, PLAN_TOGGLE_LABEL, PLAN_MODE_REMINDER_TYPE } from "../plan-coordinator/presentation.ts";
export { PLAN_CLEAN_CONTEXT_COMPACTION_MARKER } from "../plan-coordinator/handoff.ts";
import { acquirePlanArtifactRead } from "../plan-coordinator/artifact-read.ts";
const state = new PlanState();
/** Root shutdown invokes this synchronously, before its first await. */
export function fencePlanArtifactReads(): void { state.fenceArtifactReads(); }
export function acquireCurrentPlanArtifact(ctx: PlanContext, artifactId: string, signal?: AbortSignal) {
  return acquirePlanArtifactRead(state, ctx, artifactId, signal);
}
export function isPlanCleanContextCompactionInstructions(customInstructions: string | undefined): boolean { return handoffCoordinator.isPlanCleanContextCompactionInstructions(customInstructions); }
function syncModeStatus(ctx: PlanContext): void { return presentation.syncModeStatus(ctx); }
export function refreshPlanModeStatus(ctx: PlanContext): void { return presentation.refreshPlanModeStatus(ctx); }
export function initPlan(pi: ExtensionAPI, options?: PlanRuntimeOptions): void { lifecycle.resetRuntimeState(); host.configure(pi, options); }
export function isPlanMode(): boolean { return presentation.isPlanMode(); }
export function getMode(): Mode { return presentation.getMode(); }
export function hasPlan(): boolean { return presentation.hasPlan(); }
export function getPlanText(): string { return presentation.getPlanText(); }
export function getPlanArtifactSummary(): PlanArtifactSummary { return presentation.getPlanArtifactSummary(); }
export function loadCurrentPlanArtifacts(ctx: PlanContext): Promise<LoadedPlanArtifactDocument[]> { return commands.loadCurrentPlanArtifacts(ctx); }
export function clearPlan(): void { return commands.clearPlan(); }
function ensureStore(ctx: PlanContext): Promise<PlanStore> { return host.ensureStore(ctx); }
function currentPlanSession(ctx: PlanContext): PlanSessionIdentity { return host.currentPlanSession(ctx); }
function applyLoadedPlan(loaded: LoadedPlan): void { return state.applyLoadedPlan(loaded); }
function ensureActToolSurface(): void { return host.ensureActToolSurface(); }
function activatePlanToolSurface(): void { return host.activatePlanToolSurface(); }
function restoreActToolSurface(): void { return host.restoreActToolSurface(); }
function enterPlanMode(ctx: PlanContext, operation: PlanOperationIdentity): Promise<boolean> { return commands.enterPlanMode(ctx, operation); }
function exitPlanMode(ctx: PlanContext, approved?: boolean): void { return commands.exitPlanMode(ctx, approved); }
export function exitMode(ctx: PlanContext, operation?: PlanOperationIdentity): Mode { return commands.exitMode(ctx, operation); }
export function exitModeAndRestore(ctx: PlanContext, operation?: PlanOperationIdentity): Promise<Mode> { return commands.exitModeAndRestore(ctx, operation); }
export function toggleMode(ctx: PlanContext, operation?: PlanOperationIdentity): Promise<Mode> { return commands.toggleMode(ctx, operation); }
export function setPlanModeChangeListener(listener: ((ctx: PlanContext) => void) | undefined): void { return presentation.setPlanModeChangeListener(listener); }
export function onSessionStartPlan(ctx: PlanContext): Promise<void> { return lifecycle.onSessionStartPlan(ctx); }
export function onSessionShutdownPlan(ctx: PlanContext): void { return lifecycle.onSessionShutdownPlan(ctx); }
function beginPlanOperation(ctx: PlanContext): PlanOperationIdentity { return state.beginPlanOperation(ctx); }
function bindPlanOperation(ctx: PlanContext, operation: PlanOperationIdentity, store: PlanStore): boolean { return state.bindPlanOperation(ctx, operation, store); }
function planOperationMatchesContext(ctx: PlanContext, operation: PlanOperationIdentity): boolean { return state.planOperationMatchesContext(ctx, operation); }
function isCurrentPlanOperation(ctx: PlanContext, operation: PlanOperationIdentity, requireStore?: boolean): boolean { return state.isCurrentPlanOperation(ctx, operation, requireStore); }
function recoverWorkflowBinding(ctx: PlanContext, store: PlanStore, approved: LoadedPlan, operation: PlanOperationIdentity): Promise<void> { return approval.recoverWorkflowBinding(ctx, store, approved, operation); }
function withPendingWorkflowDelivery(binding: PlanWorkflowBinding): PlanWorkflowBinding { return approval.withPendingWorkflowDelivery(binding); }
function acknowledgeWorkflowDelivery(ctx: PlanContext, store: PlanStore, handoffKey: string, binding: PlanWorkflowBinding, operation: PlanOperationIdentity): Promise<void> { return approval.acknowledgeWorkflowDelivery(ctx, store, handoffKey, binding, operation); }
function resetRuntimeState(): void { return lifecycle.resetRuntimeState(); }
export function onCompactPlan(ctx: PlanContext): void { return handoffCoordinator.onCompactPlan(ctx); }
export function onContextPlan(messages: AgentMessage[]): {
    messages: AgentMessage[];
} | undefined { return handoffCoordinator.onContextPlan(messages); }
export function projectPlanContextForCompaction(messages: AgentMessage[]): {
    messages: AgentMessage[];
    firstKeptEntryId: string;
} | undefined { return handoffCoordinator.projectPlanContextForCompaction(messages); }
export function onBeforeAgentStartPlan(_event: {
    systemPrompt: string;
}): {
    message: {
        customType: string;
        content: string;
        display: boolean;
    };
} | undefined { return lifecycle.onBeforeAgentStartPlan(_event); }
export function onToolCallPlan(event: {
    toolName: string;
    input: Record<string, unknown>;
}, _bypassHandoff?: boolean): {
    block: true;
    reason: string;
} | undefined { return lifecycle.onToolCallPlan(event, _bypassHandoff); }
function planMutationBlock(operation: string, detail?: string): {
    block: true;
    reason: string;
} { return lifecycle.planMutationBlock(operation, detail); }
export function onAgentEndPlan(event: {
    messages: unknown[];
}, ctx: PlanContext): Promise<void> { return lifecycle.onAgentEndPlan(event, ctx); }
function savePlan(ctx: PlanContext, markdown: string, expectedRevision: number, operation: PlanOperationIdentity): Promise<LoadedPlan | undefined> { return commands.savePlan(ctx, markdown, expectedRevision, operation); }
function isRecordValue(value: unknown): value is Record<string, unknown> { return host.isRecordValue(value); }
function isPlanTransportResult(value: unknown): value is PlanTransportResult { return host.isPlanTransportResult(value); }
function openPlanTransport(request: PlanTransportRequest): PlanTransportHandle | undefined { return host.openPlanTransport(request); }
function racePlanTransport<T>(local: (signal: AbortSignal) => Promise<T>, remote: PlanTransportHandle, signal: AbortSignal): Promise<{
    source: "local";
    value: T;
} | {
    source: "remote";
    result: PlanTransportResult;
}> { return host.racePlanTransport<T>(local, remote, signal); }
function transportRequest(ctx: PlanContext, operation: PlanOperationIdentity, kind: PlanTransportRequest["kind"], signal: AbortSignal, options: Omit<PlanTransportRequest, "kind" | "sessionId" | "operationId" | "cwd" | "mode" | "sessionFile" | "markdown" | "revision" | "pathLabel" | "signal">): PlanTransportRequest { return host.transportRequest(ctx, operation, kind, signal, options); }
function reviewPlan(ctx: PlanContext, allowConfirm: boolean, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, signal?: AbortSignal, onUserAttention?: UserAttentionHandler, autoGrant?: PlanAutoGrantSnapshot): Promise<PlanReviewOutcome> { return review.reviewPlan(ctx, allowConfirm, handoffDelivery, operation, signal, onUserAttention, autoGrant); }
function approveAndImplement(ctx: PlanContext, store: PlanStore, executionChoice: PlanExecutionChoice, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, signal: AbortSignal, autoGrant?: PlanAutoGrantSnapshot): Promise<PlanReviewOutcome> { return approval.approveAndImplement(ctx, store, executionChoice, handoffDelivery, operation, signal, autoGrant); }
function appendApprovalAudit(ctx: PlanContext, operation: PlanOperationIdentity, audit: PlanApprovalAudit): void { return approval.appendApprovalAudit(ctx, operation, audit); }
function buildRefineFeedbackMessage(output: string, roleLabel?: string): string { return review.buildRefineFeedbackMessage(output, roleLabel); }
function deliverPlanDiscussion(ctx: PlanContext, handoffDelivery: PlanHandoffDelivery, discussion: string): PlanReviewOutcome { return review.deliverPlanDiscussion(ctx, handoffDelivery, discussion); }
function queuePlanDiscussion(ctx: PlanContext, discussion: string): void { return host.queuePlanDiscussion(ctx, discussion); }
function buildPlanExitMessage(): string { return presentation.buildPlanExitMessage(); }
function buildPlanExitReminder(): string { return presentation.buildPlanExitReminder(); }
function abortPlanTurn(ctx: PlanContext): void { return host.abortPlanTurn(ctx); }
function editPlan(ctx: PlanContext, pathLabel: string, operation: PlanOperationIdentity, signal?: AbortSignal): Promise<void> { return commands.editPlan(ctx, pathLabel, operation, signal); }
export function consumePlanCleanContextCompaction(): PlanCleanContextCompactionRequest | undefined { return handoffCoordinator.consumePlanCleanContextCompaction(); }
function beginPlanHandoff(): PlanHandoffRequestIdentity { return state.beginPlanHandoff(); }
function isCurrentPlanHandoff(request: PlanHandoffRequestIdentity): boolean { return state.isCurrentPlanHandoff(request); }
function finishPlanHandoff(request: PlanHandoffRequestIdentity): boolean { return state.finishPlanHandoff(request); }
export function applyPlanContextToCompaction(preparation: {
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    firstKeptEntryId: string;
    previousSummary?: string;
}, branchMessages: AgentMessage[]): boolean { return handoffCoordinator.applyPlanContextToCompaction(preparation, branchMessages); }
function activatePlanContextReplacement(summary: string): void { return handoffCoordinator.activatePlanContextReplacement(summary); }
function canReplaceContextAfterCompactionFailure(error: unknown): boolean { return handoffCoordinator.canReplaceContextAfterCompactionFailure(error); }
function startImplementation(ctx: PlanContext, store: PlanStore, approved: LoadedPlan, executionChoice: PlanExecutionChoice, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, canHandoff?: () => boolean, preauthorized?: boolean): Promise<string | undefined> { return approval.startImplementation(ctx, store, approved, executionChoice, handoffDelivery, operation, canHandoff, preauthorized); }
function buildPlanExecutionContract(planPath: string, handoffKey?: string, refineFeedback?: string, refineRoleLabel?: string, sourceDocument?: string, preauthorized?: boolean): string { return approval.buildPlanExecutionContract(planPath, handoffKey, refineFeedback, refineRoleLabel, sourceDocument, preauthorized); }
function deliverImplementation(ctx: PlanContext, planPath: string, markdown: string, executionMode: PlanExecutionChoice["context"], executionMessage: string, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, onDelivered?: () => Promise<void>): Promise<string | undefined> { return handoffCoordinator.deliverImplementation(ctx, planPath, markdown, executionMode, executionMessage, handoffDelivery, operation, onDelivered); }
export function hasPendingPlanCompactHandoff(ctx: PlanContext): boolean { return handoffCoordinator.hasPendingPlanCompactHandoff(ctx); }
export function onAgentSettledPlan(ctx: PlanContext): void { return handoffCoordinator.onAgentSettledPlan(ctx); }
function deliverPlanHandoff(ctx: PlanContext, handoff: PlanCompactHandoff): boolean { return handoffCoordinator.deliverPlanHandoff(ctx, handoff); }
function startPlanCompaction(ctx: PlanContext, handoff: PlanCompactHandoff): void { return handoffCoordinator.startPlanCompaction(ctx, handoff); }
function sendImplementationMessage(ctx: PlanContext, message: string): void { return host.sendImplementationMessage(ctx, message); }
function currentDetails(action: PlanToolDetails["action"]): PlanToolDetails { return presentation.currentDetails(action); }
export function getPlanCompactionSnapshot(): PlanCompactionSnapshot { return presentation.getPlanCompactionSnapshot(); }
export function getPlanNewContextPayload(): PlanNewContextPayload | undefined { return presentation.getPlanNewContextPayload(); }
export function getPlanHandoffStatus(): PlanHandoffStatus { return presentation.getPlanHandoffStatus(); }
function result(text: string, details: PlanToolDetails, isError?: boolean, terminate?: boolean): AgentToolResult<PlanToolDetails> { return presentation.result(text, details, isError, terminate); }
function requirePlanMode(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> | undefined { return commands.requirePlanMode(action); }
function supersededResult(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> { return presentation.supersededResult(action); }
export function registerPlanTools(pi: ExtensionAPI, options?: {
    onUserAttention?: UserAttentionHandler;
}): void { return presentation.registerPlanTools(pi, options); }
function extractProposedPlan(text: string): string | undefined { return lifecycle.extractProposedPlan(text); }
function latestAssistantText(messages: unknown): string { return lifecycle.latestAssistantText(messages); }
function contentText(content: unknown): string { return lifecycle.contentText(content); }
function buildPlanEnterNote(): string { return presentation.buildPlanEnterNote(); }
export function registerPlanCommand(pi: ExtensionAPI): void { return presentation.registerPlanCommand(pi); }
function errorMessage(error: unknown): string { return presentation.errorMessage(error); }
const calls: PlanCalls = { isPlanCleanContextCompactionInstructions, syncModeStatus, refreshPlanModeStatus, isPlanMode, getMode, hasPlan, getPlanText, getPlanArtifactSummary, loadCurrentPlanArtifacts, clearPlan, ensureStore, currentPlanSession, applyLoadedPlan, ensureActToolSurface, activatePlanToolSurface, restoreActToolSurface, enterPlanMode, exitPlanMode, exitMode, exitModeAndRestore, toggleMode, setPlanModeChangeListener, onSessionStartPlan, onSessionShutdownPlan, beginPlanOperation, bindPlanOperation, planOperationMatchesContext, isCurrentPlanOperation, recoverWorkflowBinding, withPendingWorkflowDelivery, acknowledgeWorkflowDelivery, resetRuntimeState, onCompactPlan, onContextPlan, projectPlanContextForCompaction, onBeforeAgentStartPlan, onToolCallPlan, planMutationBlock, onAgentEndPlan, savePlan, isRecordValue, isPlanTransportResult, openPlanTransport, racePlanTransport, transportRequest, reviewPlan, approveAndImplement, appendApprovalAudit, buildRefineFeedbackMessage, deliverPlanDiscussion, queuePlanDiscussion, buildPlanExitMessage, buildPlanExitReminder, abortPlanTurn, editPlan, consumePlanCleanContextCompaction, beginPlanHandoff, isCurrentPlanHandoff, finishPlanHandoff, applyPlanContextToCompaction, activatePlanContextReplacement, canReplaceContextAfterCompactionFailure, startImplementation, buildPlanExecutionContract, deliverImplementation, hasPendingPlanCompactHandoff, onAgentSettledPlan, deliverPlanHandoff, startPlanCompaction, sendImplementationMessage, currentDetails, getPlanCompactionSnapshot, getPlanNewContextPayload, getPlanHandoffStatus, result, requirePlanMode, supersededResult, registerPlanTools, extractProposedPlan, latestAssistantText, contentText, buildPlanEnterNote, registerPlanCommand, errorMessage, executeEnterTool: (...args) => commands.executeEnterTool(...args), executeUpdateTool: (...args) => commands.executeUpdateTool(...args), executeReviewTool: (...args) => commands.executeReviewTool(...args), executeConfirmTool: (...args) => commands.executeConfirmTool(...args), executeDecomposeTool: (...args) => commands.executeDecomposeTool(...args), executeExitTool: (...args) => commands.executeExitTool(...args), executeStatusTool: (...args) => commands.executeStatusTool(...args), executePlanCommand: (...args) => commands.executePlanCommand(...args), initPlan };
const host = createPlanHost(state, calls);
const commands = createPlanCommands(state, calls, host);
const review = createPlanReview(state, calls, host);
const approval = createPlanApproval(state, calls, host);
const handoffCoordinator = createPlanHandoff(state, calls, host);
const lifecycle = createPlanLifecycle(state, calls, host);
const presentation = createPlanPresentation(state, calls, host);
