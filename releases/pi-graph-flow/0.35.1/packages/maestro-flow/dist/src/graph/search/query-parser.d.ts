import type { NodeKind, Language } from '../types.js';
export interface ParsedQuery {
    text: string;
    kinds: NodeKind[];
    languages: Language[];
    pathFilters: string[];
    nameFilters: string[];
}
export declare function parseQuery(raw: string): ParsedQuery;
export declare function boundedEditDistance(a: string, b: string, maxDist: number): number;
//# sourceMappingURL=query-parser.d.ts.map