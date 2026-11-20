/** External Maestro knowledge response contracts; versions not present in receipts remain unknown. */
export type KnowledgeDisposition =
  | "unique"
  | "exact_duplicate"
  | "semantic_duplicate"
  | "extends"
  | "related"
  | "potential_conflict"
  | "supersede_candidate";

export type KnowledgePromotionEligibility = "eligible" | "suppressed" | "review_required";

export type KnowledgeFreshness = "fresh" | "stale" | "missing" | "blocked";

export type KnowledgeCandidateAction = "propose" | "reaffirm" | "supersede" | "contest";

export type KnowledgeCandidateStatus = "pending" | "promoting" | "promoted" | "rejected";

export interface KnowledgeInputTotals {
  consumed: number;
  cited: number;
  validated: number;
  contradicted: number;
}

export interface KnowledgeReconciliationMatch {
  knowledge_id: string;
  target: "spec" | "knowhow";
  title: string;
  relation: Exclude<KnowledgeDisposition, "unique">;
  scores: {
    composite: number;
    semantic: number;
    lexical: number;
  };
  novelty: number;
  evidence: string[];
  source_path: string;
  source_line: number | null;
}

export interface KnowledgeCandidateReconciliation {
  candidate_id: string;
  disposition: KnowledgeDisposition;
  promotion_eligibility: KnowledgePromotionEligibility;
  canonical_id: string | null;
  matches: KnowledgeReconciliationMatch[];
  freshness: KnowledgeFreshness;
}

export interface ReviewCandidate {
  candidate_id: string;
  target: "spec" | "knowhow";
  action: KnowledgeCandidateAction;
  title: string;
  content: string;
  category: string | null;
  source_kind: "decision" | "constraint" | "manual";
  occurrences: number;
  first_recorded_at: string;
  last_recorded_at: string;
  status: KnowledgeCandidateStatus;
  run_ids: string[];
  stage: "observed" | "corroborated";
  reconciliation: KnowledgeCandidateReconciliation | null;
  review: {
    freshness: KnowledgeFreshness;
    reconcile_commands: string[];
    resolution_commands: string[];
    /** Present when the candidate failed immutable-source revalidation. */
    blocked_reason?: string;
  };
}

export interface KnowledgeReviewView {
  schema_version: string;
  session_id: string;
  run_count: number;
  ledger_count: number;
  input_totals: KnowledgeInputTotals;
  /** Signal totals by attribution source; absent on older CLIs. */
  input_totals_by_source?: Record<string, KnowledgeInputTotals>;
  /** Knowledge-id attribution detail in ledger order; absent on older CLIs. */
  inputs?: Array<{
    run_id: string;
    knowledge_id: string;
    signal: string;
    source: string;
    count: number;
    evidence?: string[];
  }>;
  unique_inputs: number;
  candidates: ReviewCandidate[];
}

export interface KnowledgeSpecHealth {
  total: number;
  active: number;
  deprecated: number;
  contested: number;
  chains: number;
  danglingSupersedes: string[];
  danglingSupersededBy: string[];
  cyclicSids: string[];
  avgFreshness: number;
  staleActive: number;
}

export interface KnowledgeKnowhowHealth {
  total: number;
  active: number;
  deprecated: number;
  invalid: number;
}

export interface KnowledgeUsageBySource {
  sourceType: string;
  nodes: number;
  impressions: number;
  consumptions: number;
}

export interface KnowledgeConcentration {
  positiveNodes: number;
  totalEvents: number;
  top1Share: number;
  gini: number;
  hhi: number;
  effectiveNodes: number;
}

export interface KnowledgeAuditFinding {
  id: string;
  store: string;
  priority: string;
  subtype: string;
  target: string;
  evidence: string;
  recommended_action: string;
}

