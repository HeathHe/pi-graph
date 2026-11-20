/**
 * Domain Matcher — CJK-aware term matching for domain glossary injection
 */
import type { DomainTerm } from './domain-loader.js';
export interface DomainTermMatch {
    termId: string;
    canonical: string;
    definition: string;
    matchedBy: 'canonical' | 'alias' | 'keyword';
    matchedToken: string;
}
export interface MatchedTermSet {
    directMatches: DomainTermMatch[];
    propagatedIds: string[];
}
type MatchableTerm = Pick<DomainTerm, 'id' | 'canonical' | 'definition' | 'aliases' | 'keywords' | 'relationships'> & {
    status?: string;
    rewrite_hints?: Record<string, string>;
};
export declare function matchAlias(prompt: string, alias: string): boolean;
export declare function matchDomainTerms(prompt: string, terms: MatchableTerm[]): MatchedTermSet;
export declare function collectRewriteHints(matchedTermIds: string[], terms: MatchableTerm[]): Record<string, string>;
export {};
//# sourceMappingURL=domain-matcher.d.ts.map