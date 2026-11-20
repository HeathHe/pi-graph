// ---------------------------------------------------------------------------
// Enhanced types (codegraph-derived)
// ---------------------------------------------------------------------------
export const NODE_KINDS = [
    'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
    'function', 'method', 'property', 'field', 'variable', 'constant',
    'enum', 'enum_member', 'type_alias', 'namespace', 'parameter',
    'import', 'export', 'route', 'component',
];
export const EDGE_KINDS = [
    'contains', 'calls', 'imports', 'exports', 'extends', 'implements',
    'references', 'type_of', 'returns', 'instantiates', 'overrides', 'decorates',
];
export const LANGUAGES = [
    'typescript', 'javascript', 'tsx', 'jsx', 'python', 'go', 'rust',
    'java', 'c', 'cpp', 'csharp', 'php', 'ruby', 'swift', 'kotlin',
    'dart', 'svelte', 'vue', 'lua', 'luau', 'objc', 'scala', 'pascal',
    'yaml', 'xml', 'properties', 'unknown',
];
//# sourceMappingURL=types.js.map