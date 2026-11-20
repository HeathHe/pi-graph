import { type KnowledgeCandidate, type KnowledgeInputSignal, type KnowledgeInputSource, type SessionKnowledgeDelta } from './knowledge.js';
import { SessionStore } from './store.js';
/**
 * Mutate the Session-level knowledge sidecar atomically under the store lock.
 * Legacy 1.x Sessions retain their running/paused mutation guard. Canonical
 * session/2.0 has no Session status; immutable candidate source snapshots are
 * the authority fence for its session-source candidate writes.
 */
export declare function updateSessionKnowledgeSidecar<T>(projectRoot: string, sessionId: string, mutator: (draft: SessionKnowledgeDelta, source: {
    schemaVersion: string;
    activityRevision: number;
    store: SessionStore;
}) => T): T;
export declare const SYNTHETIC_SESSION_PREFIX = "ksyn-";
/**
 * Deterministic synthetic Session ID: ksyn-<sha256(host|project|date)[:16]>.
 * Date partitioning rotates identity daily so there is no need for an
 * abandon/cleanup lifecycle (MVP-cut decision). Host identifiers are hash
 * inputs only — they never become Session-directory names (S4).
 */
export declare function syntheticKnowledgeSessionId(host: string, projectRoot: string, date?: Date): string;
/**
 * Idempotently ensure the synthetic knowledge Session for (host, project,
 * today) exists. Reuses the existing Session bundle when present.
 */
export declare function ensureSyntheticKnowledgeSession(projectRoot: string, host: string): {
    sessionId: string;
    created: boolean;
};
/**
 * Stage a candidate on the Session-level ledger (origin=session).
 * Session-source candidates require non-empty evidence (S2/K5 precondition).
 */
export declare function stageSessionKnowledgeCandidate(projectRoot: string, sessionId: string, input: {
    target: KnowledgeCandidate['target'];
    action?: KnowledgeCandidate['action'];
    title: string;
    content: string;
    category?: string | null;
    evidenceRefs?: string[];
    repository?: string;
    keywords?: string[];
    sourceRef?: string | null;
    relatedPaths?: string[];
    appliesToRepoIds?: string[];
    type?: string | null;
    language?: string | null;
    decisionState?: string | null;
    lifecycleStatus?: string | null;
    tool?: boolean;
}): {
    session_id: string;
    candidate_id: string;
    origin: 'session';
};
/**
 * Record explicit knowledge attribution on the Session-level ledger.
 */
export declare function recordSessionKnowledgeInputs(projectRoot: string, sessionId: string, knowledgeIds: string[], signal?: KnowledgeInputSignal, source?: KnowledgeInputSource, evidence?: readonly string[]): {
    session_id: string;
    recorded: number;
    origin: 'session';
};
//# sourceMappingURL=session-knowledge.d.ts.map