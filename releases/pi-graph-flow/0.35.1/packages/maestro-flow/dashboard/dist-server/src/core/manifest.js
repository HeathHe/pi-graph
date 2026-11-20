// ---------------------------------------------------------------------------
// Installation Manifest
// Tracks installed files for clean reinstall and uninstall.
// Manifests stored at ~/.maestro/manifests/{id}.json
//
// Manifest is the single source of truth for an installation. Every install
// step (files, hooks, MCP, statusline) records itself here so uninstall can
// reverse exactly what was installed — no marker scanning, no guesswork.
// ---------------------------------------------------------------------------
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync, rmSync, } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { paths } from '../config/paths.js';
import { hasAnyMarkers, removeAllSections } from './tag-injector.js';
/** Current manifest schema version. */
const SCHEMA_VERSION = '2.0';
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const MANIFESTS_DIR = join(paths.home, 'manifests');
const MANIFEST_LOCK = join(MANIFESTS_DIR, '.install.lock');
const MANIFEST_LOCK_STALE_MS = 5 * 60_000;
function ensureDir() {
    if (!existsSync(MANIFESTS_DIR)) {
        mkdirSync(MANIFESTS_DIR, { recursive: true });
    }
}
export function manifestFile(id) {
    return join(MANIFESTS_DIR, `${id}.json`);
}
// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
export function createManifest(scope, targetPath, opts) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
    return {
        id: `${scope}-${ts}-${randomUUID().slice(0, 8)}`,
        version: SCHEMA_VERSION,
        scope,
        targetPath,
        installedAt: new Date().toISOString(),
        entries: [],
        hookLevel: opts?.hookLevel,
        selectedComponentIds: opts?.selectedComponentIds,
        knownComponentIds: opts?.knownComponentIds,
    };
}
function installManifestFiles() {
    if (!existsSync(MANIFESTS_DIR))
        return [];
    // Overlay state is stored in the same directory using overlays-*.json and
    // is not an installation manifest. Never parse or delete it here.
    return readdirSync(MANIFESTS_DIR)
        .filter((file) => /^(global|project)-.+\.json$/.test(file));
}
function acquireManifestLock() {
    try {
        writeFileSync(MANIFEST_LOCK, String(process.pid), { flag: 'wx' });
        return;
    }
    catch {
        try {
            if (Date.now() - statSync(MANIFEST_LOCK).mtimeMs > MANIFEST_LOCK_STALE_MS) {
                unlinkSync(MANIFEST_LOCK);
                writeFileSync(MANIFEST_LOCK, String(process.pid), { flag: 'wx' });
                return;
            }
        }
        catch { /* fall through to the explicit lock error */ }
        throw new Error(`Installation manifest is locked: ${MANIFEST_LOCK}`);
    }
}
function releaseManifestLock() {
    try {
        if (existsSync(MANIFEST_LOCK)
            && readFileSync(MANIFEST_LOCK, 'utf-8').trim() === String(process.pid)) {
            unlinkSync(MANIFEST_LOCK);
        }
    }
    catch { /* lock expires and can be reclaimed if cleanup is interrupted */ }
}
export function addFile(manifest, filePath, meta) {
    const existing = manifest.entries.find((entry) => entry.type === 'file' && entry.path === filePath);
    if (existing) {
        // Keep the recorded content fingerprint fresh on every write (inject updates).
        if (meta?.hash)
            existing.hash = meta.hash;
        return;
    }
    manifest.entries.push({ path: filePath, type: 'file', ...(meta?.hash ? { hash: meta.hash } : {}) });
}
export function addDir(manifest, dirPath) {
    if (!manifest.entries.some((entry) => entry.type === 'dir' && entry.path === dirPath)) {
        manifest.entries.push({ path: dirPath, type: 'dir' });
    }
}
// --- Extended tracking helpers ---
export function recordClaudeHooks(manifest, record) {
    manifest.hooks ??= {};
    manifest.hooks.claude = record;
}
export function recordCodexHooks(manifest, record) {
    manifest.hooks ??= {};
    manifest.hooks.codex = record;
}
export function recordAgyHooks(manifest, record) {
    manifest.hooks ??= {};
    manifest.hooks.agy = record;
}
export function recordGenericHooks(manifest, platformId, record) {
    manifest.hooks ??= {};
    manifest.hooks.generic ??= {};
    manifest.hooks.generic[platformId] = record;
}
export function recordStatusline(manifest, record) {
    manifest.statusline = record;
}
export function recordClaudeMcp(manifest, record) {
    manifest.mcp ??= {};
    manifest.mcp.claude = record;
}
export function recordCodexMcp(manifest, record) {
    manifest.mcp ??= {};
    manifest.mcp.codex = record;
}
export function uniqueExtraMcpRecords(records) {
    const byId = new Map();
    for (const record of records ?? []) {
        byId.set(record.targetId, record);
    }
    return [...byId.values()];
}
export function uniqueExtraMcpTargetIds(records) {
    return uniqueExtraMcpRecords(records).map((record) => record.targetId);
}
export function recordExtraMcp(manifest, record) {
    manifest.mcp ??= {};
    manifest.mcp.extras ??= [];
    const idx = manifest.mcp.extras.findIndex((entry) => entry.targetId === record.targetId);
    if (idx >= 0) {
        manifest.mcp.extras[idx] = record;
        return;
    }
    manifest.mcp.extras.push(record);
}
// --- Save / Load ---
/** 锁内保存:fencing 校验 + 写新文件 + 原子晋升 + 清理旧记录(不取锁)。 */
function saveManifestLocked(manifest, opts) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'expectedPriorId')) {
        const currentId = findManifest(manifest.scope, manifest.targetPath)?.id ?? null;
        if (currentId !== opts.expectedPriorId) {
            throw new Error(`Installation manifest changed concurrently (expected ${opts.expectedPriorId ?? 'none'}, found ${currentId ?? 'none'}).`);
        }
    }
    // Never overwrite an existing manifest in place. A unique destination keeps
    // the previous installation record recoverable until the new record is
    // completely written and atomically promoted.
    if (existsSync(manifestFile(manifest.id))) {
        manifest.id = `${manifest.scope}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    }
    const fp = manifestFile(manifest.id);
    const tempPath = `${fp}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
        writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
        renameSync(tempPath, fp);
    }
    catch (error) {
        if (existsSync(tempPath))
            unlinkSync(tempPath);
        throw error;
    }
    // Cleanup happens only after the replacement is durable. If cleanup is
    // interrupted, findManifest() deterministically selects the newest record.
    removeOld(manifest.scope, manifest.targetPath, fp);
    return fp;
}
export function saveManifest(manifest, opts) {
    ensureDir();
    acquireManifestLock();
    try {
        return saveManifestLocked(manifest, opts);
    }
    finally {
        releaseManifestLock();
    }
}
/**
 * 读-改-写在同一把 manifest 锁内完成,并发更新串行化——
 * 不会像 read-merge-save 快照相撞那样丢记录(如 hooks install
 * --target grok 与 --target cursor 并发)。
 */
