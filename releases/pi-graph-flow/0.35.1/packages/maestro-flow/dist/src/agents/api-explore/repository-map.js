import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildScanScope } from '../../graph/kg/extraction/code/scan-scope.js';
import { isStructuredPrompt, parseStructuredPrompt } from './prompt-parser.js';
export const DEFAULT_REPOSITORY_MAP_DEPTH = 3;
export const MAX_REPOSITORY_MAP_DEPTH = 6;
export const DEFAULT_REPOSITORY_MAP_BYTES = 32 * 1024;
const TRUNCATION_MARKER = '… (repository map truncated)';
const EXPLICIT_FILE_PATH_PATTERN = /(?:[A-Za-z]:[\\/])?(?:[\w@.+-]+[\\/])+[\w@.+-]+\.[A-Za-z0-9]+/g;
export function normalizeRepositoryMapDepth(value, fallback = DEFAULT_REPOSITORY_MAP_DEPTH) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(MAX_REPOSITORY_MAP_DEPTH, Math.max(1, Math.trunc(value)));
}
function sanitizeEntryName(name) {
    return name.replace(/[\r\n\t`]/g, ' ');
}
function isWithin(parent, candidate) {
    const rel = relative(parent, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function stripGlobSuffix(path) {
    const normalized = path.replace(/\\/g, '/');
    const wildcard = normalized.search(/[*?{[]/);
    if (wildcard < 0)
        return normalized;
    const prefix = normalized.slice(0, wildcard);
    return prefix.slice(0, prefix.lastIndexOf('/') + 1) || '.';
}
function resolveRepositoryFocus(root, paths) {
    const focuses = [];
    const seen = new Set();
    for (const rawPath of paths) {
        const cleaned = stripGlobSuffix(rawPath.trim().replace(/^[`'\"]|[`'\"]$/g, ''));
        if (!cleaned)
            continue;
        const target = resolve(root, cleaned);
        if (!isWithin(root, target) || !existsSync(target))
            continue;
        let isDirectory = false;
        try {
            isDirectory = statSync(target).isDirectory();
        }
        catch {
            continue;
        }
        const focusRoot = isDirectory ? target : dirname(target);
        const key = `${target}\0${focusRoot}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        focuses.push({ target, root: focusRoot, isDirectory });
    }
    return focuses;
}
function pathDepth(parent, child) {
    const rel = relative(parent, child);
    return rel ? rel.split(/[\\/]+/).filter(Boolean).length : 0;
}
function focusPriority(path, isDirectory, focuses) {
    if (focuses.some(focus => path === focus.target))
        return 0;
    if (focuses.some(focus => isWithin(path, focus.target)))
        return 1;
    if (focuses.some(focus => focus.isDirectory && isWithin(focus.root, path)))
        return 2;
    return isDirectory ? 3 : 4;
}
export function extractRepositoryMapFocusPaths(prompts) {
    const paths = [];
    for (const prompt of prompts) {
        if (isStructuredPrompt(prompt)) {
            const scope = parseStructuredPrompt(prompt).scope;
            if (scope) {
                paths.push(...scope.split(/[,\n]/).map(part => part.trim()).filter(Boolean));
            }
        }
        // Exact files are often named in FIND rather than SCOPE. Preserve them as
        // evidence targets even when their parent directory is gitignored.
        paths.push(...(prompt.match(EXPLICIT_FILE_PATH_PATTERN) ?? []));
    }
    return [...new Set(paths)];
}
export function extractExplicitFilePaths(prompt) {
    return [...new Set(prompt.match(EXPLICIT_FILE_PATH_PATTERN) ?? [])]
        .map(path => path.replace(/\\/g, '/'));
}
function renderRepositoryTree(root, scope, focuses, depth, maxBytes) {
    const rootLabel = `${basename(root) || root}/`;
    const lines = [rootLabel];
    let sizeBytes = Buffer.byteLength(rootLabel, 'utf-8');
    let overflowed = false;
    function append(line) {
        const addedBytes = Buffer.byteLength(`\n${line}`, 'utf-8');
        if (sizeBytes + addedBytes > maxBytes) {
            overflowed = true;
            return false;
        }
        lines.push(line);
        sizeBytes += addedBytes;
        return true;
    }
    function shouldDescend(dir, level) {
        if (level < depth)
            return true;
        return focuses.some((focus) => {
            if (isWithin(dir, focus.root))
                return true;
            return isWithin(focus.root, dir) && pathDepth(focus.root, dir) < depth;
        });
    }
    function walk(dir, level, prefix) {
        if (!shouldDescend(dir, level) || overflowed)
            return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true })
                .filter(entry => !scope.ignores(join(dir, entry.name), entry.isDirectory()))
                .sort((a, b) => {
                const aPriority = focusPriority(join(dir, a.name), a.isDirectory(), focuses);
                const bPriority = focusPriority(join(dir, b.name), b.isDirectory(), focuses);
                if (aPriority !== bPriority)
                    return aPriority - bPriority;
                return a.name.localeCompare(b.name, 'en');
            });
        }
        catch {
            return;
        }
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const safeName = sanitizeEntryName(entry.name);
            const label = entry.isDirectory() ? `${safeName}/` : safeName;
            if (!append(`${prefix}${connector}${label}`))
                return;
            if (entry.isDirectory()) {
                walk(join(dir, entry.name), level + 1, `${prefix}${isLast ? '    ' : '│   '}`);
            }
            if (overflowed)
                return;
        }
    }
    walk(root, 0, '');
    return { tree: lines.join('\n'), sizeBytes, overflowed };
}
/**
 * Build an ignore-aware repository tree for the first explore prompt.
 * The requested depth is reduced until the map fits the prompt budget.
 */
export function buildRepositoryMap(cwd, options = {}) {
    const root = resolve(cwd);
    const targetDepth = normalizeRepositoryMapDepth(options.targetDepth);
    const maxBytes = Math.max(256, Math.trunc(options.maxBytes ?? DEFAULT_REPOSITORY_MAP_BYTES));
    const focuses = resolveRepositoryFocus(root, options.focusPaths ?? []);
    let scope;
    try {
        scope = buildScanScope({
            projectRoot: root,
            srcDir: root,
            createMaestroIgnore: false,
        });
    }
    catch {
        const tree = `${basename(root) || root}/\n└── (unable to list repository)`;
        return {
            tree,
            depth: 0,
            sizeBytes: Buffer.byteLength(tree, 'utf-8'),
            fellBack: true,
            truncated: false,
            focusCount: focuses.length,
            directReadPaths: [],
        };
    }
    const directReadPaths = focuses
        .filter(focus => !focus.isDirectory && scope.ignores(focus.target, false))
        .map(focus => relative(root, focus.target).replace(/\\/g, '/'));
    for (let depth = targetDepth; depth >= 1; depth--) {
        try {
            const rendered = renderRepositoryTree(root, scope, focuses, depth, maxBytes);
            if (!rendered.overflowed) {
                return {
                    ...rendered,
                    depth,
                    fellBack: depth < targetDepth,
                    truncated: false,
                    focusCount: focuses.length,
                    directReadPaths,
                };
            }
            if (depth === 1) {
                const lines = rendered.tree.split('\n');
                let tree = `${lines.join('\n')}\n${TRUNCATION_MARKER}`;
                while (lines.length > 1 && Buffer.byteLength(tree, 'utf-8') > maxBytes) {
                    lines.pop();
                    tree = `${lines.join('\n')}\n${TRUNCATION_MARKER}`;
                }
                return {
                    ...rendered,
                    tree,
                    sizeBytes: Buffer.byteLength(tree, 'utf-8'),
                    depth,
                    fellBack: depth < targetDepth,
                    truncated: true,
                    focusCount: focuses.length,
                    directReadPaths,
                };
            }
        }
        catch {
            break;
        }
    }
    const tree = `${basename(root) || root}/\n└── (unable to list repository)`;
    return {
        tree,
        depth: 0,
        sizeBytes: Buffer.byteLength(tree, 'utf-8'),
        fellBack: true,
        truncated: false,
        focusCount: focuses.length,
        directReadPaths,
    };
}
//# sourceMappingURL=repository-map.js.map