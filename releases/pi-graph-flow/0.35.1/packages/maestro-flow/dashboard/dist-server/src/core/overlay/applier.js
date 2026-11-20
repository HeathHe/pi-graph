// ---------------------------------------------------------------------------
// Applier — filesystem orchestration for overlay apply/remove.
//
// Reads overlays from `overlayDir`, applies each enabled overlay to its
// declared targets under `<targetBase>/.claude/commands/`, and writes an
// overlay manifest to `~/.maestro/manifests/overlays-<scope>.json`.
//
// Idempotent: re-running with no overlay changes produces byte-identical
// output. Safe to call from install flow or standalone.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, copyFileSync, statSync, } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { paths } from '../../config/paths.js';
import { loadAllOverlays, loadOverlay, validateOverlayMeta } from './loader.js';
import { applyOverlay, removeOverlay as stripMarkers } from './patcher.js';
import { CLAUDE_MD_TARGET, OVERLAY_MANIFEST_VERSION, } from './types.js';
import { injectContent, removeContent } from '../tag-injector.js';
// ---------------------------------------------------------------------------
// Manifest persistence
// ---------------------------------------------------------------------------
function overlayManifestDir() {
    return join(paths.home, 'manifests');
}
function overlayManifestPath(scope, targetBase) {
    const safe = scope === 'global'
        ? 'global'
        : `project-${targetBase.replace(/[:\\/]+/g, '_')}`;
    return join(overlayManifestDir(), `overlays-${safe}.json`);
}
export function loadOverlayManifest(scope, targetBase) {
    const fp = overlayManifestPath(scope, targetBase);
    if (!existsSync(fp))
        return null;
    try {
        return JSON.parse(readFileSync(fp, 'utf-8'));
    }
    catch {
        return null;
    }
}
function saveOverlayManifest(manifest) {
    const dir = overlayManifestDir();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const fp = overlayManifestPath(manifest.scope, manifest.targetBase);
    writeFileSync(fp, JSON.stringify(manifest, null, 2), 'utf-8');
    return fp;
}
export function deleteOverlayManifest(scope, targetBase) {
    const fp = overlayManifestPath(scope, targetBase);
    if (existsSync(fp))
        unlinkSync(fp);
}
// ---------------------------------------------------------------------------
// Target path resolution
// ---------------------------------------------------------------------------
/**
 * Resolve a target name to file path(s) based on the overlay's `cli` field.
 * - _claude-md → `.claude/CLAUDE.md` (routed through tag-injector)
 * - claude → `.claude/commands/{name}.md`
 * - codex  → `.codex/skills/{name}/SKILL.md`
 * - both   → both paths
 */
