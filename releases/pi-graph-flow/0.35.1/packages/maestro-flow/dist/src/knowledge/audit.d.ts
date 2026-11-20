import { type KnowledgeUsageStats } from '../graph/kg/knowledge-usage.js';
import { type SpecHealthReport } from '../tools/spec-conflict-marker.js';
import { type KnowledgeCompatibilityReport } from './normalize.js';
export type KnowledgeAuditScope = 'spec' | 'knowhow' | 'all';
export interface KnowledgeAuditFinding {
    id: string;
    store: 'spec' | 'knowhow' | 'pipeline' | 'usage';
    priority: 'P0' | 'P1' | 'P2';
    subtype: string;
    target: string;
    evidence: string;
    recommended_action: 'observe' | 'review' | 'deprecate';
}
export type KnowledgePruneAction = {
    id: string;
    store: 'spec';
    action: 'deprecate';
    target_id: string;
    target_file: string;
    successor_id: string;
    successor_file: string;
    reason: 'unsynchronized-supersession' | 'exact-duplicate';
} | {
    id: string;
    store: 'knowhow';
    action: 'supersede';
    target_id: string;
    target_file: string;
    successor_id: string;
    successor_file: string;
    reason: 'exact-duplicate';
};
export interface KnowledgeAuditResult {
    schema_version: 'knowledge-audit/1.0';
    scope: KnowledgeAuditScope;
    generated_at: string;
    spec_health: SpecHealthReport | null;
    knowhow: {
        total: number;
        active: number;
        deprecated: number;
        invalid: number;
    } | null;
    usage: KnowledgeUsageStats | null;
    pipeline: {
        sessions: number;
        ledgers: number;
        pending_observed: number;
        pending_corroborated: number;
        promoted: number;
    };
    findings: KnowledgeAuditFinding[];
    prune_plan: KnowledgePruneAction[];
    compatibility: KnowledgeCompatibilityReport;
    safety: {
        usage_only_never_pruned: true;
        physical_delete: false;
        diagnostics_read_only: true;
        normalization_requires_prior_report: true;
    };
}
export declare function auditKnowledge(projectRootInput: string, options?: {
    scope?: KnowledgeAuditScope;
    prune?: boolean;
}): Promise<KnowledgeAuditResult>;
//# sourceMappingURL=audit.d.ts.map