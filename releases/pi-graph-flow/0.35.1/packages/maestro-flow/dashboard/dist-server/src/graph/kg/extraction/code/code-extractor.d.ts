import type { ExtractionResult } from '../../db/types.js';
import { type PreparedExternalSurfaceScan } from './external/external-surface-manifest.js';
export { prepareExternalSurfaceScan, type PreparedExternalSurfaceFile, type PreparedExternalSurfaceScan, } from './external/external-surface-manifest.js';
import { ScanPathComparisonIndex, type ImportReference, type StructuralReference } from '../../resolution/structural-reference.js';
export interface ScanOptions {
    /** 源码根目录 */
    srcDir: string;
    /** 项目根目录，用于插件加载和解析 .gitignore/.maestroignore */
    projectRoot?: string;
    /** 排除的目录模式 */
    excludeDirs?: string[];
    /** 排除的文件模式 (glob) */
    excludeFiles?: string[];
    /** 是否在缺失时创建 .maestroignore */
    createMaestroIgnore?: boolean;
    /** 允许执行 .workflow/kg/extractors/*.mjs 脚本插件 */
    allowExtractorScripts?: boolean;
    /** 是否包含测试文件 */
    includeTests?: boolean;
    /** 最大文件大小 (bytes) */
    maxFileSize?: number;
    /** 进度回调 */
    onProgress?: (file: string, count: number, total: number) => void;
    /**
     * Orchestrator-owned immutable external snapshot. Standalone extraction
     * prepares the same snapshot itself before scanning.
     */
    externalSurfaceScan?: PreparedExternalSurfaceScan;
    /** Only one srcDir may inject the exact external files. */
    includeExternalSurfaces?: boolean;
    /** Atomic replacement treats every scheduled-file omission as fatal. */
    failOnSkippedFile?: boolean;
}
export interface CodeExtractionStats {
    filesScanned: number;
    filesExtracted: number;
    filesSkipped: number;
    nodesCreated: number;
    edgesCreated: number;
    referencesCollected: number;
    errors: Array<{
        filePath: string;
        message: string;
    }>;
    durationMs: number;
}
export type CodeExtractionResultHandler = (result: ExtractionResult) => void | Promise<void>;
/**
 * 批量代码提取 — 扫描目录 → tree-sitter 解析 → nodes + edges
 *
 * 设计: 逐文件提取, 汇总后返回结果；大仓库写库请使用 forEachCodeExtractionResult()
 * 支持: 自定义提取器 (vue/svelte/liquid/mybatis/dfm) 优先于通用 tree-sitter
 */
export declare function extractCode(options: ScanOptions): Promise<{
    results: ExtractionResult[];
    stats: CodeExtractionStats;
}>;
/**
 * 流式代码提取 — 每个文件提取完成后立即回调，避免在内存中累积全量结果。
 */
export declare function forEachCodeExtractionResult(options: ScanOptions, onResult: CodeExtractionResultHandler): Promise<CodeExtractionStats>;
export declare function normalizeImportReferences(references: readonly unknown[], identityFilePath: string): ImportReference[];
export declare function markStructuralReferencePathCollisions(references: StructuralReference[], pathComparisonIndex: ScanPathComparisonIndex): StructuralReference[];
