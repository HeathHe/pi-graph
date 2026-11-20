export type KnowledgeNormalizeScope = 'spec' | 'knowhow' | 'all';
export interface KnowledgeCompatibilityEntry {
    store: 'spec' | 'knowhow';
    file: string;
    entry: string;
    states: string[];
    normalizable: boolean;
}
export interface KnowledgeRepositoryDiagnostic {
    relation: 'current' | 'linked';
    alias: string;
    path: string;
    repo_id: string | null;
    cached_repo_id: string | null;
    identity_persisted: boolean;
    valid: boolean;
    read: string[];
    write: string[];
    error?: string;
}
export interface PendingCrossRepoPromotion {
    session_id: string;
    candidate_id: string;
    target: 'spec' | 'knowhow';
    status: string;
    source_repo_id: string;
    target_repo_id: string;
    target_alias_snapshot: string;
}
export interface KnowledgeCompatibilityReport {
    schema_version: 'knowledge-compatibility-audit/1.0';
    current_repository: KnowledgeRepositoryDiagnostic;
    linked_repositories: KnowledgeRepositoryDiagnostic[];
    entries: KnowledgeCompatibilityEntry[];
    pending_cross_repo_promotions: PendingCrossRepoPromotion[];
    counts: Record<string, number>;
}
export interface KnowledgeNormalizationAction {
    file: string;
    store: 'spec' | 'knowhow';
    before_sha256: string;
    after_sha256: string;
    changes: string[];
    blocked: string[];
}
export interface KnowledgeNormalizationReport {
    schema_version: 'knowledge-normalization-report/1.0';
    mode: 'dry-run';
    project_root: string;
    repo_id: string | null;
    scope: KnowledgeNormalizeScope;
    source_fingerprint: string;
    generated_at: string;
    actions: KnowledgeNormalizationAction[];
    unresolved: KnowledgeCompatibilityEntry[];
    safety: {
        report_required_before_apply: true;
        automatic_bulk_rewrite: false;
        backup_before_write: true;
    };
}
export interface KnowledgeNormalizationApplyResult {
    schema_version: 'knowledge-normalization-apply-result/1.0';
    applied: number;
    backup_dir: string | null;
    report_fingerprint: string;
    unresolved: number;
}
export declare function inspectKnowledgeCompatibility(projectRootInput: string, scope?: KnowledgeNormalizeScope): KnowledgeCompatibilityReport;
export declare function planKnowledgeNormalization(projectRootInput: string, scope?: KnowledgeNormalizeScope): KnowledgeNormalizationReport;
export declare function writeKnowledgeNormalizationReport(pathInput: string, report: KnowledgeNormalizationReport): void;
export declare function applyKnowledgeNormalization(projectRootInput: string, reportPathInput: string): KnowledgeNormalizationApplyResult;
export declare function isExactRepositoryId(value: string): boolean;
//# sourceMappingURL=normalize.d.ts.map