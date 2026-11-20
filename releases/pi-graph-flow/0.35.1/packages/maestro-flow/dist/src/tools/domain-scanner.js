/**
 * Domain Scanner — extract domain term candidates from codebase
 *
 * Scans TypeScript/JS source for interface/type/enum/class declarations,
 * JSDoc definitions, API routes, and README terms. Computes confidence
 * scores and filters with a programming-term blacklist.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { readGlossary } from './domain-loader.js';
// ============================================================================
// Blacklist — common programming terms that should NOT become domain terms
// ============================================================================
const BLACKLIST = new Set([
    'string', 'number', 'boolean', 'array', 'object', 'error',
    'config', 'options', 'params', 'props', 'state', 'context',
    'handler', 'service', 'controller', 'middleware', 'router',
    'component', 'module', 'utils', 'helper', 'factory', 'builder',
    'request', 'response', 'result', 'data', 'item', 'list',
    'event', 'callback', 'promise', 'observable', 'stream',
    'map', 'set', 'record', 'tuple', 'void', 'never', 'any', 'unknown',
    'base', 'abstract', 'impl', 'default', 'index', 'main', 'app',
    'test', 'mock', 'stub', 'fixture', 'spec', 'suite',
    'logger', 'client', 'server', 'connection', 'session', 'cache',
    'input', 'output', 'reader', 'writer', 'parser', 'formatter',
    'node', 'edge', 'graph', 'tree', 'queue', 'stack',
    'key', 'value', 'entry', 'pair', 'chunk', 'buffer', 'token',
]);
// ============================================================================
// Extraction regexes
// ============================================================================
const TYPE_DECL_RE = /(?:export\s+)?(?:interface|type|enum|class)\s+([A-Z][A-Za-z0-9]+)/g;
const CONST_ENUM_RE = /(?:export\s+)?const\s+([A-Z][A-Za-z0-9]*(?:Type|Status|Role|Kind|Mode|Category)[A-Za-z0-9]*)/g;
const ROUTE_RE = /\.(get|post|put|delete|patch)\s*\(\s*['"]\/api\/([a-z][\w-]*)/g;
const JSDOC_RE = /\/\*\*\s*\n?\s*\*?\s*(.+?)(?:\n|\*\/)/;
// ============================================================================
// Core scanner
// ============================================================================
export function scanForDomainTerms(projectRoot, workflowRoot, opts = {}) {
    const { minFreq = 2, limit = 20, scope, recentDays, exclude } = opts;
    const scanRoot = scope ? join(projectRoot, scope) : projectRoot;
    const existing = loadExistingIds(workflowRoot);
    const candidates = new Map();
    const cutoff = recentDays
        ? Date.now() - recentDays * 24 * 60 * 60 * 1000
        : 0;
    walkDir(scanRoot, (filePath) => {
        const ext = extname(filePath).toLowerCase();
        if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext))
            return;
        if (filePath.includes('node_modules'))
            return;
        if (filePath.includes('.d.ts') && !filePath.includes('src'))
            return;
        if (exclude && filePath.includes(exclude))
            return;
        if (cutoff > 0) {
            try {
                if (statSync(filePath).mtimeMs < cutoff)
                    return;
            }
            catch {
                return;
            }
        }
        const content = safeRead(filePath);
        if (!content)
            return;
        const rel = relative(projectRoot, filePath);
        extractTypeDeclarations(content, rel, candidates);
        extractConstEnums(content, rel, candidates);
        extractRoutes(content, rel, candidates);
    });
    // Scan docs
    scanDocs(projectRoot, candidates, exclude);
    // Filter: blacklist + existing + min frequency
    const filtered = [...candidates.values()]
        .filter(c => !BLACKLIST.has(c.normalized.toLowerCase()))
        .filter(c => !existing.has(c.normalized.toLowerCase()))
        .filter(c => c.frequency >= minFreq);
    // Compute confidence + sort
    for (const c of filtered) {
        c.confidence = computeConfidence(c);
    }
    return filtered
        .sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency)
        .slice(0, limit);
}
// ============================================================================
// Confidence scoring
// ============================================================================
export function computeConfidence(candidate) {
    let score = 0;
    // Signal 1: has auto-definition (0.3)
    if (candidate.autoDefinition)
        score += 0.3;
    // Signal 2: source reliability (0.3)
    const reliabilityMap = {
        interface: 0.3, class: 0.3, enum: 0.3,
        type: 0.2, const: 0.15, route: 0.1, doc: 0.2, upstream: 0.25,
    };
    score += candidate.sources.reduce((best, s) => Math.max(best, reliabilityMap[s.kind] ?? 0), 0);
    // Signal 3: frequency (0.2, normalized to 20)
    score += Math.min(candidate.frequency / 20, 1) * 0.2;
    // Signal 4: has code reference (0.2)
    if (candidate.sources.some(s => ['interface', 'class', 'enum', 'type'].includes(s.kind)))
        score += 0.2;
    return Math.min(score, 1);
}
// ============================================================================
// Extraction helpers
// ============================================================================
function extractTypeDeclarations(content, file, candidates) {
    const lines = content.split('\n');
    TYPE_DECL_RE.lastIndex = 0;
    let m;
    while ((m = TYPE_DECL_RE.exec(content)) !== null) {
        const name = m[1];
        const normalized = name;
        const line = content.slice(0, m.index).split('\n').length;
        // Extract JSDoc definition from preceding line
        let definition;
        if (line >= 2) {
            const prevLines = lines.slice(Math.max(0, line - 5), line - 1).join('\n');
            const jsdoc = JSDOC_RE.exec(prevLines);
            if (jsdoc)
                definition = jsdoc[1].trim();
        }
        const kind = m[0].includes('interface') ? 'interface'
            : m[0].includes('enum') ? 'enum'
                : m[0].includes('class') ? 'class'
                    : 'type';
        addCandidate(candidates, normalized, {
            kind,
            file,
            line,
            definition,
        });
    }
}
function extractConstEnums(content, file, candidates) {
    CONST_ENUM_RE.lastIndex = 0;
    let m;
    while ((m = CONST_ENUM_RE.exec(content)) !== null) {
        const name = m[1];
        const line = content.slice(0, m.index).split('\n').length;
        addCandidate(candidates, name, { kind: 'const', file, line });
    }
}
function extractRoutes(content, file, candidates) {
    ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = ROUTE_RE.exec(content)) !== null) {
        const route = m[2];
        // Singularize: "tenants" → "Tenant"
        const singular = route.endsWith('s') ? route.slice(0, -1) : route;
        const normalized = singular.charAt(0).toUpperCase() + singular.slice(1);
        const line = content.slice(0, m.index).split('\n').length;
        addCandidate(candidates, normalized, { kind: 'route', file, line });
    }
}
function scanDocs(projectRoot, candidates, exclude) {
    const readmePath = join(projectRoot, 'README.md');
    if (existsSync(readmePath)) {
        const content = safeRead(readmePath);
        if (content)
            extractDocTerms(content, 'README.md', candidates);
    }
    const docsDir = join(projectRoot, 'docs');
    if (existsSync(docsDir)) {
        walkDir(docsDir, (filePath) => {
            if (!filePath.endsWith('.md'))
                return;
            if (exclude && filePath.includes(exclude))
                return;
            const content = safeRead(filePath);
            if (!content)
                return;
            const rel = relative(projectRoot, filePath);
            extractDocTerms(content, rel, candidates);
        });
    }
}
const DOC_HEADING_RE = /^##\s+([A-Z][A-Za-z0-9 ]+)$/gm;
function extractDocTerms(content, file, candidates) {
    DOC_HEADING_RE.lastIndex = 0;
    let m;
    while ((m = DOC_HEADING_RE.exec(content)) !== null) {
        const heading = m[1].trim();
        if (heading.split(' ').length > 3)
            continue;
        const normalized = heading.replace(/\s+/g, '');
        const line = content.slice(0, m.index).split('\n').length;
        // Extract definition from paragraph after heading
        const after = content.slice(m.index + m[0].length).trimStart();
        const paraEnd = after.indexOf('\n\n');
        const definition = paraEnd > 0
            ? after.slice(0, paraEnd).replace(/\n/g, ' ').trim().slice(0, 200)
            : undefined;
        addCandidate(candidates, normalized, { kind: 'doc', file, line, definition });
    }
}
// ============================================================================
// Utilities
// ============================================================================
function addCandidate(candidates, normalized, source) {
    const key = normalized.toLowerCase();
    const existing = candidates.get(key);
    if (existing) {
        existing.sources.push(source);
        existing.frequency++;
        if (source.definition && !existing.autoDefinition) {
            existing.autoDefinition = source.definition;
        }
    }
    else {
        candidates.set(key, {
            term: normalized,
            normalized,
            sources: [source],
            frequency: 1,
            autoDefinition: source.definition ?? null,
            autoAliases: [normalized.toLowerCase()],
            confidence: 0,
        });
    }
}
function loadExistingIds(workflowRoot) {
    try {
        const glossary = readGlossary(workflowRoot);
        return new Set(glossary.terms.map(t => t.canonical.toLowerCase()));
    }
    catch {
        return new Set();
    }
}
function walkDir(dir, cb) {
    if (!existsSync(dir))
        return;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules')
                    continue;
                walkDir(full, cb);
            }
            else if (entry.isFile()) {
                cb(full);
            }
        }
    }
    catch { /* permission errors etc */ }
}
function safeRead(path) {
    try {
        return readFileSync(path, 'utf-8');
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=domain-scanner.js.map