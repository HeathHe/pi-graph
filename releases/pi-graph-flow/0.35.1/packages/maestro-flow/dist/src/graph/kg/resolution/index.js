// src/graph/kg/resolution/index.ts — 统一 resolver 入口
export { resolveKnowledgeEdges, expandRelated } from './knowledge-resolver.js';
export { resolveCodeStructuralReferences } from './code-reference-resolver.js';
export { matchReference, tokenize } from './name-matcher.js';
export { ImportResolver, extractTsconfigMappings, resolveTsconfigAlias, extractGoModule, resolveGoCrossPackageReference, resolveCppIncludePath, buildReExportMap, resolveViaReExport } from './import-resolver.js';
export { runCallbackSynthesis } from './callback-synthesizer.js';
export { getRegisteredFrameworks, detectFrameworks, getFrameworkResolver } from './frameworks/index.js';
//# sourceMappingURL=index.js.map