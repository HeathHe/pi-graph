/**
 * Domain Loader — CRUD for .workflow/domain/glossary.yaml
 *
 * Provides read/write operations with file locking, auto-backup, mtime cache,
 * and schema validation. All write operations go through GlossaryLock.
 *
 * Migration: reads glossary.json as fallback for backward compatibility,
 * but always writes glossary.yaml.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync, } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { validateGlossary, validateRelationships } from './domain-schema.js';
// ============================================================================
// Paths
// ============================================================================
function glossaryPath(workflowRoot) {
    return join(workflowRoot, 'domain', 'glossary.yaml');
}
function glossaryJsonPath(workflowRoot) {
    return join(workflowRoot, 'domain', 'glossary.json');
}
function domainDir(workflowRoot) {
    return join(workflowRoot, 'domain');
}
// ============================================================================
// File lock (cross-process)
// ============================================================================
const STALE_TIMEOUT_MS = 30_000;
export class GlossaryLock {
    lockPath;
    held = false;
    constructor(workflowRoot) {
        this.lockPath = join(workflowRoot, 'domain', '.glossary.lock');
    }
    acquire() {
        try {
            writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
            this.held = true;
            return;
        }
        catch {
            // EEXIST — lock file exists, check if stale
        }
        try {
            const content = readFileSync(this.lockPath, 'utf-8').trim();
            const pid = parseInt(content, 10);
            const lockAge = Date.now() - statSync(this.lockPath).mtimeMs;
            if (lockAge < STALE_TIMEOUT_MS && !isNaN(pid) && isProcessAlive(pid)) {
                throw new Error(`glossary.json locked by PID ${pid}. Delete ${this.lockPath} if stale.`);
            }
        }
        catch (e) {
            if (e.message.includes('locked by PID'))
                throw e;
        }
        try {
            unlinkSync(this.lockPath);
        }
        catch { /* already gone */ }
        try {
            writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
            this.held = true;
        }
        catch {
            throw new Error(`Cannot acquire glossary lock: ${this.lockPath}`);
        }
    }
    release() {
        if (!this.held)
            return;
        try {
            const content = readFileSync(this.lockPath, 'utf-8').trim();
            if (parseInt(content, 10) === process.pid)
                unlinkSync(this.lockPath);
        }
        catch { /* already gone */ }
        this.held = false;
    }
    withLock(fn) {
        this.acquire();
        try {
            return fn();
        }
        finally {
            this.release();
        }
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
// ============================================================================
// Backup
// ============================================================================
const MAX_BACKUPS = 10;
function backupGlossary(workflowRoot) {
    const yamlPath = glossaryPath(workflowRoot);
    const jsonPath = glossaryJsonPath(workflowRoot);
    const gPath = existsSync(yamlPath) ? yamlPath : existsSync(jsonPath) ? jsonPath : null;
    if (!gPath)
        return;
    const backupDir = join(workflowRoot, 'domain', '.backups');
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:\-T]/g, '').replace(/\..+/, '');
    const ext = gPath.endsWith('.yaml') ? 'yaml' : 'json';
    copyFileSync(gPath, join(backupDir, `glossary-${ts}.${ext}`));
    const backups = readdirSync(backupDir)
        .filter(f => f.startsWith('glossary-'))
        .sort().reverse();
    for (const old of backups.slice(MAX_BACKUPS)) {
        try {
            unlinkSync(join(backupDir, old));
        }
        catch { /* ignore */ }
    }
}
// ============================================================================
// Read (with cache)
// ============================================================================
const _glossaryCache = new Map();
const CACHE_MAX_ENTRIES = 10;
export function readGlossary(workflowRoot) {
    const yamlPath = glossaryPath(workflowRoot);
    const jsonPath = glossaryJsonPath(workflowRoot);
    let raw;
    let sourceFile;
    let parseData;
    if (existsSync(yamlPath)) {
        raw = readFileSync(yamlPath, 'utf-8');
        sourceFile = 'glossary.yaml';
        parseData = (s) => YAML.parse(s);
    }
    else if (existsSync(jsonPath)) {
        raw = readFileSync(jsonPath, 'utf-8');
        sourceFile = 'glossary.json';
        parseData = (s) => JSON.parse(s);
    }
    else {
        return { $schema: 'domain/1.0', terms: [] };
    }
    let data;
    try {
        data = parseData(raw);
    }
    catch (e) {
        throw new Error(`${sourceFile} parse error: ${e.message}. Check file or restore from .backups/`);
    }
    const errors = validateGlossary(data);
    if (errors.length > 0) {
        const msg = errors.slice(0, 5).map(e => `${e.path}: ${e.message}`).join('; ');
        throw new Error(`${sourceFile} validation failed: ${msg}`);
    }
    return data;
}
export function readGlossaryCached(workflowRoot) {
    const yamlPath = glossaryPath(workflowRoot);
    const jsonPath = glossaryJsonPath(workflowRoot);
    const gPath = existsSync(yamlPath) ? yamlPath : existsSync(jsonPath) ? jsonPath : null;
    if (!gPath)
        return { $schema: 'domain/1.0', terms: [] };
    const st = statSync(gPath);
    const cached = _glossaryCache.get(gPath);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size)
        return cached.data;
    const data = readGlossary(workflowRoot);
    if (_glossaryCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = _glossaryCache.keys().next().value;
        if (oldest)
            _glossaryCache.delete(oldest);
    }
    _glossaryCache.set(gPath, { mtime: st.mtimeMs, size: st.size, data });
    return data;
}
function clearCache() {
    _glossaryCache.clear();
}
// ============================================================================
// Write (with lock + backup)
// ============================================================================
function writeGlossary(workflowRoot, glossary) {
    const gPath = glossaryPath(workflowRoot);
    mkdirSync(domainDir(workflowRoot), { recursive: true });
    backupGlossary(workflowRoot);
    writeFileSync(gPath, YAML.stringify(glossary, { lineWidth: 120 }), 'utf-8');
    clearCache();
}
// ============================================================================
// Safe load (for consumers that need empty-glossary safety)
// ============================================================================
export function loadGlossary(projectPath) {
    const wRoot = join(projectPath, '.workflow');
    const yamlPath = glossaryPath(wRoot);
    const jsonPath = glossaryJsonPath(wRoot);
    if (!existsSync(yamlPath) && !existsSync(jsonPath))
        return { exists: false, glossary: null, activeTerms: [], isEmpty: true };
    try {
        const glossary = readGlossaryCached(wRoot);
        if (!Array.isArray(glossary.terms))
            return { exists: true, glossary, activeTerms: [], isEmpty: true };
        const activeTerms = glossary.terms.filter(t => (t.status ?? 'active') === 'active');
        return { exists: true, glossary, activeTerms, isEmpty: glossary.terms.length === 0 };
    }
    catch {
        return { exists: true, glossary: null, activeTerms: [], isEmpty: true };
    }
}
// ============================================================================
// CRUD operations (all locked)
// ============================================================================
export function initDomain(workflowRoot, project) {
    const dir = domainDir(workflowRoot);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'concepts'), { recursive: true });
    const yamlPath = glossaryPath(workflowRoot);
    const jsonPath = glossaryJsonPath(workflowRoot);
    if (!existsSync(yamlPath) && !existsSync(jsonPath)) {
        const glossary = {
            $schema: 'domain/1.0',
            ...(project ? { project } : {}),
            terms: [],
        };
        writeFileSync(yamlPath, YAML.stringify(glossary, { lineWidth: 120 }), 'utf-8');
    }
    return existsSync(yamlPath) ? yamlPath : jsonPath;
}
export function addTerm(workflowRoot, term) {
    const lock = new GlossaryLock(workflowRoot);
    lock.withLock(() => {
        const glossary = readGlossary(workflowRoot);
        if (glossary.terms.some(t => t.id === term.id)) {
            throw new Error(`Term "${term.id}" already exists. Use updateTerm instead.`);
        }
        glossary.terms.push(term);
        writeGlossary(workflowRoot, glossary);
    });
}
export function updateTerm(workflowRoot, termId, updates) {
    const lock = new GlossaryLock(workflowRoot);
    lock.withLock(() => {
        const glossary = readGlossary(workflowRoot);
        const idx = glossary.terms.findIndex(t => t.id === termId);
        if (idx === -1)
            throw new Error(`Term "${termId}" not found`);
        glossary.terms[idx] = { ...glossary.terms[idx], ...updates };
        writeGlossary(workflowRoot, glossary);
    });
}
export function removeTerm(workflowRoot, termId) {
    const warnings = [];
    const lock = new GlossaryLock(workflowRoot);
    lock.withLock(() => {
        const glossary = readGlossary(workflowRoot);
        const idx = glossary.terms.findIndex(t => t.id === termId);
        if (idx === -1)
            throw new Error(`Term "${termId}" not found`);
        // Check for dangling spec references
        const danglingRefs = checkDanglingSpecRefs(workflowRoot, termId);
        if (danglingRefs.length > 0) {
            warnings.push(`${danglingRefs.length} spec entries reference domain="${termId}":\n` +
                danglingRefs.map(r => `  - ${r}`).join('\n'));
        }
        // Check for relationship references from other terms
        const referencedBy = glossary.terms.filter(t => t.id !== termId && t.relationships?.includes(termId));
        if (referencedBy.length > 0) {
            warnings.push(`${referencedBy.length} terms reference "${termId}" in relationships: ` +
                referencedBy.map(t => t.id).join(', '));
        }
        glossary.terms.splice(idx, 1);
        writeGlossary(workflowRoot, glossary);
    });
    return { warnings };
}
export function deprecateTerm(workflowRoot, termId, reason, successorId) {
    updateTerm(workflowRoot, termId, {
        status: 'deprecated',
        deprecated_info: {
            reason,
            ...(successorId ? { successor_id: successorId } : {}),
            deprecated_at: new Date().toISOString(),
        },
    });
}
// ============================================================================
// Validation helpers
// ============================================================================
export function validateGlossaryFile(workflowRoot) {
    const yamlPath = glossaryPath(workflowRoot);
    const jsonPath = glossaryJsonPath(workflowRoot);
    const gPath = existsSync(yamlPath) ? yamlPath : existsSync(jsonPath) ? jsonPath : null;
    if (!gPath)
        return { errors: [{ path: '$', message: 'glossary.yaml not found' }], warnings: [] };
    let data;
    try {
        const raw = readFileSync(gPath, 'utf-8');
        data = gPath.endsWith('.yaml') ? YAML.parse(raw) : JSON.parse(raw);
    }
    catch (e) {
        return { errors: [{ path: '$', message: `parse error: ${e.message}` }], warnings: [] };
    }
    const errors = validateGlossary(data);
    const terms = data.terms;
    const warnings = Array.isArray(terms)
        ? validateRelationships(terms)
        : [];
    return { errors, warnings };
}
// ============================================================================
// Dangling spec reference check
// ============================================================================
function checkDanglingSpecRefs(workflowRoot, termId) {
    const specsDir = join(workflowRoot, 'specs');
    if (!existsSync(specsDir))
        return [];
    const refs = [];
    const needle = `domain="${termId}"`;
    for (const name of readdirSync(specsDir)) {
        if (!name.endsWith('.md'))
            continue;
        const content = readFileSync(join(specsDir, name), 'utf-8');
        if (content.includes(needle))
            refs.push(name);
    }
    return refs;
}
//# sourceMappingURL=domain-loader.js.map