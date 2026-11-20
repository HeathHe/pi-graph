import type { KgQueryBuilder } from '../db/queries.js';
import type { UnifiedEdge } from '../db/types.js';
export interface CodeStructuralResolutionResult {
    referencesReset: number;
    resolved: number;
    ambiguous: number;
    notFound: number;
    edgesCreated: number;
    edges: UnifiedEdge[];
    durationMs: number;
}
/** Runs inside the caller-owned transaction and recomputes every stored fact. */
export declare function resolveCodeStructuralReferences(queries: KgQueryBuilder, now?: number): CodeStructuralResolutionResult;
//# sourceMappingURL=code-reference-resolver.d.ts.map