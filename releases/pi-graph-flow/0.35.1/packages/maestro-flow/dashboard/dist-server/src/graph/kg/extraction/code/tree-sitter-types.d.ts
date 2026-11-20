import type { UnifiedNode, Language } from '../../db/types.js';
import type { ImportReference, StructuralReference } from '../../resolution/structural-reference.js';
export interface ExtractedSymbol {
    kind: string;
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
    visibility: string;
    isExported: boolean;
    isAsync: boolean;
    isStatic: boolean;
    isAbstract: boolean;
    decorators: string[];
    typeParameters: string[];
    /** Extractor-owned exact identity facts used by later strict resolution. */
    metadata?: Record<string, unknown>;
}
/**
 * Public extractor reference contract consumed by the generic code resolver.
 * Keep this shape backward compatible for plugins and non-structural relations
 * such as imports and calls.
 */
export interface ExtractedReference {
    fromSymbolName: string;
    fromSymbolId: string;
    referenceName: string;
    referenceKind: string;
    line: number;
    col: number;
    filePath: string;
    language: Language;
}
export declare function makeImportReference(originFilePath: string, rawTarget: string, line: number, column: number, importKind?: string): ImportReference;
export interface LanguageExtractionResult {
    symbols: ExtractedSymbol[];
    references: ExtractedReference[];
    /** Exact import facts used internally to retain import kind and raw identity. */
    importReferences?: ImportReference[];
    /** Replayable exact structural facts resolved independently of generic refs. */
    structuralReferences?: StructuralReference[];
    edges: Array<{
        source: string;
        target: string;
        kind: string;
        line?: number;
        col?: number;
    }>;
    /** Non-fatal parser coverage diagnostics retained on the FileRecord. */
    diagnostics?: string[];
}
export interface LanguageExtractor {
    /** 该提取器支持的语言 */
    language: Language;
    /** 对应的 tree-sitter grammar 名 (或 wasm 文件名) */
    grammarName: string;
    /** tree-sitter 节点类型 → 符号 kind 映射 */
    nodeTypeMap: Record<string, string>;
    /**
     * 从 tree-sitter AST 提取符号 + 引用
     * @param tree 解析后的 AST
     * @param sourceCode 源码文本
     * @param filePath 文件路径
     */
    extract(tree: unknown, sourceCode: string, filePath: string): LanguageExtractionResult;
}
export declare function makeCodeNodeId(filePath: string, qualifiedName: string): string;
export declare function makeFileNodeId(filePath: string): string;
export declare function symbolToNode(symbol: ExtractedSymbol, now: number): UnifiedNode;
