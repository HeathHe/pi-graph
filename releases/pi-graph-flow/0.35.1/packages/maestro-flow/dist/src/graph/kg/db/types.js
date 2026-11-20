// src/graph/kg/db/types.ts — MaestroGraph 统一类型系统
// 参考: guide/plan-maestrograph.md Gap 修补 2 + D8.4 Node ID 命名空间
// ---------------------------------------------------------------------------
// NodeKind — 完整复用 CodeGraph 22 种 + 新增 7 种知识类型
// ---------------------------------------------------------------------------
export const CODE_NODE_KINDS = [
    'file', // CodeGraph 原有
    'module',
    'class',
    'struct',
    'interface',
    'trait',
    'protocol', // Swift 协议, callback-synthesizer 依赖
    'function',
    'method',
    'property',
    'field',
    'variable',
    'constant',
    'enum',
    'enum_member',
    'type_alias',
    'namespace',
    'parameter',
    'import',
    'export',
    'route',
    'component',
];
export const KNOWLEDGE_NODE_KINDS = [
    'domain_term', // Domain glossary term
    'spec_entry', // Spec constraint/rule
    'knowhow_entry', // Wiki knowhow document
    'codebase_section', // Codebase doc section
    'issue', // Issue tracker entry
    'decision', // Architecture decision record
    'requirement', // Requirement from context-package
];
export const UNIFIED_NODE_KINDS = [...CODE_NODE_KINDS, ...KNOWLEDGE_NODE_KINDS];
// ---------------------------------------------------------------------------
// Language — 完整复用 CodeGraph 28+ 种
// ---------------------------------------------------------------------------
export const LANGUAGES = [
    'typescript', 'javascript', 'tsx', 'jsx',
    'python', 'go', 'rust', 'java',
    'c', 'cpp', 'csharp', 'php', 'ruby',
    'swift', 'kotlin', 'dart',
    'svelte', 'vue', 'liquid',
    'pascal', 'scala', 'lua', 'luau', 'objc',
    'yaml', 'twig', 'xml', 'properties',
    'unknown',
];
// ---------------------------------------------------------------------------
// Source Type — 知识节点来源分类
// ---------------------------------------------------------------------------
export const SOURCE_TYPES = [
    'codegraph', 'domain', 'spec', 'knowhow', 'codebase', 'issue',
];
export function makeNodeId(prefix, ...parts) {
    return `${prefix}:${parts.join(':')}`;
}
export function validateNodeId(id) {
    const VALID_PREFIXES = new Set(['code', 'domain', 'spec', 'knowhow', 'codebase', 'issue']);
    const colonIdx = id.indexOf(':');
    return colonIdx > 0 && VALID_PREFIXES.has(id.slice(0, colonIdx));
}
export function getNodePrefix(id) {
    const colonIdx = id.indexOf(':');
    if (colonIdx <= 0)
        return null;
    const prefix = id.slice(0, colonIdx);
    const VALID_PREFIXES = new Set(['code', 'domain', 'spec', 'knowhow', 'codebase', 'issue']);
    return VALID_PREFIXES.has(prefix) ? prefix : null;
}
//# sourceMappingURL=types.js.map