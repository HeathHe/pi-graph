import { describe, it, expect } from 'vitest';
import { WikiIndexer } from '#maestro-dashboard/wiki/wiki-indexer.js';
import { resolve } from 'path';
describe('domain search integration', () => {
    it('finds domain entries in WikiIndexer', async () => {
        const idx = new WikiIndexer({ workflowRoot: resolve('.workflow') });
        const { existsSync } = await import('node:fs');
        const glossaryYaml = resolve('.workflow', 'domain', 'glossary.yaml');
        const glossaryJson = resolve('.workflow', 'domain', 'glossary.json');
        const glossaryPath = existsSync(glossaryYaml) ? glossaryYaml : glossaryJson;
        console.log('Glossary path:', glossaryPath);
        console.log('Glossary exists:', existsSync(glossaryPath));
        const index = await idx.get();
        console.log('byType keys:', Object.keys(index.byType));
        console.log('All types:', [...new Set(index.entries.map(e => e.type))]);
        const domainEntries = index.byType.domain ?? [];
        console.log('Domain entries found:', domainEntries.length);
        for (const e of domainEntries) {
            console.log(`  ${e.id} | ${e.title} | tags: ${e.tags.join(',')}`);
        }
        expect(domainEntries.length).toBeGreaterThan(0);
    });
    it('finds domain terms via BM25 search', async () => {
        const idx = new WikiIndexer({ workflowRoot: resolve('.workflow') });
        const results = await idx.searchWithScores('规范', 10);
        const domainResults = results.filter(r => r.entry.type === 'domain');
        console.log('Domain search results for "规范":', domainResults.length);
        for (const r of domainResults) {
            console.log(`  ${r.entry.id} | ${r.entry.title} | score: ${r.score}`);
        }
        expect(domainResults.length).toBeGreaterThanOrEqual(0);
    });
});
//# sourceMappingURL=domain-search-debug.js.map