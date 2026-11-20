import type { Language } from '../../db/types.js';
interface TreeSitterLanguage {
    nodeTypes: unknown[];
}
interface TreeSitterTree {
    rootNode: TreeSitterNode;
    delete(): void;
}
interface TreeSitterNode {
    type: string;
    startPosition: {
        row: number;
        column: number;
    };
    endPosition: {
        row: number;
        column: number;
    };
    startIndex: number;
    endIndex: number;
    text: string;
    childCount: number;
    childFieldName(i: number): string | null;
    child(i: number): TreeSitterNode | null;
    children: TreeSitterNode[];
    parent: TreeSitterNode | null;
    namedChildren: TreeSitterNode[];
}
export declare const LANGUAGE_TO_GRAMMAR: Record<Language, string>;
export declare class TreeSitterEngine {
    private static _instance;
    private _module;
    private _grammarCache;
    private _unavailableGrammars;
    private static readonly MAX_POOL_SIZE;
    private _parserPool;
    private _resetCounter;
    private _available;
    private _initPromise;
    private _parserInitialized;
    private constructor();
    static getInstance(): TreeSitterEngine;
    isAvailable(): boolean;
    private tryLoadModule;
    ensureInitialized(): Promise<void>;
    private _init;
    loadGrammar(language: Language): Promise<TreeSitterLanguage | null>;
    parse(sourceCode: string, language: Language): Promise<TreeSitterTree | null>;
    private resolveGrammarPath;
    dispose(): void;
}
export declare function getTreeSitterEngine(): TreeSitterEngine;
export declare function isTreeSitterAvailable(): boolean;
export {};
//# sourceMappingURL=tree-sitter.d.ts.map