function resolveTargetPaths(targetBase, targetName, cli) {
    // Special target: CLAUDE.md via tag-injector
    if (targetName === CLAUDE_MD_TARGET) {
        return [{
                path: join(targetBase, '.claude', 'CLAUDE.md'),
                cli: 'claude-md',
            }];
    }
    const result = [];
    if (cli === 'claude' || cli === 'both') {
        result.push({
            path: join(targetBase, '.claude', 'commands', `${targetName}.md`),
            cli: 'claude',
        });
    }
    if (cli === 'codex' || cli === 'both') {
        result.push({
            path: join(targetBase, '.codex', 'skills', targetName, 'SKILL.md'),
            cli: 'codex',
        });
    }
    return result;
}
export function applyOverlays(opts) {
    const log = opts.logger ?? ((msg) => console.error(msg));
    const { overlays, errors: loadErrors } = loadAllOverlays(opts.overlayDir);
    const enabledOverlays = overlays.filter((o) => o.meta.enabled !== false);
    // Sort by priority descending — high-priority overlays are processed first.
    // Overlays without an explicit priority default to 0 (applied last).
    enabledOverlays.sort((a, b) => (b.meta.priority ?? 0) - (a.meta.priority ?? 0));
    const skipped = [];
    const appliedOverlays = [];
    let filesChanged = 0;
    let filesUnchanged = 0;
    const byTarget = new Map();
    const claudeMdEntries = [];
    for (const overlay of enabledOverlays) {
        const cli = overlay.meta.cli ?? 'claude';
        for (const target of overlay.meta.targets) {
            const resolved = resolveTargetPaths(opts.targetBase, target, cli);
            for (const { path: cmdPath, cli: cliType } of resolved) {
                // _claude-md targets are collected separately; the file may not exist yet.
                if (cliType === 'claude-md') {
                    claudeMdEntries.push({ overlay, cmdPath });
                    continue;
                }
                const disabledPath = cmdPath + '.disabled';
                if (!existsSync(cmdPath)) {
                    if (existsSync(disabledPath)) {
                        skipped.push({ overlay: overlay.meta.name, target, reason: 'disabled' });
                    }
                    else {
                        skipped.push({ overlay: overlay.meta.name, target, reason: 'missing' });
                    }
                    continue;
                }
                const list = byTarget.get(cmdPath) ?? [];
                list.push({ overlay, cmdPath });
                byTarget.set(cmdPath, list);
            }
        }
    }
    // Track applied targets per overlay for manifest
    const appliedByOverlay = new Map();
    for (const overlay of enabledOverlays) {
        appliedByOverlay.set(overlay.meta.name, {
            overlayName: overlay.meta.name,
            overlayHash: overlay.hash,
            targets: [],
        });
    }
    // --- Standard command-file targets (patcher) ---
    for (const [cmdPath, entries] of byTarget) {
        let text = readFileSync(cmdPath, 'utf-8');
        const originalText = text;
        const appliedHere = [];
        for (const { overlay } of entries) {
            const result = applyOverlay(text, overlay, cmdPath.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? '', cmdPath);
            text = result.text;
            if (result.applied.markerIds.length > 0) {
                appliedHere.push(result.applied);
                appliedByOverlay.get(overlay.meta.name).targets.push(result.applied);
            }
        }
        if (text !== originalText) {
            writeFileSync(cmdPath, text, 'utf-8');
            filesChanged++;
        }
        else {
            filesUnchanged++;
        }
    }
    // --- CLAUDE.md targets (tag-injector) ---
    if (claudeMdEntries.length > 0) {
        // All _claude-md entries resolve to the same CLAUDE.md path.
        const claudeMdPath = claudeMdEntries[0].cmdPath;
        const claudeMdDir = dirname(claudeMdPath);
        if (!existsSync(claudeMdDir))
            mkdirSync(claudeMdDir, { recursive: true });
        let text = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : '';
        const originalText = text;
        for (const { overlay } of claudeMdEntries) {
            const sectionName = `overlay:${overlay.meta.name}`;
            const sectionsPatched = [];
            // Concatenate all patch contents for this overlay into one section block.
            const combinedContent = overlay.meta.patches
                .map((p) => p.content)
                .join('\n\n');
            text = injectContent(text, combinedContent, sectionName);
            sectionsPatched.push(sectionName);
            const applied = {
                commandName: CLAUDE_MD_TARGET,
                commandPath: claudeMdPath,
                sectionsPatched,
                markerIds: [sectionName],
            };
            appliedByOverlay.get(overlay.meta.name).targets.push(applied);
        }
        if (text !== originalText) {
            writeFileSync(claudeMdPath, text, 'utf-8');
            filesChanged++;
        }
        else {
            filesUnchanged++;
        }
    }
    for (const [, ao] of appliedByOverlay) {
        if (ao.targets.length > 0)
            appliedOverlays.push(ao);
    }
    const manifest = {
        version: OVERLAY_MANIFEST_VERSION,
        scope: opts.scope,
        targetBase: opts.targetBase,
        installedAt: new Date().toISOString(),
        appliedOverlays,
    };
    const manifestPath = saveOverlayManifest(manifest);
    if (loadErrors.length > 0) {
        log(`  Overlay load errors: ${loadErrors.length}`);
        for (const { path, errors } of loadErrors) {
            log(`    ${path}: ${errors.join('; ')}`);
        }
    }
    return {
        manifest,
        manifestPath,
        overlaysLoaded: overlays.length,
        overlaysApplied: appliedOverlays.length,
        filesChanged,
        filesUnchanged,
        loadErrors,
        skipped,
    };
}
/**
 * Remove all marker blocks for the given overlay name from every target
 * command file recorded in the overlay manifest. Updates the manifest.
 */
