import { beforeEach, describe, expect, it, vi } from 'vitest';
const fakes = vi.hoisted(() => ({
    indexers: [],
    writers: [],
}));
vi.mock('../wiki/wiki-indexer.js', () => {
    class WikiIndexer {
        workflowRoot;
        get = vi.fn(async () => ({
            entries: [],
            byId: {},
            backlinks: {},
            generatedAt: Date.now(),
        }));
        query = vi.fn(async () => [{ id: `entry:${this.workflowRoot}` }]);
        invalidate = vi.fn();
        constructor(config) {
            this.workflowRoot = config.workflowRoot;
            fakes.indexers.push(this);
        }
    }
    return { WikiIndexer };
});
vi.mock('../wiki/writer.js', () => {
    class WikiWriteError extends Error {
        code;
        details;
        constructor(code, message, details) {
            super(message);
            this.code = code;
            this.details = details;
        }
    }
    class WikiWriter {
        workflowRoot;
        create = vi.fn(async () => ({
            id: `created:${this.workflowRoot}`,
            source: { path: `specs/${this.workflowRoot}.md` },
        }));
        appendEntry = vi.fn(async () => ({ id: `appended:${this.workflowRoot}` }));
        constructor(workflowRoot, _indexer) {
            this.workflowRoot = workflowRoot;
            fakes.writers.push(this);
        }
    }
    return { WikiWriter, WikiWriteError };
});
import { DashboardEventBus } from '../state/event-bus.js';
import { createSpecsRoutes } from './specs.js';
import { createSharedWikiWriter } from './wiki.js';
describe('shared wiki workspace runtime', () => {
    beforeEach(() => {
        fakes.indexers.length = 0;
        fakes.writers.length = 0;
    });
    it('creates one runtime and resolves the switched context for wiki and specs requests', async () => {
        let workflowRoot = 'workspace-a';
        const bus = new DashboardEventBus();
        const shared = createSharedWikiWriter(() => workflowRoot, bus);
        const specsRoutes = createSpecsRoutes(() => workflowRoot, shared.getContext);
        try {
            expect(fakes.indexers).toHaveLength(1);
            expect(fakes.writers).toHaveLength(1);
            const oldIndexer = fakes.indexers[0];
            const oldWriter = fakes.writers[0];
            const firstWiki = await shared.routes.request('/api/wiki');
            expect(firstWiki.status).toBe(200);
            expect(oldIndexer.query).toHaveBeenCalledTimes(1);
            const firstSpec = await specsRoutes.request('/api/specs', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ type: 'learning', content: 'first', file: 'learnings' }),
            });
            expect(firstSpec.status).toBe(201);
            expect(oldWriter.appendEntry).toHaveBeenCalledTimes(1);
            workflowRoot = 'workspace-b';
            bus.emit('workspace:switched', { workspace: workflowRoot });
            expect(fakes.indexers).toHaveLength(2);
            expect(fakes.writers).toHaveLength(2);
            const currentIndexer = fakes.indexers[1];
            const currentWriter = fakes.writers[1];
            expect(shared.getContext().workflowRoot).toBe('workspace-b');
            const secondWiki = await shared.routes.request('/api/wiki');
            expect(secondWiki.status).toBe(200);
            expect(oldIndexer.query).toHaveBeenCalledTimes(1);
            expect(currentIndexer.query).toHaveBeenCalledTimes(1);
            const secondSpec = await specsRoutes.request('/api/specs', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ type: 'learning', content: 'second', file: 'learnings' }),
            });
            expect(secondSpec.status).toBe(201);
            expect(oldWriter.appendEntry).toHaveBeenCalledTimes(1);
            expect(currentWriter.appendEntry).toHaveBeenCalledTimes(1);
        }
        finally {
            shared.dispose();
        }
    });
    it('unsubscribes workspace and invalidation listeners on dispose', () => {
        let workflowRoot = 'workspace-a';
        const bus = new DashboardEventBus();
        const shared = createSharedWikiWriter(() => workflowRoot, bus);
        const contextAtDispose = shared.getContext();
        const indexerAtDispose = fakes.indexers[0];
        shared.dispose();
        shared.dispose();
        workflowRoot = 'workspace-b';
        bus.emit('workspace:switched', { workspace: workflowRoot });
        bus.emit('wiki:invalidated', { at: Date.now(), path: 'specs/change.md' });
        expect(shared.getContext()).toBe(contextAtDispose);
        expect(fakes.indexers).toHaveLength(1);
        expect(fakes.writers).toHaveLength(1);
        expect(indexerAtDispose.invalidate).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=wiki-workspace.integration.test.js.map