export interface KnowledgeAudit {
  schema_version: string;
  scope: string;
  generated_at: string;
  spec_health: KnowledgeSpecHealth;
  knowhow: KnowledgeKnowhowHealth;
  usage: {
    bySource: KnowledgeUsageBySource[];
    impressionConcentration: KnowledgeConcentration;
    consumptionConcentration: KnowledgeConcentration;
  };
  findings: KnowledgeAuditFinding[];
  prune_plan: unknown[];
}

export type KnowledgeResolutionChoice = "duplicate" | "related" | "conflict" | "supersede" | "unique";

export interface KnowledgePromoteResult {
  promoted: Array<{ candidate_id: string; promoted_id: string; target: string; outcome: string }>;
  already_promoted: Array<{ candidate_id: string }>;
  skipped_observed: Array<{ candidate_id: string }>;
  skipped_review_required: Array<{ candidate_id: string }>;
  skipped_suppressed: Array<{ candidate_id: string }>;
}

export interface KnowledgeRecordOptions {
  /** Knowledge IDs to attribute. */
  knowledgeIds: readonly string[];
  signal?: "consumed" | "cited" | "validated" | "contradicted";
  source?: "search" | "load" | "manual";
  /** Optional evidence anchors (artifact/output/test refs). */
  evidence?: readonly string[];
  /** Active Run that owns the attribution; omit to target the unique active Run. */
  runId?: string;
  /** Explicit Session ID (session-source authority; usable without runId). */
  sessionId?: string;
}

export interface KnowledgeRecordResult {
  session_id: string;
  run_id: string;
  recorded: number;
}

export interface KnowledgeStageOptions {
  /** Candidate target corpus: spec or knowhow. */
  target: "spec" | "knowhow";
  title: string;
  content: string;
  /** Active Run that owns the staged candidate; omit to target the unique active Run. */
  runId?: string;
  /** Explicit Session ID (session-source authority; usable without runId). */
  sessionId?: string;
  action?: KnowledgeCandidateAction;
  category?: string | null;
  /** Optional knowledge signal recorded alongside the candidate (attribution). */
  signal?: "consumed" | "cited" | "validated" | "contradicted";
  signalIds?: readonly string[];
  evidence?: readonly string[];
  /**
   * K13/K14: transcript quote JSON string
   * `{host_kind, host_session_id, entry_id, quote}`（见 src/knowledge/extractor.ts）。
   * stage 时以 `--transcript-quote <path>` 传给 CLI。当前 defaultRunner 以
   * stdio:["ignore",...] 拉起子进程（无 stdin 注入），故 JSON 写入临时文件后传
   * 文件路径——quote 内容不进进程 argv（K13：原始片段不得进进程列表）。
   */
  transcriptQuote?: string;
  /**
   * K13/K14: 已存在的 transcript quote JSON 文件路径，原样经
   * `--transcript-quote <path>` 透传（不新建临时文件）。
   */
  transcriptQuoteFile?: string;
  /** Host-validated private execution authority descriptor for external writes. */
  executionAuthorityFile?: string;
}

export interface KnowledgeStageResult {
  session_id: string;
  run_id?: string;
  origin?: "run" | "session";
  candidate_id: string;
  signal_recorded: number;
}

export interface KnowledgeSearchOptions {
  kind?: "spec" | "knowhow";
  limit?: number;
  signal?: AbortSignal;
}

export interface KnowledgeSearchResult {
  query: string;
  count: number;
  results: unknown[];
  [key: string]: unknown;
}

export interface KnowledgeLoadResult {
  id: string;
  kind: "spec" | "knowhow";
  content: string;
}

export interface KnowledgeResolveOptions {
  as: KnowledgeResolutionChoice;
  target?: string;
  reason: string;
  /** Cancels the owned Maestro CLI process tree. */
  signal?: AbortSignal;
}

export interface ResolveManyItem extends KnowledgeResolveOptions {
  candidateId: string;
}

export interface ResolveManyResult {
  resolved: number;
  failed: Array<{ candidateId: string; error: string }>;
}

