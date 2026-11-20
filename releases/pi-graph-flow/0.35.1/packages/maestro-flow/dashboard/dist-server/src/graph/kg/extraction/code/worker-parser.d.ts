import type { Language } from '../../db/types.js';
import type { LanguageExtractionResult } from './tree-sitter-types.js';
export declare class CodeParseRunner {
    private worker;
    private workerGeneration;
    private workerParseCount;
    private nextId;
    private pending;
    private readonly workerPath;
    private readonly _usesWorker;
    constructor();
    get usesWorker(): boolean;
    extract(sourceCode: string, language: Language, filePath: string): Promise<LanguageExtractionResult | null>;
    dispose(): void;
    private ensureWorker;
    private rejectAllPending;
    private recycleWorker;
}
