// src/graph/kg/extraction/code/tree-sitter-types.ts
// LanguageExtractor 接口 + tree-sitter 类型辅助
// 参考: codegraph/src/extraction/tree-sitter-types.ts
export function makeImportReference(originFilePath, rawTarget, line, column, importKind = 'module') {
    return { kind: 'import', originFilePath, importKind, rawTarget, line, column };
}
// ---------------------------------------------------------------------------
// Node ID 生成 (code namespace) — D8.4
// ---------------------------------------------------------------------------
export function makeCodeNodeId(filePath, qualifiedName) {
    // Windows separators normalize to POSIX; POSIX backslashes are identity bytes.
    const normalizedPath = process.platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath;
    return `code:${normalizedPath}:${qualifiedName}`;
}
export function makeFileNodeId(filePath) {
    const normalizedPath = process.platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath;
    return `code:${normalizedPath}:<file>`;
}
// ---------------------------------------------------------------------------
// 将 ExtractedSymbol 转换为 UnifiedNode
// ---------------------------------------------------------------------------
export function symbolToNode(symbol, now) {
    return {
        id: makeCodeNodeId(symbol.filePath, symbol.qualifiedName),
        kind: symbol.kind,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        filePath: symbol.filePath,
        language: symbol.language,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        startColumn: symbol.startColumn,
        endColumn: symbol.endColumn,
        docstring: symbol.docstring,
        signature: symbol.signature,
        visibility: symbol.visibility,
        isExported: symbol.isExported,
        isAsync: symbol.isAsync,
        isStatic: symbol.isStatic,
        isAbstract: symbol.isAbstract,
        decorators: symbol.decorators,
        typeParameters: symbol.typeParameters,
        sourceType: 'codegraph',
        definition: '',
        aliases: [],
        keywords: [],
        category: '',
        roles: [],
        priority: '',
        status: 'active',
        body: '',
        metadata: { ...(symbol.metadata ?? {}) },
        updatedAt: now,
    };
}
//# sourceMappingURL=tree-sitter-types.js.map