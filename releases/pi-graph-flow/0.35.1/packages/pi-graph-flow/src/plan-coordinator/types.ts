/** Shared Plan contracts; no runtime owner or effects. */
import type { PlanAutoGrantSnapshot } from "../tools/plan-auto.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { UserAttentionHandler } from "../notify/user-attention.ts";
import type { PlanTransportHandle, PlanTransportRequest, PlanTransportResult } from "../plan-transport.ts";
import type { PlanConfirmationModelTransition, PlanWorkflowConfirmationOptions } from "../tools/plan-confirm.ts";
import type { PlanStore, LoadedPlan, PlanArtifactEntry, PlanExecutionChoice, PlanExecutionContextMode, PlanSessionIdentity, PlanWorkflowBinding } from "../tools/plan-store.ts";
import type { CompactionArbiter } from "../compaction/compaction-arbiter.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EmptyPlanParams, PlanUpdateParams } from "./presentation.ts";
import type { PlanDecomposeParams } from "../tools/plan-decompose.ts";
export type Mode = "act" | "plan";
export type PlanExecutionMode = PlanExecutionContextMode;
export type PlanHandoffStatus = "none" | "todo-required" | "ready";
export type PlanContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "mode" | "isIdle" | "sessionManager" | "compact" | "model" | "modelRegistry" | "isProjectTrusted"> & Partial<Pick<ExtensionContext, "abort" | "getContextUsage" | "signal">>;
export interface PlanReviewOutcome {
    approved: boolean;
    exited: boolean;
    executionMode?: PlanExecutionMode;
    executionChoice?: PlanExecutionChoice;
    executionMessage?: string;
    discussionMessage?: string;
    compactDeferred?: boolean;
    approvalAudit?: PlanApprovalAudit;
    committedPlan?: LoadedPlan;
    canHandoff?: () => boolean;
}
export interface PlanApprovalAudit {
    source: "human-confirmation" | "human-preauthorization";
    generation?: number;
    revision: number;
    checksum: string;
    handoffKey?: string;
    result: "requested" | "not-approved" | "committed" | "handoff-ready" | "handed-off" | "committed-handoff-stopped";
    reason?: string;
}
export type PlanHandoffDelivery = "message" | "tool-result";
export interface PlanToolDetails {
    action: "enter" | "update" | "review" | "confirm" | "decompose" | "exit" | "status";
    mode: Mode;
    revision: number;
    path: string;
    sessionId: string;
    status: "empty" | "draft" | "approved";
    handoffStatus: PlanHandoffStatus;
    handoffKey?: string;
    execution?: PlanExecutionChoice;
    workflowBinding?: PlanWorkflowBinding;
    approved?: boolean;
    approvalAudit?: PlanApprovalAudit;
    planAuto?: {
        enabled: boolean;
        generation?: number;
        confirmPending?: boolean;
    };
    error?: string;
}
export interface PlanCompactionSnapshot {
    mode: Mode;
    status: PlanToolDetails["status"];
    revision: number;
    handoffStatus: PlanHandoffStatus;
    handoffKey?: string;
    path?: string;
    /** Approval identity, not an authorization to restart completed execution. */
    checksum?: string;
}
export interface PlanNewContextPayload {
    status: "draft" | "approved";
    revision: number;
    path: string;
    handoffKey?: string;
    checksum?: string;
    markdown: string;
    markdownTruncated?: boolean;
}
export interface LoadedPlanArtifactDocument {
    entry: PlanArtifactEntry;
    markdown: string;
    /** Absolute path of the artifact file under the store's plansDir. */
    absolutePath: string;
}
export interface PlanArtifactSummary {
    available: boolean;
    revision: number;
    status: PlanToolDetails["status"];
}
export interface PlanNewContextScheduleInput {
    executionMessage: string;
    plan: PlanNewContextPayload;
    continueAfterReset(): boolean;
    onCancelled(reason: string): void;
}
export interface PlanNewContextScheduleReceipt {
    requestId: number;
    coalesced: boolean;
}
export interface PlanRuntimeOptions {
    storeFactory?: (cwd: string, session: PlanSessionIdentity) => PlanStore;
    hasExecutableTodo?: (handoffKey: string) => boolean;
    compactionArbiter?: CompactionArbiter;
    compactionHandoffTimeoutMs?: number;
    scheduleNewContext?: (ctx: PlanContext, input: PlanNewContextScheduleInput) => PlanNewContextScheduleReceipt;
    restoreActModel?: (ctx: PlanContext) => Promise<boolean>;
    describeModelTransition?: (ctx: PlanContext) => PlanConfirmationModelTransition | undefined;
    workflowConfirmation?: (ctx: PlanContext) => PlanWorkflowConfirmationOptions | Promise<PlanWorkflowConfirmationOptions>;
    publishWorkflowPlan?: (ctx: PlanContext, approved: LoadedPlan, execution: PlanExecutionChoice) => Promise<PlanWorkflowPublicationResult>;
}
export interface PlanWorkflowPublicationResult {
    binding: PlanWorkflowBinding;
    executionMessage: string;
}
export interface PlanCleanContextCompactionRequest {
    summary: string;
    firstKeptEntryId: string;
    lifecycleGeneration: number;
    requestId: number;
}
export interface PlanHandoffRequestIdentity {
    lifecycleGeneration: number;
    requestId: number;
}
export interface PlanOperationIdentity {
    lifecycleGeneration: number;
    operationId: number;
    sessionId: string;
    storeKey: string;
    store?: PlanStore;
}
export interface PlanCompactHandoff {
    request: PlanHandoffRequestIdentity;
    operation: PlanOperationIdentity;
    planPath: string;
    markdown: string;
    executionMessage: string;
    onDelivered?: () => Promise<void>;
    /** Set when another host compaction owns the boundary and must settle first. */
    waitingForCompactionSettlement?: boolean;
}
export interface PlanContextReplacement {
  lifecycleGeneration: number;
  replacement: AgentMessage;
  baselineMessages?: string[];
}
export interface PlanCalls {
isPlanCleanContextCompactionInstructions(customInstructions: string | undefined): boolean;
syncModeStatus(ctx: PlanContext): void;
refreshPlanModeStatus(ctx: PlanContext): void;
initPlan(pi: ExtensionAPI, options?: PlanRuntimeOptions): void;
isPlanMode(): boolean;
getMode(): Mode;
hasPlan(): boolean;
getPlanText(): string;
getPlanArtifactSummary(): PlanArtifactSummary;
loadCurrentPlanArtifacts(ctx: PlanContext): Promise<LoadedPlanArtifactDocument[]>;
clearPlan(): void;
ensureStore(ctx: PlanContext): Promise<PlanStore>;
currentPlanSession(ctx: PlanContext): PlanSessionIdentity;
applyLoadedPlan(loaded: LoadedPlan): void;
ensureActToolSurface(): void;
activatePlanToolSurface(): void;
restoreActToolSurface(): void;
enterPlanMode(ctx: PlanContext, operation: PlanOperationIdentity): Promise<boolean>;
exitPlanMode(ctx: PlanContext, approved?: boolean): void;
exitMode(ctx: PlanContext, operation?: PlanOperationIdentity): Mode;
exitModeAndRestore(ctx: PlanContext, operation?: PlanOperationIdentity): Promise<Mode>;
toggleMode(ctx: PlanContext, operation?: PlanOperationIdentity): Promise<Mode>;
setPlanModeChangeListener(listener: ((ctx: PlanContext) => void) | undefined): void;
onSessionStartPlan(ctx: PlanContext): Promise<void>;
onSessionShutdownPlan(ctx: PlanContext): void;
beginPlanOperation(ctx: PlanContext): PlanOperationIdentity;
bindPlanOperation(ctx: PlanContext, operation: PlanOperationIdentity, store: PlanStore): boolean;
planOperationMatchesContext(ctx: PlanContext, operation: PlanOperationIdentity): boolean;
isCurrentPlanOperation(ctx: PlanContext, operation: PlanOperationIdentity, requireStore?: boolean): boolean;
recoverWorkflowBinding(ctx: PlanContext, store: PlanStore, approved: LoadedPlan, operation: PlanOperationIdentity): Promise<void>;
withPendingWorkflowDelivery(binding: PlanWorkflowBinding): PlanWorkflowBinding;
acknowledgeWorkflowDelivery(ctx: PlanContext, store: PlanStore, handoffKey: string, binding: PlanWorkflowBinding, operation: PlanOperationIdentity): Promise<void>;
resetRuntimeState(): void;
onCompactPlan(ctx: PlanContext): void;
onContextPlan(messages: AgentMessage[]): {
    messages: AgentMessage[];
} | undefined;
projectPlanContextForCompaction(messages: AgentMessage[]): {
    messages: AgentMessage[];
    firstKeptEntryId: string;
} | undefined;
onBeforeAgentStartPlan(_event: {
    systemPrompt: string;
}): {
    message: {
        customType: string;
        content: string;
        display: boolean;
    };
} | undefined;
onToolCallPlan(event: {
    toolName: string;
    input: Record<string, unknown>;
}, _bypassHandoff?: boolean): {
    block: true;
    reason: string;
} | undefined;
planMutationBlock(operation: string, detail?: string): {
    block: true;
    reason: string;
};
onAgentEndPlan(event: {
    messages: unknown[];
}, ctx: PlanContext): Promise<void>;
savePlan(ctx: PlanContext, markdown: string, expectedRevision: number, operation: PlanOperationIdentity): Promise<LoadedPlan | undefined>;
isRecordValue(value: unknown): value is Record<string, unknown>;
isPlanTransportResult(value: unknown): value is PlanTransportResult;
openPlanTransport(request: PlanTransportRequest): PlanTransportHandle | undefined;
racePlanTransport<T>(local: (signal: AbortSignal) => Promise<T>, remote: PlanTransportHandle, signal: AbortSignal): Promise<{
    source: "local";
    value: T;
} | {
    source: "remote";
    result: PlanTransportResult;
}>;
transportRequest(ctx: PlanContext, operation: PlanOperationIdentity, kind: PlanTransportRequest["kind"], signal: AbortSignal, options: Omit<PlanTransportRequest, "kind" | "sessionId" | "operationId" | "cwd" | "mode" | "sessionFile" | "markdown" | "revision" | "pathLabel" | "signal">): PlanTransportRequest;
reviewPlan(ctx: PlanContext, allowConfirm: boolean, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, signal?: AbortSignal, onUserAttention?: UserAttentionHandler, autoGrant?: PlanAutoGrantSnapshot): Promise<PlanReviewOutcome>;
approveAndImplement(ctx: PlanContext, store: PlanStore, executionChoice: PlanExecutionChoice, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, signal: AbortSignal, autoGrant?: PlanAutoGrantSnapshot): Promise<PlanReviewOutcome>;
appendApprovalAudit(ctx: PlanContext, operation: PlanOperationIdentity, audit: PlanApprovalAudit): void;
buildRefineFeedbackMessage(output: string, roleLabel?: string): string;
deliverPlanDiscussion(ctx: PlanContext, handoffDelivery: PlanHandoffDelivery, discussion: string): PlanReviewOutcome;
queuePlanDiscussion(ctx: PlanContext, discussion: string): void;
buildPlanExitMessage(): string;
buildPlanExitReminder(): string;
abortPlanTurn(ctx: PlanContext): void;
editPlan(ctx: PlanContext, pathLabel: string, operation: PlanOperationIdentity, signal?: AbortSignal): Promise<void>;
consumePlanCleanContextCompaction(): PlanCleanContextCompactionRequest | undefined;
beginPlanHandoff(): PlanHandoffRequestIdentity;
isCurrentPlanHandoff(request: PlanHandoffRequestIdentity): boolean;
finishPlanHandoff(request: PlanHandoffRequestIdentity): boolean;
applyPlanContextToCompaction(preparation: {
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    firstKeptEntryId: string;
    previousSummary?: string;
}, branchMessages: AgentMessage[]): boolean;
activatePlanContextReplacement(summary: string): void;
canReplaceContextAfterCompactionFailure(error: unknown): boolean;
startImplementation(ctx: PlanContext, store: PlanStore, approved: LoadedPlan, executionChoice: PlanExecutionChoice, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, canHandoff?: () => boolean, preauthorized?: boolean): Promise<string | undefined>;
buildPlanExecutionContract(planPath: string, handoffKey?: string, refineFeedback?: string, refineRoleLabel?: string, sourceDocument?: string, preauthorized?: boolean): string;
deliverImplementation(ctx: PlanContext, planPath: string, markdown: string, executionMode: PlanExecutionChoice["context"], executionMessage: string, handoffDelivery: PlanHandoffDelivery, operation: PlanOperationIdentity, onDelivered?: () => Promise<void>): Promise<string | undefined>;
hasPendingPlanCompactHandoff(ctx: PlanContext): boolean;
onAgentSettledPlan(ctx: PlanContext): void;
deliverPlanHandoff(ctx: PlanContext, handoff: PlanCompactHandoff): boolean;
startPlanCompaction(ctx: PlanContext, handoff: PlanCompactHandoff): void;
sendImplementationMessage(ctx: PlanContext, message: string): void;
currentDetails(action: PlanToolDetails["action"]): PlanToolDetails;
getPlanCompactionSnapshot(): PlanCompactionSnapshot;
getPlanNewContextPayload(): PlanNewContextPayload | undefined;
getPlanHandoffStatus(): PlanHandoffStatus;
result(text: string, details: PlanToolDetails, isError?: boolean, terminate?: boolean): AgentToolResult<PlanToolDetails>;
requirePlanMode(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> | undefined;
supersededResult(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails>;
registerPlanTools(pi: ExtensionAPI, options?: {
    onUserAttention?: UserAttentionHandler;
}): void;
extractProposedPlan(text: string): string | undefined;
latestAssistantText(messages: unknown): string;
contentText(content: unknown): string;
buildPlanEnterNote(): string;
registerPlanCommand(pi: ExtensionAPI): void;
errorMessage(error: unknown): string;
executeEnterTool: (...args: [...Parameters<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>, onUserAttention?: UserAttentionHandler]) => ReturnType<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>;
executeUpdateTool: (...args: [...Parameters<ToolDefinition<typeof PlanUpdateParams, PlanToolDetails>["execute"]>, onUserAttention?: UserAttentionHandler]) => ReturnType<ToolDefinition<typeof PlanUpdateParams, PlanToolDetails>["execute"]>;
executeReviewTool: (...args: [...Parameters<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>, onUserAttention?: UserAttentionHandler]) => ReturnType<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>;
executeConfirmTool: (...args: [...Parameters<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>, onUserAttention?: UserAttentionHandler]) => ReturnType<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>;
executeDecomposeTool: (...args: [...Parameters<ToolDefinition<typeof PlanDecomposeParams, PlanToolDetails>["execute"]>, onUserAttention?: UserAttentionHandler]) => ReturnType<ToolDefinition<typeof PlanDecomposeParams, PlanToolDetails>["execute"]>;
executeExitTool: (...args: [...Parameters<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>, onUserAttention?: UserAttentionHandler]) => ReturnType<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>;
executeStatusTool: (...args: [...Parameters<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>, onUserAttention?: UserAttentionHandler]) => ReturnType<ToolDefinition<typeof EmptyPlanParams, PlanToolDetails>["execute"]>;
executePlanCommand(args: string, ctx: PlanContext): Promise<void>;
}
