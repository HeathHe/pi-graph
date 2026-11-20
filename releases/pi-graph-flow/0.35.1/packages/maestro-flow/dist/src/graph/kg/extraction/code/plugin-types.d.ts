import type { Language } from '../../db/types.js';
import type { ExtractedSymbol, ExtractedReference } from './tree-sitter-types.js';
export interface ExtractorPluginConfig {
    version: 1;
    defaults?: PluginDefaults;
    plugins: PluginDefinition[];
}
export interface PluginDefaults {
    timeoutMs?: number;
    onError?: 'warn' | 'fail';
    conflictPolicy?: ConflictPolicy;
}
export type ConflictPolicy = 'core-wins' | 'plugin-wins' | 'merge-metadata';
export interface PluginDefinition {
    id: string;
    description?: string;
    enabled?: boolean;
    languages: (Language | 'all')[];
    filePatterns?: string[];
    excludePatterns?: string[];
    priority?: number;
    mode: 'declarative' | 'script';
    declarative?: DeclarativeSpec;
    script?: ScriptSpec;
}
export interface DeclarativeSpec {
    rules: PatternRule[];
}
export interface PatternRule {
    id: string;
    description?: string;
    match: PatternMatch;
    extract: ExtractSpec;
}
export type PatternMatchType = 'call' | 'assignment' | 'regex';
export type PatternScope = 'module' | 'class' | 'any';
export interface PatternMatch {
    type: PatternMatchType;
    pattern: string;
    nameRegex?: string;
    scope?: PatternScope;
}
export interface ExtractSpec {
    kind: string;
    name?: string;
    qualifiedName?: string;
    signature?: string;
    visibility?: string;
    isExported?: boolean;
    isStatic?: boolean;
    decorators?: string[];
    metadata?: Record<string, string | boolean | number>;
}
export interface ScriptSpec {
    module: string;
    export?: string;
    timeoutMs?: number;
}
export interface PluginExtractionResult {
    symbols: PluginExtractedSymbol[];
    references?: ExtractedReference[];
    edges?: Array<{
        source: string;
        target: string;
        kind: string;
        line?: number;
        col?: number;
    }>;
}
export interface PluginExtractedSymbol extends ExtractedSymbol {
    pluginMetadata?: Record<string, unknown>;
    sourcePluginId?: string;
    sourceRuleId?: string;
}
export interface PluginContext {
    filePath: string;
    language: Language;
    sourceCode: string;
    tree: unknown;
    findAll(nodeType: string): AstNodeView[];
    text(startLine: number, endLine: number): string;
    makeSymbol(input: Partial<PluginExtractedSymbol>): PluginExtractedSymbol;
}
export interface AstNodeView {
    type: string;
    text: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    children: AstNodeView[];
    namedChildren: AstNodeView[];
    childForFieldName(name: string): AstNodeView | null;
}
//# sourceMappingURL=plugin-types.d.ts.map