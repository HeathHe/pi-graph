export interface ImportMapping {
    alias: string;
    target: string;
    source: 'tsconfig' | 'go-mod' | 'compile-commands' | 'manual';
}
export interface ResolvedImport {
    targetFilePath: string;
    targetSymbol?: string;
    confidence: number;
    strategy: string;
}
/**
 * 从 tsconfig.json 提取 paths 别名映射
 * 例: { "@/*": ["./src/*"] } → [{ alias: "@", target: "./src", source: "tsconfig" }]
 */
export declare function extractTsconfigMappings(projectRoot: string): ImportMapping[];
/**
 * 解析 tsconfig alias import
 * 例: import { X } from "@graph/kg/db" + alias @ → ./src/graph/kg/db
 */
export declare function resolveTsconfigAlias(importPath: string, mappings: ImportMapping[], fromFilePath: string): ResolvedImport | null;
/**
 * 从 go.mod 提取模块路径
 * 例: module github.com/org/repo → { module: "github.com/org/repo", root: "." }
 */
export declare function extractGoModule(projectRoot: string): {
    module: string;
    root: string;
} | null;
/**
 * 解析 Go 跨包引用
 * 例: "github.com/org/repo/pkg" → "./pkg/"
 */
export declare function resolveGoCrossPackageReference(importPath: string, goModule: {
    module: string;
    root: string;
}): ResolvedImport | null;
/**
 * 解析 C/C++ #include 路径
 * 例: #include "header.h" → 查找 compile_commands.json 中的 include 路径
 */
export declare function resolveCppIncludePath(includePath: string, projectRoot: string, fromFilePath: string): ResolvedImport | null;
/**
 * 构建 re-export 映射
 * 例: a.ts: export { Foo } from './foo' → { 'a.ts::Foo' → 'foo.ts::Foo' }
 */
export interface ReExportMap {
    /** key: "sourceFile::symbolName", value: "targetFile::symbolName" */
    map: Map<string, string>;
}
export declare function buildReExportMap(exports: Array<{
    sourceFile: string;
    symbolName: string;
    fromPath: string;
}>): ReExportMap;
/**
 * 穿透 re-export 链
 * 例: index.ts re-exports from internal/foo.ts
 *     b.ts imports from index.ts → 应解析到 internal/foo.ts
 */
export declare function resolveViaReExport(importPath: string, symbolName: string, reExportMap: ReExportMap, maxDepth?: number): string | null;
export declare class ImportResolver {
    private tsconfigMappings;
    private goModule;
    private projectRoot;
    constructor(projectRoot: string);
    /**
     * 统一解析 import 路径
     * 按优先级尝试: tsconfig alias → go module → 相对路径
     */
    resolveImport(importPath: string, fromFilePath: string, language: string): ResolvedImport | null;
}
//# sourceMappingURL=import-resolver.d.ts.map