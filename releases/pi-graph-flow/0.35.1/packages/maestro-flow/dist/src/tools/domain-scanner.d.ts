/**
 * Domain Scanner — extract domain term candidates from codebase
 *
 * Scans TypeScript/JS source for interface/type/enum/class declarations,
 * JSDoc definitions, API routes, and README terms. Computes confidence
 * scores and filters with a programming-term blacklist.
 */
export interface TermSource {
    kind: 'interface' | 'type' | 'enum' | 'class' | 'const' | 'route' | 'doc' | 'upstream';
    file: string;
    line?: number;
    definition?: string;
}
export interface TermCandidate {
    term: string;
    normalized: string;
    sources: TermSource[];
    frequency: number;
    autoDefinition: string | null;
    autoAliases: string[];
    confidence: number;
}
export interface ScanOptions {
    scope?: string;
    recentDays?: number;
    minFreq?: number;
    limit?: number;
    exclude?: string;
}
export declare function scanForDomainTerms(projectRoot: string, workflowRoot: string, opts?: ScanOptions): TermCandidate[];
export declare function computeConfidence(candidate: TermCandidate): number;
//# sourceMappingURL=domain-scanner.d.ts.map