import { describe, it, expect } from 'vitest';
import { createSupervisorRoutes } from './supervisor.js';
// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------
class MockLearningService {
    stats = {
        totalCommands: 5,
        uniquePatterns: 2,
        topPatterns: [
            { command: 'gemini', frequency: 3, successRate: 0.9, avgDuration: 5000, lastUsed: '2026-01-01T00:00:00Z', contexts: ['a'] },
            { command: 'codex', frequency: 2, successRate: 1.0, avgDuration: 3000, lastUsed: '2026-01-01T01:00:00Z', contexts: ['b'] },
        ],
        suggestions: [],
        knowledgeBaseSize: 1,
    };
    patterns = this.stats.topPatterns;
    kb = [
        { id: 'kb-1', topic: 'Testing', content: 'Use vitest', source: 'manual', usageCount: 0, lastAccessed: '2026-01-01T00:00:00Z', tags: ['test'] },
    ];
    getStats() { return this.stats; }
    getPatterns() { return this.patterns; }
    getKnowledgeBase() { return this.kb; }
}
class MockSchedulerService {
    tasks = new Map();
    nextId = 1;
    listTasks() { return Array.from(this.tasks.values()); }
    async createTask(input) {
        const task = {
            ...input,
            id: `task-${this.nextId++}`,
            lastRun: null,
            nextRun: null,
            history: [],
        };
        this.tasks.set(task.id, task);
        return task;
    }
    async updateTask(id, updates) {
        const task = this.tasks.get(id);
        if (!task)
            throw new Error(`Scheduled task not found: ${id}`);
        Object.assign(task, updates);
        return task;
    }
    async deleteTask(id) {
        if (!this.tasks.has(id))
            throw new Error(`Scheduled task not found: ${id}`);
        this.tasks.delete(id);
    }
    async runTask(id) {
        if (!this.tasks.has(id))
            throw new Error(`Scheduled task not found: ${id}`);
        return { timestamp: new Date().toISOString(), status: 'success', duration: 100, result: 'ok' };
    }
}
class MockExtensionManager {
    listExtensions() {
        return [
            { name: 'standard', version: '1.0.0', type: 'builder', description: 'builder: standard', status: 'enabled' },
            { name: 'claude-code', version: '1.0.0', type: 'adapter', description: 'adapter: claude-code', status: 'enabled' },
        ];
    }
}
class MockPromptRegistry {
    builders = new Map([
        ['standard', { build: async (ctx) => `Rendered: ${JSON.stringify(ctx)}` }],
    ]);
    list() { return Array.from(this.builders.keys()); }
    get(name) { return this.builders.get(name); }
}
// ---------------------------------------------------------------------------
// Helper to make requests to Hono app
// ---------------------------------------------------------------------------
function createApp() {
    const learning = new MockLearningService();
    const scheduler = new MockSchedulerService();
    const extensions = new MockExtensionManager();
    const prompts = new MockPromptRegistry();
    const routes = createSupervisorRoutes(learning, scheduler, extensions, prompts);
    return { app: routes, learning, scheduler, extensions, prompts };
}
function req(app, method, path, body) {
    const init = { method };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    return app.request(path, init);
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Supervisor REST Routes', () => {
    // -------------------------------------------------------------------------
    // Prompt endpoints
    // -------------------------------------------------------------------------
    describe('GET /api/supervisor/prompts', () => {
        it('returns list of registered builders', async () => {
            const { app } = createApp();
            const res = await req(app, 'GET', '/api/supervisor/prompts');
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.builders).toEqual(['standard']);
        });
    });
    describe('PUT /api/supervisor/prompts/config', () => {
        it('accepts valid bindings object', async () => {
            const { app } = createApp();
            const res = await req(app, 'PUT', '/api/supervisor/prompts/config', {
                bindings: { 'deep-analysis': 'standard' },
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.ok).toBe(true);
        });
        it('rejects missing bindings', async () => {
            const { app } = createApp();
            const res = await req(app, 'PUT', '/api/supervisor/prompts/config', {});
            expect(res.status).toBe(400);
        });
        it('rejects non-object bindings', async () => {
            const { app } = createApp();
            const res = await req(app, 'PUT', '/api/supervisor/prompts/config', { bindings: 'string' });
            expect(res.status).toBe(400);
        });
    });
    describe('POST /api/supervisor/prompts/preview', () => {
        it('renders template with provided context', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/prompts/preview', {
                builder: 'standard',
                context: { mode: 'test' },
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.ok).toBe(true);
            expect(data.preview).toContain('test');
        });
        it('returns 404 for unknown builder', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/prompts/preview', {
                builder: 'nonexistent',
                context: {},
            });
            expect(res.status).toBe(404);
        });
        it('rejects missing builder field', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/prompts/preview', { context: {} });
            expect(res.status).toBe(400);
        });
        it('rejects missing context field', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/prompts/preview', { builder: 'standard' });
            expect(res.status).toBe(400);
        });
        it('rejects array as context', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/prompts/preview', {
                builder: 'standard',
                context: [1, 2, 3],
            });
            expect(res.status).toBe(400);
        });
    });
    // -------------------------------------------------------------------------
    // Schedule endpoints
    // -------------------------------------------------------------------------
    describe('GET /api/supervisor/schedules', () => {
        it('returns empty task list initially', async () => {
            const { app } = createApp();
            const res = await req(app, 'GET', '/api/supervisor/schedules');
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.tasks).toEqual([]);
        });
    });
    describe('POST /api/supervisor/schedules', () => {
        it('creates a new schedule', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'Test',
                cronExpression: '0 * * * *',
                taskType: 'custom',
                enabled: true,
                config: { foo: 'bar' },
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.ok).toBe(true);
            expect(data.task.name).toBe('Test');
            expect(data.task.id).toBeTruthy();
        });
        it('rejects missing name', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                cronExpression: '0 * * * *',
                taskType: 'custom',
            });
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain('name');
        });
        it('rejects missing cronExpression', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'Test',
                taskType: 'custom',
            });
            expect(res.status).toBe(400);
        });
        it('rejects missing taskType', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'Test',
                cronExpression: '0 * * * *',
            });
            expect(res.status).toBe(400);
        });
        it('defaults enabled to true', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'Default',
                cronExpression: '0 * * * *',
                taskType: 'custom',
            });
            const data = await res.json();
            expect(data.task.enabled).toBe(true);
        });
        it('defaults config to empty object', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'No Config',
                cronExpression: '0 * * * *',
                taskType: 'custom',
            });
            const data = await res.json();
            expect(data.task.config).toEqual({});
        });
    });
    describe('PUT /api/supervisor/schedules/:id', () => {
        it('updates existing schedule', async () => {
            const { app, scheduler } = createApp();
            // Create a task first
            const created = await scheduler.createTask({
                name: 'Old',
                cronExpression: '0 * * * *',
                taskType: 'custom',
                enabled: false,
                config: {},
            });
            const res = await req(app, 'PUT', `/api/supervisor/schedules/${created.id}`, {
                name: 'New Name',
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.task.name).toBe('New Name');
        });
        it('returns 404 for nonexistent task', async () => {
            const { app } = createApp();
            const res = await req(app, 'PUT', '/api/supervisor/schedules/nonexistent', {
                name: 'X',
            });
            expect(res.status).toBe(404);
        });
        it('only passes known fields to service', async () => {
            const { app, scheduler } = createApp();
            const created = await scheduler.createTask({
                name: 'Fields',
                cronExpression: '0 * * * *',
                taskType: 'custom',
                enabled: false,
                config: {},
            });
            const res = await req(app, 'PUT', `/api/supervisor/schedules/${created.id}`, {
                name: 'Updated',
                unknownField: 'should-be-dropped',
                enabled: true,
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.task.name).toBe('Updated');
            expect(data.task.enabled).toBe(true);
        });
    });
    describe('DELETE /api/supervisor/schedules/:id', () => {
        it('deletes existing schedule', async () => {
            const { app, scheduler } = createApp();
            const created = await scheduler.createTask({
                name: 'Delete Me',
                cronExpression: '0 * * * *',
                taskType: 'custom',
                enabled: false,
                config: {},
            });
            const res = await req(app, 'DELETE', `/api/supervisor/schedules/${created.id}`);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.ok).toBe(true);
        });
        it('returns 404 for nonexistent task', async () => {
            const { app } = createApp();
            const res = await req(app, 'DELETE', '/api/supervisor/schedules/fake');
            expect(res.status).toBe(404);
        });
    });
    describe('POST /api/supervisor/schedules/:id/run', () => {
        it('runs existing schedule', async () => {
            const { app, scheduler } = createApp();
            const created = await scheduler.createTask({
                name: 'Runnable',
                cronExpression: '0 * * * *',
                taskType: 'custom',
                enabled: false,
                config: {},
            });
            const res = await req(app, 'POST', `/api/supervisor/schedules/${created.id}/run`);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.ok).toBe(true);
            expect(data.result.status).toBe('success');
        });
        it('returns 404 for nonexistent task', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules/fake/run');
            expect(res.status).toBe(404);
        });
    });
    // -------------------------------------------------------------------------
    // Learning endpoints
    // -------------------------------------------------------------------------
    describe('GET /api/supervisor/learning/stats', () => {
        it('returns learning stats', async () => {
            const { app } = createApp();
            const res = await req(app, 'GET', '/api/supervisor/learning/stats');
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.totalCommands).toBe(5);
            expect(data.uniquePatterns).toBe(2);
            expect(data.topPatterns).toHaveLength(2);
        });
    });
    describe('GET /api/supervisor/learning/patterns', () => {
        it('returns command patterns', async () => {
            const { app } = createApp();
            const res = await req(app, 'GET', '/api/supervisor/learning/patterns');
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.patterns).toHaveLength(2);
            expect(data.patterns[0].command).toBe('gemini');
        });
    });
    describe('GET /api/supervisor/learning/kb', () => {
        it('returns knowledge base entries', async () => {
            const { app } = createApp();
            const res = await req(app, 'GET', '/api/supervisor/learning/kb');
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.entries).toHaveLength(1);
            expect(data.entries[0].topic).toBe('Testing');
        });
    });
    // -------------------------------------------------------------------------
    // Extension endpoints
    // -------------------------------------------------------------------------
    describe('GET /api/supervisor/extensions', () => {
        it('returns registered extensions', async () => {
            const { app } = createApp();
            const res = await req(app, 'GET', '/api/supervisor/extensions');
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.extensions).toHaveLength(2);
            expect(data.extensions[0].name).toBe('standard');
            expect(data.extensions[1].name).toBe('claude-code');
        });
    });
    // -------------------------------------------------------------------------
    // P0: Error path tests
    // -------------------------------------------------------------------------
    describe('POST /api/supervisor/prompts/preview - builder error', () => {
        it('returns 400 when builder.build() throws', async () => {
            const { app, prompts } = createApp();
            // Add a broken builder
            prompts.builders.set('broken', {
                build: async () => { throw new Error('Template render failed'); },
            });
            const res = await req(app, 'POST', '/api/supervisor/prompts/preview', {
                builder: 'broken',
                context: { mode: 'test' },
            });
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain('Builder failed:');
            expect(data.error).toContain('Template render failed');
        });
    });
    describe('POST /api/supervisor/schedules - service error', () => {
        it('returns 500 when createTask throws', async () => {
            const { app, scheduler } = createApp();
            // Override createTask to throw
            scheduler.createTask = async () => {
                throw new Error('Invalid cron expression: bad');
            };
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'Fail Task',
                cronExpression: 'bad',
                taskType: 'custom',
            });
            expect(res.status).toBe(500);
            const data = await res.json();
            expect(data.error).toContain('Invalid cron expression');
        });
    });
    describe('PUT /api/supervisor/schedules/:id - non-error 500', () => {
        it('returns 500 for generic service error', async () => {
            const { app, scheduler } = createApp();
            // Override updateTask to throw generic error
            scheduler.updateTask = async () => {
                throw new Error('Database connection failed');
            };
            const res = await req(app, 'PUT', '/api/supervisor/schedules/some-id', {
                name: 'Updated',
            });
            expect(res.status).toBe(500);
            const data = await res.json();
            expect(data.error).toContain('Database connection failed');
        });
    });
    // -------------------------------------------------------------------------
    // P1: Input validation edge cases
    // -------------------------------------------------------------------------
    describe('POST /api/supervisor/schedules - input defaults', () => {
        it('treats array config as empty object', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'Array Config',
                cronExpression: '0 * * * *',
                taskType: 'custom',
                config: [1, 2, 3], // array should be treated as {}
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.task.config).toEqual({});
        });
        it('treats non-boolean enabled as true', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/schedules', {
                name: 'String Enabled',
                cronExpression: '0 * * * *',
                taskType: 'custom',
                enabled: 'yes', // not boolean, defaults to true
            });
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.task.enabled).toBe(true);
        });
    });
    describe('POST /api/supervisor/prompts/preview - validation', () => {
        it('rejects non-string builder', async () => {
            const { app } = createApp();
            const res = await req(app, 'POST', '/api/supervisor/prompts/preview', {
                builder: 123,
                context: {},
            });
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain('builder');
        });
    });
});
//# sourceMappingURL=supervisor.test.js.map