import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { extractDomain } from './knowledge/domain-extractor.js';
import { extractSpec } from './knowledge/spec-extractor.js';
import { extractWiki } from './knowledge/wiki-extractor.js';
import { extractCodebase } from './knowledge/codebase-extractor.js';
import { extractIssues } from './knowledge/issue-extractor.js';
class KnowledgeExtractorRegistryImpl {
    registry = new Map();
    constructor() {
        this.registerDefaults();
    }
    registerDefaults() {
        this.register({
            name: 'domain',
            sourceType: 'domain',
            extractFn: extractDomain,
            resolvePath: (wr) => {
                const yaml = resolve(wr, 'domain', 'glossary.yaml');
                const json = resolve(wr, 'domain', 'glossary.json');
                return existsSync(yaml) ? yaml : json;
            },
        });
        this.register({
            name: 'spec',
            sourceType: 'spec',
            extractFn: extractSpec,
            resolvePath: (wr) => resolve(wr, 'specs'),
        });
        this.register({
            name: 'knowhow',
            sourceType: 'knowhow',
            extractFn: extractWiki,
            resolvePath: (wr) => resolve(wr, 'knowhow'),
        });
        this.register({
            name: 'codebase',
            sourceType: 'codebase',
            extractFn: extractCodebase,
            resolvePath: (wr) => resolve(wr, 'codebase'),
        });
        this.register({
            name: 'issue',
            sourceType: 'issue',
            extractFn: extractIssues,
            resolvePath: (wr) => resolve(wr, 'issues', 'issues.jsonl'),
        });
    }
    register(entry) {
        this.registry.set(entry.name, entry);
    }
    unregister(name) {
        return this.registry.delete(name);
    }
    get(name) {
        return this.registry.get(name);
    }
    getAll() {
        return Array.from(this.registry.values());
    }
    has(name) {
        return this.registry.has(name);
    }
    get size() {
        return this.registry.size;
    }
}
export const KnowledgeExtractorRegistry = new KnowledgeExtractorRegistryImpl();
//# sourceMappingURL=knowledge-extractor-registry.js.map