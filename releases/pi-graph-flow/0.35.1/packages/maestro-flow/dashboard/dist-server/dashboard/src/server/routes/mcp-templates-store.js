/**
 * MCP Templates Store — JSON file-based template storage
 * Stores MCP server configurations as reusable templates.
 * Uses a simple JSON file instead of SQLite to avoid native module dependencies.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// Storage path: ~/.maestro/data/mcp-templates.json
const DATA_DIR = join(homedir(), '.maestro', 'data');
const STORE_PATH = join(DATA_DIR, 'mcp-templates.json');
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
async function ensureDir() {
    if (!existsSync(DATA_DIR)) {
        await mkdir(DATA_DIR, { recursive: true });
    }
}
async function loadStore() {
    try {
        const raw = await readFile(STORE_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return { version: 1, nextId: 1, templates: [] };
    }
}
async function saveStore(store) {
    await ensureDir();
    await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function saveTemplate(input) {
    try {
        const store = await loadStore();
        const now = Date.now();
        const existing = store.templates.findIndex((t) => t.name === input.name);
        if (existing >= 0) {
            // Update
            store.templates[existing] = {
                ...store.templates[existing],
                ...input,
                updatedAt: now,
            };
            await saveStore(store);
            return { success: true, id: store.templates[existing].id };
        }
        // Insert
        const id = store.nextId++;
        store.templates.push({
            id,
            name: input.name,
            description: input.description,
            serverConfig: input.serverConfig,
            tags: input.tags,
            category: input.category,
            createdAt: input.createdAt ?? now,
            updatedAt: now,
        });
        await saveStore(store);
        return { success: true, id };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
}
export async function getAllTemplates() {
    const store = await loadStore();
    return store.templates.sort((a, b) => a.name.localeCompare(b.name));
}
export async function getTemplateByName(name) {
    const store = await loadStore();
    return store.templates.find((t) => t.name === name) ?? null;
}
export async function getTemplatesByCategory(category) {
    const store = await loadStore();
    return store.templates
        .filter((t) => t.category === category)
        .sort((a, b) => a.name.localeCompare(b.name));
}
export async function deleteTemplate(name) {
    const store = await loadStore();
    const idx = store.templates.findIndex((t) => t.name === name);
    if (idx < 0)
        return { success: false, error: 'Template not found' };
    store.templates.splice(idx, 1);
    await saveStore(store);
    return { success: true };
}
export async function searchTemplates(keyword) {
    const store = await loadStore();
    const lc = keyword.toLowerCase();
    return store.templates.filter((t) => t.name.toLowerCase().includes(lc) ||
        (t.description?.toLowerCase().includes(lc) ?? false) ||
        (t.tags?.some((tag) => tag.toLowerCase().includes(lc)) ?? false));
}
export async function getAllCategories() {
    const store = await loadStore();
    const cats = new Set();
    for (const t of store.templates) {
        if (t.category)
            cats.add(t.category);
    }
    return [...cats].sort();
}
//# sourceMappingURL=mcp-templates-store.js.map