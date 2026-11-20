export declare function truncate(s: string, max: number): string;
export declare function capList(items: string[], n?: number): string;
export interface BoundaryContractInput {
    in_scope: string[];
    out_of_scope: string[];
    constraints: string[];
    definition_of_done: string;
}
export interface ProgressStep {
    step_id: string;
    command: string;
    stage: string | null;
    summary: string | null;
    caveats: string | null;
}
export interface ProgressInput {
    recent: ProgressStep[];
    done_count: number;
    pending_count: number;
}
export interface SignalsInput {
    caveats: string[];
    deferred: string[];
}
export declare function buildIntentSection(intent: string): string | null;
export declare function buildBoundaryContractSection(bc: BoundaryContractInput): string | null;
export declare function buildProgressSection(progress: ProgressInput): string | null;
export declare function buildSignalsSection(signals: SignalsInput): string | null;
export interface EnvelopeInput {
    sessionId: string;
    /** Pre-ordered section strings; null/empty entries are dropped. */
    sections: Array<string | null>;
    /** Completion verb wired into the read-only guardrail comment. */
    completionVerb: (n: string) => string;
}
/**
 * Wraps ordered section strings in the `<session_anchor>` frame plus the
 * read-only guardrail comment. Returns null when no section survives (matching
 * the legacy behaviour where an empty intent suppresses the whole anchor — the
 * caller drops the intent section, leaving nothing to wrap).
 */
export declare function buildEnvelope(input: EnvelopeInput): string | null;
