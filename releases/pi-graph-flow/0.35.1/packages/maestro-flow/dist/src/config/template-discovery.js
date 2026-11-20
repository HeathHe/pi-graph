// ---------------------------------------------------------------------------
// Template Discovery — scans and caches CLI prompt templates and protocols
// ---------------------------------------------------------------------------
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { paths } from './paths.js';
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cachedIndex = null;
// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------
/**
 * Resolve the templates directory.
 * Priority: global ~/.maestro/templates/cli/ > package-local templates/cli/
 */
function getTemplatesDir() {
    const global = resolve(paths.home, 'templates', 'cli');
    if (existsSync(global))
        return global;
    // From dist/src/config/ → 3 levels up to package root
    return resolve(import.meta.dirname ?? __dirname, '..', '..', '..', 'templates', 'cli');
}
export function getPromptsDir() {
    return resolve(getTemplatesDir(), 'prompts');
}
export function getProtocolsDir() {
    return resolve(getTemplatesDir(), 'protocols');
}
// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
/**
 * Scan the prompts directory and build an in-memory index of templates.
 * Results are cached — call with forceRescan=true to invalidate.
 */
export async function scanTemplates(forceRescan = false) {
    if (cachedIndex && !forceRescan) {
        return cachedIndex.templates;
    }
    const promptsDir = getPromptsDir();
    const templates = new Map();
    try {
        const files = await readdir(promptsDir);
        for (const file of files) {
            if (extname(file) !== '.txt')
                continue;
            const name = basename(file, '.txt');
            const category = name.split('-')[0] ?? 'unknown';
            templates.set(name, {
                name,
                category,
                path: resolve(promptsDir, file),
            });
        }
    }
    catch {
        // templates dir may not exist — return empty index
    }
    cachedIndex = { templates, scannedAt: Date.now() };
    return templates;
}
// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
/**
 * Find a template by full name or short name (without category prefix).
 * Returns the TemplateMeta or undefined.
 */
export async function findTemplate(nameOrShort) {
    const templates = await scanTemplates();
    // Exact match
    if (templates.has(nameOrShort)) {
        return templates.get(nameOrShort);
    }
    // Short name match: try each category prefix
    for (const [fullName, meta] of templates) {
        const shortName = fullName.replace(/^[^-]+-/, '');
        if (shortName === nameOrShort) {
            return meta;
        }
    }
    return undefined;
}
/**
 * Load a template file content by name (full or short).
 * Returns the file content or null if not found.
 */
export async function loadTemplate(nameOrShort) {
    const meta = await findTemplate(nameOrShort);
    if (!meta)
        return null;
    try {
        return await readFile(meta.path, 'utf-8');
    }
    catch {
        return null;
    }
}
/**
 * Load a mode-specific protocol file.
 * Returns the protocol content or null if not found.
 */
export async function loadProtocol(mode) {
    const protocolPath = resolve(getProtocolsDir(), `${mode}-protocol.md`);
    try {
        return await readFile(protocolPath, 'utf-8');
    }
    catch {
        return null;
    }
}
/**
 * List all available template names grouped by category.
 */
export async function listTemplates() {
    const templates = await scanTemplates();
    const grouped = {};
    for (const meta of templates.values()) {
        if (!grouped[meta.category]) {
            grouped[meta.category] = [];
        }
        grouped[meta.category].push(meta.name);
    }
    return grouped;
}
//# sourceMappingURL=template-discovery.js.map