export function updateManifest(scope, targetPath, mutate) {
    ensureDir();
    acquireManifestLock();
    try {
        const manifest = findManifest(scope, targetPath) ?? createManifest(scope, targetPath);
        mutate(manifest);
        return saveManifestLocked(manifest);
    }
    finally {
        releaseManifestLock();
    }
}
function removeOld(scope, targetPath, keepPath) {
    if (!existsSync(MANIFESTS_DIR))
        return;
    const norm = targetPath.toLowerCase().replace(/[\\/]+$/, '');
    for (const f of installManifestFiles()) {
        const candidatePath = join(MANIFESTS_DIR, f);
        if (keepPath && candidatePath === keepPath)
            continue;
        try {
            const m = JSON.parse(readFileSync(candidatePath, 'utf-8'));
            if (m.scope === scope && m.targetPath.toLowerCase().replace(/[\\/]+$/, '') === norm) {
                unlinkSync(candidatePath);
            }
        }
        catch { /* skip */ }
    }
}
export function findManifest(scope, targetPath) {
    if (!existsSync(MANIFESTS_DIR))
        return null;
    const norm = targetPath.toLowerCase().replace(/[\\/]+$/, '');
    const matches = [];
    for (const f of installManifestFiles()) {
        try {
            const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf-8'));
            m.entries ??= [];
            if (m.scope === scope && m.targetPath.toLowerCase().replace(/[\\/]+$/, '') === norm) {
                matches.push(m);
            }
        }
        catch { /* skip */ }
    }
    matches.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
    return matches[0] ?? null;
}
export function getAllManifests() {
    if (!existsSync(MANIFESTS_DIR))
        return [];
    const results = [];
    for (const f of installManifestFiles()) {
        try {
            const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf-8'));
            m.entries ??= [];
            // Skip corrupt manifests (no targetPath or no entries)
            if (!m.targetPath || !m.scope) {
                unlinkSync(join(MANIFESTS_DIR, f));
                continue;
            }
            results.push(m);
        }
        catch { /* skip */ }
    }
    return results.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
}
export function deleteManifest(manifest) {
    const fp = manifestFile(manifest.id);
    if (existsSync(fp))
        unlinkSync(fp);
}
// ---------------------------------------------------------------------------
// Cleanup — remove files recorded in a manifest
// ---------------------------------------------------------------------------
/** Files to preserve even during cleanup. */
const PRESERVE = new Set(['settings.json', 'settings.local.json']);
/** Files that should have maestro content removed via tag injection instead of being deleted entirely. */
const CONTENT_MANAGED = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md', 'maestro.md']);
/**
 * Remove maestro-injected content from a doc file using `<!-- maestro:start/end -->` markers.
 *
 * Safety rules:
 * - Marker-free files are treated as user-owned and preserved — ownership
 *   cannot be proven from markers, so they are never deleted.
 * - Markers prove ownership of their sections only. Even when the surrounding
 *   file changed after install, those sections can be removed safely while
 *   preserving all user content outside them.
 * - Deletes the file only when nothing but Maestro content remains.
 */
