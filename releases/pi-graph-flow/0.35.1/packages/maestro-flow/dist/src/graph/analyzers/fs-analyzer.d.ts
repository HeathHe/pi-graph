import type { CodeAnalyzer, AnalyzerOptions, KnowledgeGraph } from '../types.js';
export declare class FsAnalyzer implements CodeAnalyzer {
    readonly name = "fs-analyzer";
    analyze(projectRoot: string, options?: AnalyzerOptions): Promise<KnowledgeGraph>;
    /** Read project name from package.json or use directory name. */
    private detectProjectName;
    /** Detect frameworks from package.json dependencies. */
    private detectFrameworks;
}
//# sourceMappingURL=fs-analyzer.d.ts.map