export declare const STRUCTURAL_REFERENCE_STATUSES: readonly ["pending", "resolved", "ambiguous", "not_found"];
export type StructuralReferenceStatus = (typeof STRUCTURAL_REFERENCE_STATUSES)[number];
export declare const STRUCTURAL_RELATION_HINTS: readonly ["inherits-or-conforms", "extends", "implements", "decorates", "contains-owner"];
export type StructuralRelationHint = (typeof STRUCTURAL_RELATION_HINTS)[number];
export type StructuralTypeRelationHint = Exclude<StructuralRelationHint, 'contains-owner'>;
export type StructuralEdgeOrientation = 'anchor-to-target' | 'target-to-anchor';
export declare const STRUCTURAL_LOOKUP_SCOPES: readonly ["file", "module", "project", "external", "project-and-external"];
export type StructuralLookupScope = (typeof STRUCTURAL_LOOKUP_SCOPES)[number];
export declare const STRUCTURAL_TARGET_KIND_HINTS: readonly ["module", "class", "struct", "interface", "trait", "protocol", "enum", "type_alias", "namespace"];
export type StructuralTargetKindHint = (typeof STRUCTURAL_TARGET_KIND_HINTS)[number];
export declare const STRUCTURAL_LANGUAGE_HINTS: readonly ["typescript", "javascript", "tsx", "jsx", "python", "go", "rust", "java", "c", "cpp", "csharp", "php", "ruby", "swift", "kotlin", "dart", "svelte", "vue", "liquid", "pascal", "scala", "lua", "luau", "objc", "yaml", "twig", "xml", "properties", "unknown"];
export type StructuralLanguageHint = (typeof STRUCTURAL_LANGUAGE_HINTS)[number];
export interface StructuralReferenceOrigin {
    /** Canonical identity path. Unicode code points are intentionally preserved. */
    filePath: string;
    language: StructuralLanguageHint;
    line: number;
    column: number;
}
interface StructuralReferenceCommon {
    refKey: string;
    anchorNodeId: string;
    anchorQualifiedName: string;
    rawTargetName: string;
    sourceDeclarationKind: string;
    lookupScope: StructuralLookupScope;
    targetKindHints: StructuralTargetKindHint[];
    targetLanguageHints: StructuralLanguageHint[];
    moduleHints: string[];
    targetFileHints: string[];
    origin: StructuralReferenceOrigin;
    compilationCondition?: string;
    evidenceProvenance: 'tree-sitter';
    /** Extraction produces pending facts; persisted rows may carry another status. */
    status?: StructuralReferenceStatus;
}
export interface StructuralTypeReference extends StructuralReferenceCommon {
    kind: 'type';
    relationHint: StructuralTypeRelationHint;
    edgeOrientation: 'anchor-to-target';
}
export interface StructuralOwnerReference extends StructuralReferenceCommon {
    kind: 'owner';
    relationHint: 'contains-owner';
    edgeOrientation: 'target-to-anchor';
}
export type StructuralReference = StructuralTypeReference | StructuralOwnerReference;
/** File-anchored import fact. It deliberately has no node foreign-key identity. */
export interface ImportReference {
    kind: 'import';
    originFilePath: string;
    importKind: string;
    rawTarget: string;
    line: number;
    column: number;
}
export type StoredStructuralReference = StructuralReference & {
    status: StructuralReferenceStatus;
    resolvedNodeId: string | null;
    candidates: string[];
    resolutionStrategy: string | null;
    confidence: number | null;
    createdAt: number;
    updatedAt: number;
};
export interface StructuralReferenceResolution {
    status: StructuralReferenceStatus;
    resolvedNodeId?: string | null;
    candidates?: string[];
    strategy?: string | null;
    confidence?: number | null;
}
export interface StructuralReferenceKeyInput {
    normalizedOriginPath: string;
    anchorNodeId: string;
    relationHint: StructuralRelationHint;
    edgeOrientation: StructuralEdgeOrientation;
    rawTargetName: string;
    line: number;
    column: number;
}
export interface StructuralReferenceValidationResult {
    ok: boolean;
    errors: string[];
}
export type PathComparisonKeyResult = {
    ok: true;
    key: string;
    identityPath: string;
} | {
    ok: false;
    error: 'unicode-path-collision';
    key: string;
    identityPath: string;
    identityPaths: string[];
};
/**
 * Resolves a local code path through realpath and rejects paths outside the
 * canonical project root. Logical external paths never touch the filesystem.
 */
export declare function canonicalizeCodeFilePath(projectRoot: string, filePath: string): string;
/**
 * Produces an NFC comparison key only when that key maps to one exact identity
 * path in the current scan. Distinct filesystem spellings are never merged.
 */
export declare function makePathComparisonKey(identityPath: string, scanIdentityPaths?: Iterable<string>): PathComparisonKeyResult;
/** Scan-scoped NFC multimap used by extraction and resolution filtering. */
export declare class ScanPathComparisonIndex {
    private readonly identityPathsByKey;
    constructor(identityPaths?: Iterable<string>);
    add(identityPath: string): void;
    get(identityPath: string): PathComparisonKeyResult;
}
export declare function makeStructuralReferenceKey(input: StructuralReferenceKeyInput): string;
export declare function rebaseStructuralReferenceOrigin(reference: StructuralReference, origin: StructuralReferenceOrigin): StructuralReference;
export declare function validateStructuralReference(value: unknown): StructuralReferenceValidationResult;
export declare function assertStructuralReference(value: unknown): asserts value is StructuralReference;
export declare function validateStructuralReferenceStatus(status: unknown): asserts status is StructuralReferenceStatus;
export {};
//# sourceMappingURL=structural-reference.d.ts.map