export function removeOverlayFromTargets(overlayName, scope, targetBase) {
    const manifest = loadOverlayManifest(scope, targetBase);
    if (!manifest)
        return { targetsCleaned: 0, filesChanged: 0 };
    const entry = manifest.appliedOverlays.find((o) => o.overlayName === overlayName);
    if (!entry)
        return { targetsCleaned: 0, filesChanged: 0 };
    let filesChanged = 0;
    for (const tgt of entry.targets) {
        if (!existsSync(tgt.commandPath))
            continue;
        const text = readFileSync(tgt.commandPath, 'utf-8');
        let cleaned;
        if (tgt.commandPath.endsWith('CLAUDE.md')) {
            // CLAUDE.md uses tag-injector markers — remove with removeContent()
            const sectionName = `overlay:${overlayName}`;
            cleaned = removeContent(text, sectionName);
        }
        else {
            // Standard command files use patcher markers
            cleaned = stripMarkers(text, overlayName).text;
        }
        if (cleaned !== text) {
            writeFileSync(tgt.commandPath, cleaned, 'utf-8');
            filesChanged++;
        }
    }
    // Update manifest
    manifest.appliedOverlays = manifest.appliedOverlays.filter((o) => o.overlayName !== overlayName);
    saveOverlayManifest(manifest);
    return { targetsCleaned: entry.targets.length, filesChanged };
}
export function ensureOverlayDir(overlayDir) {
    if (!existsSync(overlayDir))
        mkdirSync(overlayDir, { recursive: true });
    // Ensure docs subdir for overlay-referenced docs
    const docsDir = join(overlayDir, 'docs');
    if (!existsSync(docsDir))
        mkdirSync(docsDir, { recursive: true });
}
/**
 * Export an overlay by name from `overlayDir` to `outPath`.
 *
 * - If `outPath` is a directory, writes `<name>.json` inside it.
 * - If `outPath` is a file path, writes verbatim (overwriting if present).
 * - Throws if the overlay name is not found in `overlayDir`.
 */
export function exportOverlayFile(overlayDir, name, outPath) {
    if (!existsSync(overlayDir)) {
        throw new Error(`Overlay directory not found: ${overlayDir}`);
    }
    // Scan overlayDir (top-level only) for an overlay whose parsed name matches.
    let source = null;
    for (const entry of readdirSync(overlayDir)) {
        if (!entry.endsWith('.json') || entry.startsWith('_'))
            continue;
        const fp = join(overlayDir, entry);
        try {
            const ov = loadOverlay(fp);
            if (ov.meta.name === name) {
                source = fp;
                break;
            }
        }
        catch {
            // Skip unparseable files
        }
    }
    if (!source) {
        throw new Error(`Overlay not found: ${name} (searched ${overlayDir})`);
    }
    let dest = resolve(outPath);
    if (existsSync(dest) && statSync(dest).isDirectory()) {
        dest = join(dest, `${name}.json`);
    }
    const destDir = dirname(dest);
    if (!existsSync(destDir))
        mkdirSync(destDir, { recursive: true });
    copyFileSync(source, dest);
    return { source, dest, overlayName: name };
}
/**
 * Import an overlay JSON file into `overlayDir`. Validates before copy and
 * throws if the file is not a valid overlay. Returns the destination path.
 *
 * Does not auto-apply — callers that want immediate effect should invoke
 * `applyOverlays` afterwards.
 */
export function importOverlayFile(srcPath, overlayDir) {
    const source = resolve(srcPath);
    if (!existsSync(source)) {
        throw new Error(`File not found: ${source}`);
    }
    if (!statSync(source).isFile()) {
        throw new Error(`Not a file: ${source}`);
    }
    // Validate (throws OverlayLoadError on failure).
    const overlay = loadOverlay(source);
    ensureOverlayDir(overlayDir);
    // Use the overlay's declared name as filename for consistency on disk.
    const dest = join(overlayDir, `${overlay.meta.name}.json`);
    const overwritten = existsSync(dest) && resolve(dest) !== source;
    if (resolve(dest) !== source) {
        copyFileSync(source, dest);
    }
    return {
        source,
        dest,
        overlayName: overlay.meta.name,
        overwritten,
    };
}
/**
 * Bundle all (or selected) overlays from `overlayDir` into a single JSON file.
 * Includes any files under `overlayDir/docs/` that are referenced by overlay
 * patch content via `@~/.maestro/overlays/docs/` paths.
 */
