import type { GoalBudgetView } from "./budget-view.ts";
/** Goal types owner. Public compatibility entry: tools/goal.ts. */
import type { GoalDeliveryState } from "./delivery.ts";
import type { MaterialReviewInput, MaterialReviewReport } from "../verification/material-review.ts";
import type { GoalEvidenceRef } from "../tools/goal-evidence.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowCoordinator } from "../session/coordinator.ts";
import type { GoalPauseReason } from "../tui/goal-widget.ts";
import type { AssistantMessageLike, GoalVerificationClassification } from "../tools/goal-verification.ts";

// Pure shared marker value; continuation must not evaluate a partial
// presentation export during the Goal/Todo import cycle.
export const CONTINUATION_MARKER_PREFIX = "maestro-goal-continuation:";

export type GoalStatus = "active" | "paused" | "done";

export type PauseReason = GoalPauseReason;

export interface GoalCompactionEntry {
  id: string;
  objective: string;
  status: GoalStatus;
  pauseReason?: PauseReason;
  iteration: number;
  /** Parent-session telemetry only; budgetView is the shared-budget read model. */
  tokensUsed: number;
  budgetView?: GoalBudgetView;
  tokenBudget?: number;
  verificationFailures?: number;
  infraErrorStreak?: number;
  failStreak?: number;
  lastVerificationClassification?: GoalVerificationClassification;
  lastMissingEvidenceFingerprint?: string;
  lastVerificationFailure?: string;
  acceptance?: string[];
  planHandoffKey?: string;
  workflowSessionId?: string;
}

export interface GoalCompactionSnapshot {
  stateVersion: number;
  currentGoalId?: string;
  goals: GoalCompactionEntry[];
}

export interface ActiveGoal {
  planContractEpoch?: number;
  planReplacement?: { version: 1; id: string; fromGroupId: string; toGroupId: string; fromPlanHandoffKey: string; toPlanHandoffKey: string; taskStateDigest: string; contractEpoch: number };
  delivery?: GoalDeliveryState;
  verificationMode?: "root-review" | "role";
  businessReview?: MaterialReviewReport;
  verifiedGroupDigest?: string;
  verdictDigest?: string;
  id: string;
  text: string;
  status: GoalStatus;
  pauseReason?: PauseReason;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  tokenBudget?: number;
  /** Parent-session telemetry only; budgetView is the shared-budget read model. */
  tokensUsed: number;
  timeUsedSeconds: number;
  baselineTokens: number;
  workflowSessionId?: string;
  planHandoffKey?: string;
  workflowSessionGeneration?: string;
  supersededByGoalId?: string;
  verificationFailures?: number;
  /**
   * Consecutive verifier *infrastructure* errors, counted separately from
   * verificationFailures so an unreachable verifier never spends the Goal's own
   * failure budget — while still being bounded. Reset by any verdict that made it
   * out of the verifier, and by resume.
   */
  infraErrorStreak?: number;
  /**
   * Fail verdicts since the last resume, bounded separately from
   * verificationFailures (which tracks inconclusive results): a fail carries
   * actionable unmet feedback, so it earns a wider bound — but not an unbounded
   * one.
   */
  failStreak?: number;
  lastVerificationClassification?: GoalVerificationClassification;
  lastMissingEvidenceFingerprint?: string;
  lastVerificationFailure?: string;
  acceptance?: string[];
  prevTokensUsed?: number;
  budgetProgressCursor?: string;
  lowProgressCount?: number;
}

export interface ContinuationPending {
  goalId: string;
  iteration: number;
  marker: string;
}

export interface GoalContext {
  cwd: string;
  model?: ExtensionContext["model"];
  ui: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
    setWidget?: ExtensionContext["ui"]["setWidget"];
  };
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  abort?: () => void;
  sessionManager?: unknown;
}

export interface GoalGetParams {
  action: "get";
}

export interface GoalCreateParams {
  verificationMode?: "root-review" | "role";
  action: "create";
  objective: string;
  tokenBudget?: string;
  planHandoffKey?: string;
  acceptance?: string[];
}

export interface GoalUpdateParams {
  verificationMode?: "root-review" | "role";
  action: "update";
  objective: string;
  acceptance?: string[];
}

export interface GoalCompleteParams { action: "complete"; summary: string; evidenceRefs?: GoalEvidenceRef[]; review?: MaterialReviewInput; }

export type GoalParams = GoalGetParams | GoalCreateParams | GoalUpdateParams | GoalCompleteParams;

export type GoalCommandParams =
  | { action: "status" }
  | { action: "create"; objective: string; tokenBudget?: string }
  | { action: "stop" }
  | { action: "resume"; tokenBudget?: string }
  | { action: "clear" };

/** Internal storage schema; only state.ts owns an instance. */
export interface GoalOwnerState {
activeGoal: ActiveGoal | undefined;
stagedActiveGoal: ActiveGoal | undefined;
goalRegistry: ActiveGoal[];
pendingTodoDetachGoalIds: string[];
extensionApi: ExtensionAPI | undefined;
onGoalStateChanged: (() => void) | undefined;
goalPanelOwnedExternally: boolean;
goalDisplayContext: GoalContext | undefined;
baseCwd: string;
continuationPending: ContinuationPending | undefined;
suspendedContinuation: ContinuationPending | undefined;
compactionInFlight: boolean;
goalRecovery: {
  goalId: string;
  kind: "compaction_retry" | "provider_retry";
  attempt?: number;
  maxRetries?: number;
} | undefined;
latestGoalAttempt: {
  goalId: string;
  epoch: number;
  assistant?: AssistantMessageLike;
} | undefined;
completionTimer: ReturnType<typeof setTimeout> | undefined;
verificationInFlight: { goalId: string; updatedAt: number; epoch: number } | undefined;
goalLifecycleEpoch: number;
goalOwnerInstanceId: string;
goalSessionId: string | undefined;
goalLoopOwner: { goalId: string; epoch: number } | undefined;
workflowCoordinator: WorkflowCoordinator | undefined;
elapsedTimer: ReturnType<typeof setInterval> | undefined;
goalStaticMode: boolean;
disposeFailoverTerminal: (() => void) | undefined;
issuedGoalMarkers: Set<string>;
}

/** Upward business callbacks supplied by lifecycle composition, never parallel owners. */
export interface GoalCompletionPort { commitVerifiedCompletion(goal: ActiveGoal, ctx: GoalContext): "done" | "awaiting-reply"; }
export interface GoalFinalReplyPort { commitFinalMainReply(ctx: GoalContext, scope: object): Promise<void>; }
