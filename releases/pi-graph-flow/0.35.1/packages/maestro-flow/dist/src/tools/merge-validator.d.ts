export interface MergeValidation {
    phase_completeness: boolean;
    state_consistency: boolean;
    artifact_integrity: boolean;
    dependency_check: boolean;
}
export interface MergeValidationResult {
    valid: boolean;
    checks: MergeValidation;
    errors: string[];
    warnings: string[];
}
export declare function validateMergeReadiness(worktreePath: string, mainPath: string, milestoneNum: number, opts?: {
    force?: boolean;
}): MergeValidationResult;
//# sourceMappingURL=merge-validator.d.ts.map