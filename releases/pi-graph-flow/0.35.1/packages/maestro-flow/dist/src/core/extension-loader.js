import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NodeKindRegistry } from '../graph/kg/db/node-kind-registry.js';
import { KnowledgeExtractorRegistry } from '../graph/kg/extraction/knowledge-extractor-registry.js';
export class ExtensionLoader {
    registry;
    loaded = new Map();
    constructor(registry) {
        this.registry = registry;
    }
    async loadFromDir(dir) {
        if (!existsSync(dir))
            return;
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const extPath = join(dir, entry.name);
            await this.loadExtension(extPath);
        }
    }
    async loadExtension(extPath) {
        const entryFile = join(extPath, 'index.js');
        if (!existsSync(entryFile)) {
            console.warn(`Extension at ${extPath} missing index.js, skipping`);
            return;
        }
        try {
            const mod = await import(`file://${entryFile}`);
            const ext = mod.default ?? mod;
            const ctx = {
                registerTool: (tool) => this.registry.register(tool),
                registerNodeKind: (kind, meta) => NodeKindRegistry.register(kind, meta),
                registerKnowledgeExtractor: (entry) => KnowledgeExtractorRegistry.register(entry),
                config: {},
                log: (msg) => console.log(`[ext:${ext.name}] ${msg}`),
            };
            await ext.activate(ctx);
            this.loaded.set(ext.name, ext);
            console.log(`Loaded extension: ${ext.name}@${ext.version}`);
        }
        catch (err) {
            console.error(`Failed to load extension at ${extPath}:`, err);
        }
    }
    async unloadAll() {
        for (const [name, ext] of this.loaded) {
            if (ext.deactivate) {
                await ext.deactivate();
            }
            this.loaded.delete(name);
        }
    }
    listLoaded() {
        return Array.from(this.loaded.keys());
    }
}
//# sourceMappingURL=extension-loader.js.map