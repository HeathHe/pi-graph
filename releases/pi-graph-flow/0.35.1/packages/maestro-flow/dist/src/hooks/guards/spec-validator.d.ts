/**
 * Spec Validator Guard — PreToolUse: Write
 *
 * Validates that spec file entries use the <spec-entry> closed-tag format.
 * Pure evaluation function — no I/O, follows workflow-guard.ts pattern.
 *
 * Only activates when the file path targets .workflow/specs/.
 */
export interface SpecValidatorResult {
    valid: boolean;
    mode: 'warn' | 'block';
    errors: Array<{
        line: number;
        message: string;
    }>;
}
/**
 * Evaluate spec file content for format compliance.
 *
 * @param filePath  Absolute or relative file path being written
 * @param content   The full file content after the write/edit
 * @param mode      'warn' (advisory) or 'block' (reject write)
 */
export declare function evaluateSpecValidator(filePath: string, content: string, mode?: 'warn' | 'block'): SpecValidatorResult;
//# sourceMappingURL=spec-validator.d.ts.map