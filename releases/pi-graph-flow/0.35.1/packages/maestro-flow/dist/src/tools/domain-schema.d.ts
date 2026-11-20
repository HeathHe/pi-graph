/**
 * Domain Schema — runtime validation for glossary.yaml (or .json fallback)
 */
export interface ValidationError {
    path: string;
    message: string;
}
export interface ValidationWarning {
    termId: string;
    kind: 'cycle' | 'dangling';
    message: string;
}
export declare function validateGlossary(data: unknown): ValidationError[];
export declare function validateRelationships(terms: Array<{
    id: string;
    relationships?: string[];
}>): ValidationWarning[];
//# sourceMappingURL=domain-schema.d.ts.map