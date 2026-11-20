import type { MaterialReviewInput } from "../verification/material-review.ts";
import type { TaskAcceptanceReport } from "./acceptance.ts";
import type { TodoSkillLoader } from "../skills/skill-loader.ts";
import type { TodoSkillBinding } from "../skills/skill-composer.ts";
import type { SkillActivationMetadata } from "../skills/skill-runtime.ts";
import type { TodoTaskOrigin } from "../session/types.ts";
import type { TodoHandoff, TodoHandoffInput, TodoAdvanceTransition, TodoUpdateField, TodoGetField } from "../tools/todo-contract.ts";
export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "deleted";

export interface TodoActorRef {
  kind: "root" | "teammate";
  id: string;
  label: string;
  agentType?: string;
}

export const ROOT_TODO_ACTOR: TodoActorRef = Object.freeze({
  kind: "root",
  id: "root",
  label: "root",
});

export type { TodoSkillBinding, TodoSkillRole } from "../skills/skill-composer.ts";

export interface TodoTask {
  replacementPendingId?: string;
  supersededByGroupId?: string;
  supersessionId?: string;
  /** Projection only; historical status/report remain in the journal. Never grants acceptance. */
  reviewRequired?: boolean;
  dispatchSubmissionId?: string;
  taskInstanceId?: string;
  contractVersion?: number;
  contractDigest?: string;
  contractDependencies?: string[];
  acceptanceCriteria?: string[];
  acceptanceReport?: TaskAcceptanceReport;
  verifiedQualityGateId?: string;
  deliveryGroupId?: string;
  deliveryGoalId?: string;
  skipResolution?: { policy: string; report: TaskAcceptanceReport };
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  context?: string;
  skills: TodoSkillBinding[];
  resourceUris: string[];
  handoff?: TodoHandoff;
  skillActivation?: SkillActivationMetadata;
  summary?: string;
  origin?: TodoTaskOrigin;
  planHandoffKey?: string;
  goalId?: string;
  createdBy: TodoActorRef;
  assignee: TodoActorRef;
  createdAt: number;
  updatedAt: number;
  activeStartedAt?: number;
  activeDurationMs?: number;
  completedAt?: number;
}

export interface TodoBatchSpec {
  acceptanceCriteria?: string[];
  optional?: boolean;
  skipPolicy?: string;
  subject: string;
  description?: string;
  context?: string;
  skills?: TodoSkillBinding[];
  resourceUris?: string[];
  handoff?: TodoHandoffInput;
  assignee?: string;
  blockedBy?: number[];
  goalId?: string;
}

export interface TodoUpdateSpec {
  restoreExecution?: boolean;
  acceptanceCriteria?: string[];
  review?: MaterialReviewInput;
  skip?: boolean;
  id: string;
  subject?: string;
  description?: string;
  status?: TaskStatus;
  blockedBy?: string[];
  context?: string;
  skills?: TodoSkillBinding[] | null;
  summary?: string;
  resourceUris?: string[];
  handoff?: TodoHandoffInput;
  updateFields?: TodoUpdateField[];
  assignee?: string;
  goalId?: string;
}

export interface TodoParams {
  includeHistory?: boolean;
  atClear?: string;
  replacePlan?: import("./plan-replacement.ts").ReplacePlanInput;
  restoreExecution?: boolean;
  acceptanceCriteria?: string[];
  review?: MaterialReviewInput;
  deliveryGoalId?: string;
  completeGroup?: boolean;
  skip?: boolean;
  action: "create" | "update" | "list" | "get" | "delete" | "clear" | "next" | "advance";
  subject?: string;
  description?: string;
  status?: TaskStatus;
  blockedBy?: string[];
  context?: string;
  skills?: TodoSkillBinding[] | null;
  summary?: string;
  resourceUris?: string[];
  handoff?: TodoHandoffInput;
  transition?: TodoAdvanceTransition;
  updateFields?: TodoUpdateField[];
  id?: string;
  field?: TodoGetField;
  offset?: number;
  limit?: number;
  ids?: string[];
  updates?: TodoUpdateSpec[];
  assignee?: string;
  tasks?: TodoBatchSpec[];
  filter?: { status?: TaskStatus; memberId?: string };
  planHandoffKey?: string;
  goalId?: string;
}

/**
 * Slim per-task projection carried in every Todo tool result. Deliberately
 * excludes heavy fields (description, context, skills, activation metadata):
 * results are rendered as status counts and may be serialized into session
 * history or forwarded over the teammate broker, so each entry must stay
 * cheap. Full task state is available via `getVisibleTasks()`/`get`.
 */
export interface TodoTaskSnapshot {
  reviewRequired?: boolean;
  resolution?: "skipped";
  id: string;
  subject: string;
  status: TaskStatus;
  assignee: TodoActorRef;
  blockedBy?: string[];
  summary?: string;
  durationMs?: number;
  completedAt?: number;
}

export interface TodoResultDetails {
  action: string;
  tasks: TodoTaskSnapshot[];
  displayTaskIds?: string[];
  /** Request-only transition receipt emitted after a successful completion-form advance or active update. */
  transition?: TodoAdvanceTransition;
  /** Extension scheduler outcome; never persisted in Todo state. */
  contextTransition?: "scheduled" | "coalesced" | "failed";
  contextTransitionRequestId?: number;
  contextTransitionError?: string;
  error?: string;
}

export interface TodoCompactionSnapshot {
  stateVersion: number;
  revision: number;
  activeTaskId?: string;
  tasks: TodoTask[];
}

export interface TodoMirrorReconcileResult {
  created: string[];
  updated: string[];
  tombstoned: string[];
  unchanged: string[];
}

export interface TodoContext {
  cwd: string;
  ui: {
    setStatus: (key: string, value: string | undefined) => void;
  };
  sessionManager?: unknown;
  skillLoader?: TodoSkillLoader;
}