function cleanInjectedDoc(filePath) {
    if (!existsSync(filePath))
        return 'none';
    const content = readFileSync(filePath, 'utf-8');
    if (!hasAnyMarkers(content)) {
        // No markers — the file was replaced with user content (or is a legacy
        // pre-marker install). Deleting it would destroy user data.
        console.warn(`  [warn] Preserved ${filePath}: no Maestro markers — user-owned file left untouched.`);
        return 'preserved';
    }
    const cleaned = removeAllSections(content);
    if (!cleaned || cleaned.trim() === '') {
        // Nothing left after removing all maestro sections — delete the file
        unlinkSync(filePath);
        return 'removed';
    }
    // User content remains — write back without maestro sections
    writeFileSync(filePath, cleaned, 'utf-8');
    return 'removed';
}
/**
 * @param skipContentManaged If true, skip CONTENT_MANAGED files (CLAUDE.md, AGENTS.md).
 *   Use during re-install — tag injection updates in-place, so no cleanup needed.
 *   Default false (full cleanup, used by uninstall).
 */
export function cleanManifestFiles(manifest, opts) {
    let removed = 0;
    let preserved = 0;
    let skipped = 0;
    let errors = 0;
    // Remove files first (deepest paths first)
    const files = manifest.entries
        .filter(e => e.type === 'file')
        .sort((a, b) => b.path.length - a.path.length);
    for (const entry of files) {
        const name = entry.path.split(/[\\/]/).pop() ?? '';
        if (PRESERVE.has(name)) {
            skipped++;
            continue;
        }
        // Content-managed files: skip during re-install, clean during uninstall.
        // Entries with a recorded hash are inject-managed even when the basename
        // is not in the known set (custom context file names).
        if (CONTENT_MANAGED.has(name) || !!entry.hash) {
            if (opts?.skipContentManaged) {
                skipped++;
                continue;
            }
            try {
                const action = cleanInjectedDoc(entry.path);
                if (action === 'removed')
                    removed++;
                else if (action === 'preserved')
                    preserved++;
            }
            catch (err) {
                errors++;
                console.error(`  [warn] Failed to clean ${entry.path}: ${err instanceof Error ? err.message : err}`);
            }
            continue;
        }
        try {
            if (existsSync(entry.path)) {
                unlinkSync(entry.path);
                removed++;
            }
        }
        catch (err) {
            errors++;
            console.error(`  [warn] Failed to remove ${entry.path}: ${err instanceof Error ? err.message : err}`);
        }
    }
    // Remove empty directories (deepest first)
    const dirs = manifest.entries
        .filter(e => e.type === 'dir')
        .sort((a, b) => b.path.length - a.path.length);
    for (const entry of dirs) {
        try {
            if (existsSync(entry.path)) {
                const contents = readdirSync(entry.path);
                if (contents.length === 0) {
                    rmSync(entry.path, { recursive: true });
                    removed++;
                }
            }
        }
        catch (err) {
            errors++;
            console.error(`  [warn] Failed to remove dir ${entry.path}: ${err instanceof Error ? err.message : err}`);
        }
    }
    return { removed, preserved, skipped, errors };
}
//# sourceMappingURL=manifest.js.map