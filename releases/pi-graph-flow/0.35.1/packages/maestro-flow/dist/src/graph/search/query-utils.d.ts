import type { NodeKind } from '../types.js';
export declare const STOP_WORDS: Set<string>;
export declare function getStemVariants(term: string): string[];
export declare function extractSearchTerms(query: string, options?: {
    stems?: boolean;
}): string[];
export declare function scorePathRelevance(filePath: string, query: string): number;
export declare function nameMatchBonus(nodeName: string, query: string): number;
export declare function kindBonus(kind: NodeKind): number;
export declare function isTestFile(filePath: string): boolean;
export declare function isGeneratedFile(filePath: string): boolean;
//# sourceMappingURL=query-utils.d.ts.map