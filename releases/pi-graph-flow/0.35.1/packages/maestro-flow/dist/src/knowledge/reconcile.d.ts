import { type KnowledgePromotionResult, type PromoteSessionKnowledgeOptions, type RunKnowledgeDelta } from '../run/knowledge.js';
import type { ReportFrontmatter } from '../run/schemas.js';
import { SessionStore, type StoreTransaction } from '../run/store.js';
import { type KnowledgeCandidateReconciliation, type KnowledgeDisposition, type KnowledgePromotionEligibility, type KnowledgeReconciliation } from './reconciliation-schema.js';
export { knowledgeCandidateReconciliationSchema, knowledgeReconciliationMatchSchema, knowledgeReconciliationSchema, } from './reconciliation-schema.js';
export type { KnowledgeCandidateReconciliation, KnowledgeDisposition, KnowledgePromotionEligibility, KnowledgeReconciliation, } from './reconciliation-schema.js';
interface ReconcileOptions {
    embeddingScores?: Map<string, Map<string, number>>;
    retrievalMode?: 'lexical-kg' | 'hybrid';
    embeddingUsed?: boolean;
    prior?: KnowledgeReconciliation | null;
}
export declare function knowledgeCandidateSnapshotHash(delta: RunKnowledgeDelta, frontmatter: ReportFrontmatter, runId: string): string;
export declare function reconciliationPath(store: SessionStore, sessionId: string, runId: string): string;
export declare function readKnowledgeReconciliation(store: SessionStore, sessionId: string, runId: string, readOnly?: boolean): KnowledgeReconciliation | null;
export declare function reconcileRunKnowledgeSync(projectRoot: string, sessionId: string, runId: string, frontmatter: ReportFrontmatter, options?: ReconcileOptions): KnowledgeReconciliation;
export declare function reconcileRunKnowledge(projectRoot: string, sessionId: string, runId: string, options?: {
    timeoutMs?: number;
}): Promise<KnowledgeReconciliation>;
export declare function isKnowledgeReconciliationFresh(projectRoot: string, sessionId: string, runId: string, receipt: KnowledgeReconciliation, frontmatter: ReportFrontmatter, expectedCorpusFingerprint?: string): boolean;
export declare function currentKnowledgeCorpusFingerprint(projectRoot: string): string;
export declare function ensureKnowledgeReconciliation(projectRoot: string, sessionId: string, runId: string, frontmatter: ReportFrontmatter, expectedCorpusFingerprint?: string): KnowledgeReconciliation;
export declare function writeKnowledgeReconciliation(store: SessionStore, tx: StoreTransaction, receipt: KnowledgeReconciliation): void;
export declare function persistActiveKnowledgeReconciliation(projectRoot: string, receipt: KnowledgeReconciliation): void;
export declare function persistKnowledgeReconciliation(projectRoot: string, receipt: KnowledgeReconciliation): void;
export declare function reconcileSessionKnowledgeSync(projectRoot: string, sessionId: string, options?: ReconcileOptions): KnowledgeReconciliation;
export declare function isSessionKnowledgeReconciliationFresh(projectRoot: string, sessionId: string, receipt: KnowledgeReconciliation, expectedCorpusFingerprint?: string, lockedStore?: SessionStore): boolean;
export declare function ensureSessionKnowledgeReconciliation(projectRoot: string, sessionId: string, expectedCorpusFingerprint?: string): KnowledgeReconciliation;
export declare function writeSessionKnowledgeReconciliation(store: SessionStore, tx: StoreTransaction, receipt: KnowledgeReconciliation): void;
export declare function persistSessionKnowledgeReconciliation(projectRoot: string, receipt: KnowledgeReconciliation): void;
/**
 * Refresh selected Run-source receipts, then validate the existing
 * session-source receipt before invoking the lower-level promotion
 * transaction. A session receipt is never regenerated during promotion:
 * candidate/evidence/corpus drift forces explicit review again.
 */
export declare function promoteReconciledSessionKnowledge(projectRoot: string, sessionId: string, options: PromoteSessionKnowledgeOptions): KnowledgePromotionResult;
export type KnowledgeResolutionChoice = 'duplicate' | 'related' | 'conflict' | 'supersede' | 'unique';
export interface ResolveKnowledgeCandidateResult {
    schema_version: 'knowledge-resolution-result/1.0';
    session_id: string;
    candidate_id: string;
    disposition: KnowledgeDisposition;
    promotion_eligibility: KnowledgePromotionEligibility;
    canonical_id: string | null;
    affected_runs: string[];
    conflict_marked: boolean;
}
export interface ResolveKnowledgeCandidateOptions {
    targetId?: string;
    reason: string;
    /** Internal origin selector used to fan a bare candidate ID across K7 origins. */
    _origin?: 'run' | 'session';
    /** Avoid marking the same corpus conflict twice during cross-origin fan-out. */
    _skipConflictMark?: boolean;
}
export declare function resolveKnowledgeCandidate(projectRoot: string, sessionId: string, candidateId: string, choice: KnowledgeResolutionChoice, options: ResolveKnowledgeCandidateOptions): ResolveKnowledgeCandidateResult;
export declare function reconciliationForCandidate(projectRoot: string, sessionId: string, runIds: string[], candidateId: string): KnowledgeCandidateReconciliation[];
export declare function applyAutomaticKnowledgeSuppression(delta: RunKnowledgeDelta | null, receipt: KnowledgeReconciliation): void;
export declare function reconciliationSummary(receipt: KnowledgeReconciliation): {
    schema_version: 'knowledge-reconciliation-receipt/1.0';
    candidate_snapshot_hash: string;
    corpus_fingerprint: string;
    retrieval_mode: 'lexical-kg' | 'hybrid';
    candidates: number;
    duplicates: number;
    conflicts: number;
    review_required: number;
    suppressed: number;
    review_command: string;
};
export declare function projectedCandidateId(target: 'spec' | 'knowhow', content: string): string;
//# sourceMappingURL=reconcile.d.ts.map