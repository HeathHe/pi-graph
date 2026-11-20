import { type LanguageExtractionResult } from './tree-sitter-types.js';
/**
 * 提取 Vue SFC — 委托 script 块给 tree-sitter, 处理模板中的组件引用
 */
export declare function extractVueSFC(source: string, filePath: string, onEmbeddedParseError?: 'warn' | 'fail'): Promise<LanguageExtractionResult>;
