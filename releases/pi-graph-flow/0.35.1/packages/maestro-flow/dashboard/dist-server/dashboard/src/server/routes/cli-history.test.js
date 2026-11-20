import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { CLI_HISTORY_DIR_NAME } from '../../shared/constants.js';
const brokerState = vi.hoisted(() => ({
    jobs: new Map(),
    messages: new Map(),
}));
const fsState = vi.hoisted(() => ({
    files: new Map(),
    mtimes: new Map(),
}));
function normalizePath(value) {
    return value.replace(/\\/g, '/');
}
vi.mock('node:os', () => ({
    homedir: () => '/mock-home',
}));
vi.mock('node:fs', () => ({
    readdirSync(dir) {
        const normalizedDir = normalizePath(dir);
        return Array.from(fsState.files.keys())
            .filter((filePath) => normalizePath(filePath).startsWith(`${normalizedDir}/`))
            .map((filePath) => filePath.split(/[/\\]/).at(-1) ?? filePath);
    },
    statSync(filePath) {
        const mtimeMs = fsState.mtimes.get(normalizePath(filePath));
        if (mtimeMs === undefined) {
            throw new Error('ENOENT');
        }
        return { mtimeMs };
    },
    readFileSync(filePath) {
        const content = fsState.files.get(normalizePath(filePath));
        if (content === undefined) {
            throw new Error('ENOENT');
        }
        return content;
    },
}));
vi.mock('../../../../src/async/index.js', () => ({
    DelegateBrokerClient: class MockDelegateBrokerClient {
        getJob(jobId) {
            return brokerState.jobs.get(jobId) ?? null;
        }
        listMessages(jobId) {
            return brokerState.messages.get(jobId) ?? [];
        }
    },
}));
describe('CLI history routes', () => {
    let createCliHistoryRoutes;
    let previousMaestroHome;
    let historyDir;
    beforeEach(async () => {
        previousMaestroHome = process.env.MAESTRO_HOME;
        process.env.MAESTRO_HOME = '/mock-home/.maestro';
        historyDir = join(process.env.MAESTRO_HOME, CLI_HISTORY_DIR_NAME);
        brokerState.jobs.clear();
        brokerState.messages.clear();
        fsState.files.clear();
        fsState.mtimes.clear();
        ({ createCliHistoryRoutes } = await import('./cli-history.js'));
    });
    afterEach(() => {
        brokerState.jobs.clear();
        brokerState.messages.clear();
        fsState.files.clear();
        fsState.mtimes.clear();
        if (previousMaestroHome === undefined) {
            delete process.env.MAESTRO_HOME;
        }
        else {
            process.env.MAESTRO_HOME = previousMaestroHome;
        }
    });
    function seedMeta(execId, meta, mtimeMs) {
        const filePath = normalizePath(join(historyDir, `${execId}.meta.json`));
        fsState.files.set(filePath, JSON.stringify(meta));
        fsState.mtimes.set(filePath, mtimeMs);
    }
    function seedEntries(execId, lines) {
        fsState.files.set(normalizePath(join(historyDir, `${execId}.jsonl`)), lines.join('\n'));
    }
    it('enriches history items with async delegate broker state', async () => {
        seedMeta('exec-async', {
            execId: 'exec-async',
            tool: 'codex',
            mode: 'analysis',
            prompt: 'Track async progress',
            workDir: 'D:/maestro2',
            startedAt: '2026-04-08T10:00:00.000Z',
        }, Date.parse('2026-04-08T10:00:00.000Z'));
        seedMeta('exec-sync', {
            execId: 'exec-sync',
            tool: 'gemini',
            mode: 'analysis',
            prompt: 'Summarize sync task',
            workDir: 'D:/maestro2',
            startedAt: '2026-04-08T09:00:00.000Z',
            completedAt: '2026-04-08T09:01:00.000Z',
            exitCode: 0,
        }, Date.parse('2026-04-08T09:00:00.000Z'));
        seedMeta('exec-done', {
            execId: 'exec-done',
            tool: 'claude-code',
            mode: 'write',
            prompt: 'Finish task',
            workDir: 'D:/maestro2',
            startedAt: '2026-04-08T08:00:00.000Z',
            completedAt: '2026-04-08T08:03:00.000Z',
            exitCode: 0,
        }, Date.parse('2026-04-08T08:00:00.000Z'));
        brokerState.jobs.set('exec-async', {
            status: 'running',
            updatedAt: '2026-04-08T10:00:05.000Z',
            lastEventType: 'snapshot',
            metadata: { cancelRequestedAt: '2026-04-08T10:00:04.000Z' },
            latestSnapshot: { outputPreview: 'Collecting context' },
        });
        brokerState.jobs.set('exec-done', {
            status: 'completed',
            updatedAt: '2026-04-08T08:03:00.000Z',
            lastEventType: 'completed',
            metadata: {},
            latestSnapshot: { outputPreview: 'Finished successfully' },
        });
        const app = createCliHistoryRoutes();
        const res = await app.request('/api/cli-history?limit=10');
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toHaveLength(3);
        expect(body.map((entry) => entry.execId)).toEqual(['exec-async', 'exec-sync', 'exec-done']);
        expect(body.find((entry) => entry.execId === 'exec-async')).toMatchObject({
            asyncDelegate: true,
            delegateStatus: 'cancelling',
            cancelRequestedAt: '2026-04-08T10:00:04.000Z',
        });
        expect(body.find((entry) => entry.execId === 'exec-done')).toMatchObject({
            asyncDelegate: true,
            delegateStatus: 'completed',
            cancelRequestedAt: null,
        });
        expect(body.find((entry) => entry.execId === 'exec-sync')).toMatchObject({
            asyncDelegate: false,
            delegateStatus: null,
            cancelRequestedAt: null,
        });
    });
    it('returns parsed JSONL entries and skips malformed lines', async () => {
        seedEntries('exec-entries', [
            JSON.stringify({ type: 'assistant_message', content: 'First snapshot', partial: false }),
            '{bad json',
            JSON.stringify({ type: 'status_change', status: 'running' }),
            '',
        ]);
        const app = createCliHistoryRoutes();
        const res = await app.request('/api/cli-history/exec-entries/entries');
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual([
            { type: 'assistant_message', content: 'First snapshot', partial: false },
            { type: 'status_change', status: 'running' },
        ]);
    });
    it('returns queued follow-up messages for async delegates', async () => {
        brokerState.messages.set('exec-async', [
            {
                messageId: 'msg-1',
                createdAt: '2026-04-08T10:01:00.000Z',
                delivery: 'after_complete',
                message: 'Continue after this step',
                status: 'queued',
            },
        ]);
        const app = createCliHistoryRoutes();
        const res = await app.request('/api/cli-history/exec-async/messages');
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual([
            {
                messageId: 'msg-1',
                createdAt: '2026-04-08T10:01:00.000Z',
                delivery: 'after_complete',
                message: 'Continue after this step',
                status: 'queued',
            },
        ]);
    });
    it('rejects invalid IDs and reports missing executions', async () => {
        const app = createCliHistoryRoutes();
        const invalidRes = await app.request('/api/cli-history/bad%20id/entries');
        expect(invalidRes.status).toBe(400);
        expect(await invalidRes.json()).toEqual({ error: 'Invalid execution ID' });
        const invalidMessagesRes = await app.request('/api/cli-history/bad%20id/messages');
        expect(invalidMessagesRes.status).toBe(400);
        expect(await invalidMessagesRes.json()).toEqual({ error: 'Invalid execution ID' });
        const missingRes = await app.request('/api/cli-history/exec-missing/entries');
        expect(missingRes.status).toBe(404);
        expect(await missingRes.json()).toEqual({ error: 'Execution not found' });
    });
});
//# sourceMappingURL=cli-history.test.js.map