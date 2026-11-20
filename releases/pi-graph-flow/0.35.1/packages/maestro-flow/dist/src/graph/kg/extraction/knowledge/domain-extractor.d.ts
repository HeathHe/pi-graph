import type { ExtractionResult } from '../../db/types.js';
export declare function extractDomain(glossaryPath: string, workflowRoot: string): ExtractionResult;
export declare function purgeDomainTerm(db: import('node:sqlite').DatabaseSync, termId: string): void;
//# sourceMappingURL=domain-extractor.d.ts.map