import type { Language } from '../../db/types.js';
export interface SourceLanguageClassification {
    language: Language;
    reason: 'path-language' | 'objc-strong-signal' | 'cpp-strong-signal' | 'header-default-c';
    matchedSignals: string[];
}
/**
 * 使用文件内容收敛 Apple source 的最终语言。扫描阶段仍可使用 path-only provisional route。
 */
export declare function classifyLanguageForSource(filePath: string, sourceCode: string, pathLanguage: Language): SourceLanguageClassification;
//# sourceMappingURL=language-classifier.d.ts.map