export function bundleOverlays(overlayDir, outPath, names) {
    const { overlays } = loadAllOverlays(overlayDir);
    const selected = names
        ? overlays.filter((o) => names.includes(o.meta.name))
        : overlays;
    if (selected.length === 0) {
        throw new Error(names ? `No matching overlays found for: ${names.join(', ')}` : 'No overlays to bundle');
    }
    // Collect referenced docs from patch content
    const DOC_REF_RE = /@~\/\.maestro\/overlays\/docs\/([^\s)]+)/g;
    const referencedDocs = new Set();
    for (const ov of selected) {
        for (const patch of ov.meta.patches) {
            let m;
            DOC_REF_RE.lastIndex = 0;
            while ((m = DOC_REF_RE.exec(patch.content)) !== null) {
                referencedDocs.add(m[1]);
            }
        }
    }
    // Read doc files
    const docs = {};
    const docsDir = join(overlayDir, 'docs');
    for (const docName of referencedDocs) {
        const docPath = join(docsDir, docName);
        if (existsSync(docPath)) {
            docs[docName] = readFileSync(docPath, 'utf-8');
        }
    }
    const bundle = {
        version: '1.0',
        overlays: selected.map((o) => o.meta),
        docs,
    };
    let dest = resolve(outPath);
    if (existsSync(dest) && statSync(dest).isDirectory()) {
        dest = join(dest, 'overlays-bundle.json');
    }
    const destDir = dirname(dest);
    if (!existsSync(destDir))
        mkdirSync(destDir, { recursive: true });
    writeFileSync(dest, JSON.stringify(bundle, null, 2), 'utf-8');
    return { dest, overlayCount: selected.length, docCount: Object.keys(docs).length };
}
/**
 * Import a bundle file, writing each overlay as an individual JSON file into
 * `overlayDir` and restoring any bundled docs into `overlayDir/docs/`.
 */
export function importBundle(bundlePath, overlayDir) {
    const source = resolve(bundlePath);
    if (!existsSync(source))
        throw new Error(`Bundle file not found: ${source}`);
    const raw = readFileSync(source, 'utf-8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Invalid JSON in bundle: ${err instanceof Error ? err.message : String(err)}`);
    }
    const obj = parsed;
    if (obj.version !== '1.0' || !Array.isArray(obj.overlays)) {
        throw new Error('Invalid bundle format: expected { version: "1.0", overlays: [...] }');
    }
    ensureOverlayDir(overlayDir);
    // Validate and write each overlay
    const items = [];
    const errors = [];
    for (const meta of obj.overlays) {
        const validationErrors = validateOverlayMeta(meta);
        if (validationErrors.length > 0) {
            const name = meta?.name ?? '(unknown)';
            errors.push(`${name}: ${validationErrors.join('; ')}`);
            continue;
        }
        const overlayMeta = meta;
        const dest = join(overlayDir, `${overlayMeta.name}.json`);
        const overwritten = existsSync(dest);
        writeFileSync(dest, JSON.stringify(overlayMeta, null, 2), 'utf-8');
        items.push({ name: overlayMeta.name, overwritten });
    }
    if (errors.length > 0 && items.length === 0) {
        throw new Error(`All overlays in bundle are invalid:\n  ${errors.join('\n  ')}`);
    }
    // Restore docs
    let docsWritten = 0;
    const docs = obj.docs;
    if (docs && typeof docs === 'object') {
        const docsDir = join(overlayDir, 'docs');
        if (!existsSync(docsDir))
            mkdirSync(docsDir, { recursive: true });
        for (const [name, content] of Object.entries(docs)) {
            if (typeof content !== 'string')
                continue;
            // Sanitize: no path traversal
            if (name.includes('..') || name.startsWith('/'))
                continue;
            writeFileSync(join(docsDir, name), content, 'utf-8');
            docsWritten++;
        }
    }
    return { source, items, docsWritten };
}
//# sourceMappingURL=applier.js.map