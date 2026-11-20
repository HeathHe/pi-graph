import { type LanguageExtractor } from '../tree-sitter-types.js';
import type { Language } from '../../../db/types.js';
export declare function getExtractor(language: Language): LanguageExtractor | null;
export declare function getAllExtractors(): Map<Language, LanguageExtractor>;
export declare function getSupportedLanguages(): Language[];
export declare function detectLanguageFromPath(filePath: string): Language;
export declare const FILE_LEVEL_ONLY_LANGUAGES: Set<Language>;
export declare function isFileLevelOnlyLanguage(language: Language): boolean;
