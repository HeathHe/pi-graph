import type { StructuralReference } from '../resolution/structural-reference.js';
export declare const CODE_NODE_KINDS: readonly ["file", "module", "class", "struct", "interface", "trait", "protocol", "function", "method", "property", "field", "variable", "constant", "enum", "enum_member", "type_alias", "namespace", "parameter", "import", "export", "route", "component"];
export declare const KNOWLEDGE_NODE_KINDS: readonly ["domain_term", "spec_entry", "knowhow_entry", "codebase_section", "issue", "decision", "requirement"];
export declare const UNIFIED_NODE_KINDS: readonly ["file", "module", "class", "struct", "interface", "trait", "protocol", "function", "method", "property", "field", "variable", "constant", "enum", "enum_member", "type_alias", "namespace", "parameter", "import", "export", "route", "component", "domain_term", "spec_entry", "knowhow_entry", "codebase_section", "issue", "decision", "requirement"];
export type BuiltinNodeKind = (typeof UNIFIED_NODE_KINDS)[number];
export type UnifiedNodeKind = BuiltinNodeKind | (string & {});
export type CodeNodeKind = (typeof CODE_NODE_KINDS)[number];
export type KnowledgeNodeKind = (typeof KNOWLEDGE_NODE_KINDS)[number];
export type CodeEdgeKind = 'contains' | 'calls' | 'imports' | 'exports' | 'extends' | 'implements' | 'references' | 'type_of' | 'returns' | 'instantiates' | 'overrides' | 'decorates';
export type KnowledgeEdgeKind = 'defines' | 'constrains' | 'documents' | 'relates_to' | 'implements_rule' | 'resolves' | 'derived_from' | 'supersedes' | 'aliases';
export type UnifiedEdgeKind = CodeEdgeKind | KnowledgeEdgeKind;
export declare const LANGUAGES: readonly ["typescript", "javascript", "tsx", "jsx", "python", "go", "rust", "java", "c", "cpp", "csharp", "php", "ruby", "swift", "kotlin", "dart", "svelte", "vue", "liquid", "pascal", "scala", "lua", "luau", "objc", "yaml", "twig", "xml", "properties", "unknown"];
export type Language = (typeof LANGUAGES)[number];
export declare const SOURCE_TYPES: readonly ["codegraph", "domain", "spec", "knowhow", "codebase", "issue"];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type EdgeProvenance = 'tree-sitter' | 'heuristic' | 'callback-synth' | 'framework' | 'domain' | 'spec' | 'knowhow' | 'harvest' | 'knowledge-resolver' | 'code-resolution' | 'structural-resolver' | 'manual';
export type NodeIdPrefix = 'code' | 'domain' | 'spec' | 'knowhow' | 'codebase' | 'issue';
export declare function makeNodeId(prefix: NodeIdPrefix, ...parts: string[]): string;
export declare function validateNodeId(id: string): boolean;
export declare function getNodePrefix(id: string): NodeIdPrefix | null;
export type Visibility = 'public' | 'private' | 'protected' | 'internal';
export interface UnifiedNode {
    id: string;
    kind: UnifiedNodeKind;
    name: string;
    qualifiedName: string;
    filePath: string;
    language: Language;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    docstring: string;
    signature: string;
    visibility: Visibility | '';
    isExported: boolean;
    isAsync: boolean;
    isStatic: boolean;
    isAbstract: boolean;
    decorators: string[];
    typeParameters: string[];
    sourceType: SourceType;
    definition: string;
    aliases: string[];
    keywords: string[];
    category: string;
    roles: string[];
    priority: string;
    status: string;
    body: string;
    metadata: Record<string, unknown>;
    updatedAt: number;
}
export interface UnifiedEdge {
    id?: number;
    source: string;
    target: string;
    kind: UnifiedEdgeKind;
    metadata?: Record<string, unknown>;
    line?: number;
    column?: number;
    provenance?: EdgeProvenance;
    /** Stable syntax fact that owns this materialized edge. */
    originRefKey?: string;
}
export interface FileRecord {
    path: string;
    contentHash: string;
    language: Language;
    size: number;
    modifiedAt: number;
    indexedAt: number;
    nodeCount: number;
    errors: string[];
    sourceType: SourceType;
}
export interface ExtractionResult {
    nodes: UnifiedNode[];
    edges: UnifiedEdge[];
    /** 未解析引用 (imports/calls) — 由提取器收集, 编排层写入 unresolved_refs 供后续解析 */
    references?: Array<{
        fromSymbolName: string;
        fromSymbolId: string;
        referenceName: string;
        referenceKind: string;
        line: number;
        col: number;
        filePath: string;
        language: Language;
    }>;
    fileRecord: FileRecord;
    /** 严格结构事实独立于 unresolved_refs，可重放解析为 origin-bound edges。 */
    structuralReferences?: StructuralReference[];
}
export interface ResolutionResult {
    edgesCreated: number;
    /** 可选增量统计：区分严格结构代码边，兼容旧调用方构造结果对象。 */
    codeStructuralEdgesCreated?: number;
    /** 可选增量统计：区分知识边，兼容旧调用方构造结果对象。 */
    knowledgeEdgesCreated?: number;
    edges: UnifiedEdge[];
    durationMs: number;
}
export interface SyncResult {
    source: string;
    nodesAdded: number;
    nodesUpdated: number;
    nodesRemoved: number;
    edgesAdded: number;
    edgesRemoved: number;
    durationMs: number;
}
export interface UnifiedSearchResult {
    node: UnifiedNode;
    score: number;
    matchReason: {
        kind: 'direct';
        field: 'name' | 'definition' | 'aliases' | 'keywords';
    } | {
        kind: 'edge';
        fromNodeId: string;
        fromNodeName: string;
        edgeKind: string;
    } | {
        kind: 'hop';
        path: Array<{
            nodeName: string;
            edgeKind: string;
        }>;
    } | {
        kind: 'vector';
        field: 'embedding';
    };
}
export interface UnifiedGraphStats {
    nodeCount: number;
    edgeCount: number;
    fileCount: number;
    dbSizeBytes: number;
    nodesByKind: Record<string, number>;
    edgesByKind: Record<string, number>;
    nodesBySourceType: Record<string, number>;
    detectedFrameworks: string[];
    schemaVersion: number;
    stalenessRatio: number;
    /** 严格结构引用统计为可选增量字段，兼容旧版统计结果类型。 */
    structuralRefs?: {
        total: number;
        status: Record<string, number>;
        relation: Record<string, number>;
        language: Record<string, number>;
    };
    /** 外部符号面统计为可选增量字段，兼容旧版统计结果类型。 */
    externalNodes?: {
        total: number;
        appleCatalog: number;
        exactSurfaces: number;
        language: Record<string, number>;
    };
}
