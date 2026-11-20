import type { UnifiedEdge, UnifiedNode } from '../../../db/types.js';
import type { StructuralReference } from '../../../resolution/structural-reference.js';
export declare const APPLE_EXTERNAL_CATALOG_SCHEMA_VERSION: "apple-external-catalog/1.0";
export type AppleExternalCatalogKind = 'class' | 'protocol';
export interface AppleExternalCatalogEntry {
    module: string;
    objcName: string;
    kind: AppleExternalCatalogKind;
    swiftVisibleAliases: readonly string[];
    /** Canonical `<Module>.<ObjCName>` relation target. */
    parent: string | null;
    /** Canonical `<Module>.<ObjCName>` protocol relation targets. */
    protocols: readonly string[];
}
export interface AppleExternalCatalog {
    schemaVersion: typeof APPLE_EXTERNAL_CATALOG_SCHEMA_VERSION;
    entries: readonly AppleExternalCatalogEntry[];
    entriesByNodeId: ReadonlyMap<string, AppleExternalCatalogEntry>;
    entriesByQualifiedName: ReadonlyMap<string, AppleExternalCatalogEntry>;
}
export interface AppleExternalCatalogCandidateMatch {
    referenceRefKey: string;
    rawTargetName: string;
    matchKind: 'canonical' | 'swift-alias';
    matchedCatalogName: string;
    canonicalNodeId: string;
    canonicalQualifiedName: string;
    canonicalObjcName: string;
    module: string;
    kind: AppleExternalCatalogKind;
}
export interface AppleExternalCatalogMaterialization {
    nodes: UnifiedNode[];
    edges: UnifiedEdge[];
    matches: AppleExternalCatalogCandidateMatch[];
}
export interface AppleExternalCatalogMaterializationOptions {
    catalog?: AppleExternalCatalog;
    now?: number;
}
export declare function makeAppleExternalFilePath(module: string): string;
export declare function makeAppleExternalNodeId(module: string, objcName: string): string;
export declare function makeAppleExternalQualifiedName(module: string, objcName: string): string;
/**
 * Validates an in-package catalog value. The loader intentionally has no
 * projectRoot, SDK path, or filesystem override surface.
 */
export declare function loadAppleExternalCatalog(source?: unknown): AppleExternalCatalog;
export declare const SHIPPED_APPLE_EXTERNAL_CATALOG: AppleExternalCatalog;
/** Returns only exact canonical-name or explicitly declared Swift alias matches. */
export declare function findAppleExternalCatalogCandidates(reference: StructuralReference, catalog?: AppleExternalCatalog): AppleExternalCatalogCandidateMatch[];
/**
 * Materializes referenced Apple entries plus their explicit catalog ancestors.
 * Unreferenced, non-ancestor catalog entries never enter the project graph.
 */
export declare function materializeAppleExternalCatalog(references: Iterable<StructuralReference>, options?: AppleExternalCatalogMaterializationOptions): AppleExternalCatalogMaterialization;
//# sourceMappingURL=apple-catalog.d.ts.map