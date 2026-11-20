import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DashboardEventBus } from '../state/event-bus.js';
import { SelfLearningService } from './self-learning-service.js';
// ---------------------------------------------------------------------------
// Minimal mock for ExecutionJournal
// ---------------------------------------------------------------------------
class MockJournal {
    events = [];
    addEvent(event) {
        this.events.push(event);
    }
    async readAll() {
        return [...this.events];
    }
    async getEventsForIssue(issueId) {
        return this.events.filter((e) => e.issueId === issueId);
    }
    clear() {
        this.events = [];
    }
}
// ---------------------------------------------------------------------------
// Helper to create journal events
// ---------------------------------------------------------------------------
function makeEvent(type, issueId, timestamp, extra = {}) {
    // JournalEvent is a discriminated union; we cast to satisfy the type
    // while providing the fields that SelfLearningService actually reads
    const base = { type, issueId, timestamp, ...extra };
    // Add required fields based on event type
    if (type === 'issue:dispatched') {
        return { ...base, processId: extra.processId ?? 'mock-pid', executor: extra.executor ?? 'unknown' };
    }
    if (type === 'issue:completed') {
        return { ...base, processId: extra.processId ?? 'mock-pid' };
    }
    if (type === 'issue:failed') {
        return { ...base, processId: extra.processId ?? 'mock-pid', error: extra.error ?? 'mock error', retryCount: extra.retryCount ?? 0 };
    }
    return base;
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SelfLearningService', () => {
    let workflowRoot;
    let eventBus;
    let journal;
    let service;
    const emitted = [];
    beforeEach(async () => {
        workflowRoot = join(tmpdir(), `test-learning-${randomUUID()}`);
        await mkdir(workflowRoot, { recursive: true });
        eventBus = new DashboardEventBus();
        journal = new MockJournal();
        // Capture emitted events
        emitted.length = 0;
        eventBus.on('supervisor:learning_update', (data) => {
            emitted.push(data);
        });
        service = new SelfLearningService(eventBus, journal, workflowRoot);
    });
    afterEach(async () => {
        await rm(workflowRoot, { recursive: true, force: true });
    });
    // -------------------------------------------------------------------------
    // getStats - empty state
    // -------------------------------------------------------------------------
    describe('getStats()', () => {
        it('returns empty stats when no data exists', () => {
            const stats = service.getStats();
            expect(stats.totalCommands).toBe(0);
            expect(stats.uniquePatterns).toBe(0);
            expect(stats.topPatterns).toHaveLength(0);
            expect(stats.suggestions).toHaveLength(0);
            expect(stats.knowledgeBaseSize).toBe(0);
        });
    });
    // -------------------------------------------------------------------------
    // analyze - full rebuild from journal
    // -------------------------------------------------------------------------
    describe('analyze()', () => {
        it('rebuilds patterns from journal events', async () => {
            const issueId = 'ISSUE-001';
            journal.addEvent(makeEvent('issue:dispatched', issueId, '2026-01-01T00:00:00Z', { executor: 'gemini' }));
            journal.addEvent(makeEvent('issue:completed', issueId, '2026-01-01T00:05:00Z'));
            const stats = await service.analyze();
            expect(stats.uniquePatterns).toBe(1);
            expect(stats.totalCommands).toBe(1);
            expect(stats.topPatterns[0].command).toBe('gemini');
            expect(stats.topPatterns[0].frequency).toBe(1);
            expect(stats.topPatterns[0].successRate).toBe(1);
        });
        it('computes correct success rate across multiple issues', async () => {
            // 2 success + 1 failure = 66.7% success rate
            journal.addEvent(makeEvent('issue:dispatched', 'A', '2026-01-01T00:00:00Z', { executor: 'codex' }));
            journal.addEvent(makeEvent('issue:completed', 'A', '2026-01-01T00:01:00Z'));
            journal.addEvent(makeEvent('issue:dispatched', 'B', '2026-01-01T00:02:00Z', { executor: 'codex' }));
            journal.addEvent(makeEvent('issue:completed', 'B', '2026-01-01T00:03:00Z'));
            journal.addEvent(makeEvent('issue:dispatched', 'C', '2026-01-01T00:04:00Z', { executor: 'codex' }));
            journal.addEvent(makeEvent('issue:failed', 'C', '2026-01-01T00:05:00Z'));
            const stats = await service.analyze();
            const codexPattern = stats.topPatterns.find((p) => p.command === 'codex');
            expect(codexPattern).toBeDefined();
            expect(codexPattern.frequency).toBe(3);
            expect(codexPattern.successRate).toBeCloseTo(2 / 3, 2);
        });
        it('computes average duration correctly', async () => {
            // Issue A: 60s, Issue B: 120s → avg = 90s = 90000ms
            journal.addEvent(makeEvent('issue:dispatched', 'A', '2026-01-01T00:00:00Z', { executor: 'qwen' }));
            journal.addEvent(makeEvent('issue:completed', 'A', '2026-01-01T00:01:00Z'));
            journal.addEvent(makeEvent('issue:dispatched', 'B', '2026-01-01T00:02:00Z', { executor: 'qwen' }));
            journal.addEvent(makeEvent('issue:completed', 'B', '2026-01-01T00:04:00Z'));
            const stats = await service.analyze();
            const pattern = stats.topPatterns.find((p) => p.command === 'qwen');
            expect(pattern.avgDuration).toBe(90_000);
        });
        it('handles multiple executor types separately', async () => {
            journal.addEvent(makeEvent('issue:dispatched', 'A', '2026-01-01T00:00:00Z', { executor: 'gemini' }));
            journal.addEvent(makeEvent('issue:completed', 'A', '2026-01-01T00:01:00Z'));
            journal.addEvent(makeEvent('issue:dispatched', 'B', '2026-01-01T00:02:00Z', { executor: 'codex' }));
            journal.addEvent(makeEvent('issue:completed', 'B', '2026-01-01T00:03:00Z'));
            const stats = await service.analyze();
            expect(stats.uniquePatterns).toBe(2);
        });
        it('emits supervisor:learning_update on analyze', async () => {
            journal.addEvent(makeEvent('issue:dispatched', 'A', '2026-01-01T00:00:00Z', { executor: 'test' }));
            journal.addEvent(makeEvent('issue:completed', 'A', '2026-01-01T00:01:00Z'));
            await service.analyze();
            expect(emitted.length).toBeGreaterThan(0);
        });
        it('persists patterns to JSONL file', async () => {
            journal.addEvent(makeEvent('issue:dispatched', 'A', '2026-01-01T00:00:00Z', { executor: 'gemini' }));
            journal.addEvent(makeEvent('issue:completed', 'A', '2026-01-01T00:01:00Z'));
            await service.analyze();
            const patternsPath = join(workflowRoot, 'learning', 'patterns.jsonl');
            const content = await readFile(patternsPath, 'utf-8');
            const lines = content.trim().split('\n');
            expect(lines.length).toBe(1);
            const parsed = JSON.parse(lines[0]);
            expect(parsed.command).toBe('gemini');
            expect(parsed.frequency).toBe(1);
        });
    });
    // -------------------------------------------------------------------------
    // addKnowledgeEntry
    // -------------------------------------------------------------------------
    describe('addKnowledgeEntry()', () => {
        it('adds entry and returns it with id and defaults', async () => {
            const entry = await service.addKnowledgeEntry({
                topic: 'Testing',
                content: 'Always use vitest for unit tests',
                source: 'manual',
                tags: ['testing', 'best-practice'],
            });
            expect(entry.id).toBeTruthy();
            expect(entry.usageCount).toBe(0);
            expect(entry.lastAccessed).toBeTruthy();
            expect(entry.topic).toBe('Testing');
        });
        it('persists entry to kb JSONL file', async () => {
            await service.addKnowledgeEntry({
                topic: 'Persistence',
                content: 'KB entries are persisted',
                source: 'auto',
                tags: [],
            });
            const kbPath = join(workflowRoot, 'learning', 'kb.jsonl');
            const content = await readFile(kbPath, 'utf-8');
            expect(content).toContain('Persistence');
        });
        it('increments knowledge base size in stats', async () => {
            await service.addKnowledgeEntry({ topic: 'A', content: 'a', source: 'manual', tags: [] });
            await service.addKnowledgeEntry({ topic: 'B', content: 'b', source: 'manual', tags: [] });
            const stats = service.getStats();
            expect(stats.knowledgeBaseSize).toBe(2);
        });
        it('emits learning_update after adding entry', async () => {
            emitted.length = 0;
            await service.addKnowledgeEntry({ topic: 'Test', content: 'test', source: 'manual', tags: [] });
            expect(emitted.length).toBeGreaterThan(0);
        });
    });
    // -------------------------------------------------------------------------
    // getKnowledgeBase
    // -------------------------------------------------------------------------
    describe('getKnowledgeBase()', () => {
        it('returns all added entries', async () => {
            await service.addKnowledgeEntry({ topic: 'A', content: 'a', source: 'manual', tags: ['x'] });
            await service.addKnowledgeEntry({ topic: 'B', content: 'b', source: 'auto', tags: ['y'] });
            const entries = service.getKnowledgeBase();
            expect(entries).toHaveLength(2);
            expect(entries.map((e) => e.topic)).toContain('A');
            expect(entries.map((e) => e.topic)).toContain('B');
        });
    });
    // -------------------------------------------------------------------------
    // Suggestion generation
    // -------------------------------------------------------------------------
    describe('suggestion generation', () => {
        it('generates optimize suggestion for low success rate', async () => {
            // 4 executions, all failed → 0% success rate
            for (let i = 0; i < 4; i++) {
                const id = `fail-${i}`;
                journal.addEvent(makeEvent('issue:dispatched', id, `2026-01-0${i + 1}T00:00:00Z`, { executor: 'bad-agent' }));
                journal.addEvent(makeEvent('issue:failed', id, `2026-01-0${i + 1}T00:01:00Z`));
            }
            const stats = await service.analyze();
            const optimizeSuggestion = stats.suggestions.find((s) => s.type === 'optimize');
            expect(optimizeSuggestion).toBeDefined();
            expect(optimizeSuggestion.title).toContain('bad-agent');
        });
        it('generates automate suggestion for high-frequency high-success patterns', async () => {
            // 12 executions, all success → qualifies for automate
            for (let i = 0; i < 12; i++) {
                const id = `ok-${i}`;
                journal.addEvent(makeEvent('issue:dispatched', id, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, { executor: 'reliable-agent' }));
                journal.addEvent(makeEvent('issue:completed', id, `2026-01-${String(i + 1).padStart(2, '0')}T00:01:00Z`));
            }
            const stats = await service.analyze();
            const automateSuggestion = stats.suggestions.find((s) => s.type === 'automate');
            expect(automateSuggestion).toBeDefined();
            expect(automateSuggestion.title).toContain('reliable-agent');
        });
        it('generates alert for slow execution', async () => {
            // 3 executions, each 10 minutes → avgDuration = 600000ms > 300000ms threshold
            for (let i = 0; i < 3; i++) {
                const id = `slow-${i}`;
                journal.addEvent(makeEvent('issue:dispatched', id, `2026-01-0${i + 1}T00:00:00Z`, { executor: 'slow-agent' }));
                journal.addEvent(makeEvent('issue:completed', id, `2026-01-0${i + 1}T00:10:00Z`));
            }
            const stats = await service.analyze();
            const alertSuggestion = stats.suggestions.find((s) => s.type === 'alert');
            expect(alertSuggestion).toBeDefined();
            expect(alertSuggestion.title).toContain('slow-agent');
        });
        it('returns no suggestions for single execution', async () => {
            journal.addEvent(makeEvent('issue:dispatched', 'X', '2026-01-01T00:00:00Z', { executor: 'once' }));
            journal.addEvent(makeEvent('issue:failed', 'X', '2026-01-01T00:01:00Z'));
            const stats = await service.analyze();
            // frequency=1 < threshold=3, no suggestions
            expect(stats.suggestions).toHaveLength(0);
        });
    });
    // -------------------------------------------------------------------------
    // Incremental event handling
    // -------------------------------------------------------------------------
    describe('incremental event handling', () => {
        it('updates patterns on execution:completed event', async () => {
            const issueId = 'INC-001';
            journal.addEvent(makeEvent('issue:dispatched', issueId, '2026-01-01T00:00:00Z', { executor: 'claude' }));
            journal.addEvent(makeEvent('issue:completed', issueId, '2026-01-01T00:05:00Z'));
            // EventBus.emit wraps payload in SSEEvent { type, data, timestamp }
            // The listener receives the SSEEvent, so event.data has the actual payload
            eventBus.emit('execution:completed', { issueId, processId: 'p1' });
            // Wait for async handler (fire-and-forget via `void`)
            await new Promise((r) => setTimeout(r, 500));
            const patterns = service.getPatterns();
            expect(patterns.length).toBeGreaterThanOrEqual(1);
            const claudePattern = patterns.find((p) => p.command === 'claude');
            expect(claudePattern).toBeDefined();
            expect(claudePattern.successRate).toBe(1);
        });
        it('updates patterns on execution:failed event', async () => {
            const issueId = 'INC-002';
            journal.addEvent(makeEvent('issue:dispatched', issueId, '2026-01-01T00:00:00Z', { executor: 'gemini' }));
            journal.addEvent(makeEvent('issue:failed', issueId, '2026-01-01T00:01:00Z'));
            eventBus.emit('execution:failed', { issueId, processId: 'p2', error: 'timeout' });
            await new Promise((r) => setTimeout(r, 500));
            const patterns = service.getPatterns();
            const geminiPattern = patterns.find((p) => p.command === 'gemini');
            expect(geminiPattern).toBeDefined();
            expect(geminiPattern.successRate).toBe(0);
        });
    });
    // -------------------------------------------------------------------------
    // Edge cases
    // -------------------------------------------------------------------------
    describe('edge cases', () => {
        it('handles events with no dispatched event gracefully', async () => {
            journal.addEvent(makeEvent('issue:completed', 'orphan', '2026-01-01T00:01:00Z'));
            const stats = await service.analyze();
            expect(stats.uniquePatterns).toBe(0);
        });
        it('handles missing executor field', async () => {
            journal.addEvent(makeEvent('issue:dispatched', 'no-exec', '2026-01-01T00:00:00Z'));
            journal.addEvent(makeEvent('issue:completed', 'no-exec', '2026-01-01T00:01:00Z'));
            const stats = await service.analyze();
            const unknownPattern = stats.topPatterns.find((p) => p.command === 'unknown');
            expect(unknownPattern).toBeDefined();
        });
        it('limits context list to 50 entries', async () => {
            // Create 55 issues with same executor
            for (let i = 0; i < 55; i++) {
                const id = `ctx-${i}`;
                journal.addEvent(makeEvent('issue:dispatched', id, `2026-01-01T${String(i).padStart(2, '0')}:00:00Z`, { executor: 'busy' }));
                journal.addEvent(makeEvent('issue:completed', id, `2026-01-01T${String(i).padStart(2, '0')}:01:00Z`));
            }
            const stats = await service.analyze();
            const busyPattern = stats.topPatterns.find((p) => p.command === 'busy');
            expect(busyPattern.contexts.length).toBeLessThanOrEqual(50);
        });
        it('sorts suggestions by confidence descending', async () => {
            // Create patterns that trigger multiple suggestion types
            for (let i = 0; i < 15; i++) {
                const id = `multi-${i}`;
                journal.addEvent(makeEvent('issue:dispatched', id, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, { executor: 'multi' }));
                journal.addEvent(makeEvent('issue:completed', id, `2026-01-${String(i + 1).padStart(2, '0')}T00:01:00Z`));
            }
            const stats = await service.analyze();
            for (let i = 1; i < stats.suggestions.length; i++) {
                expect(stats.suggestions[i - 1].confidence).toBeGreaterThanOrEqual(stats.suggestions[i].confidence);
            }
        });
    });
    // -------------------------------------------------------------------------
    // P0: Persistence recovery on construction
    // -------------------------------------------------------------------------
    describe('persistence recovery', () => {
        it('loads persisted patterns and kb on construction', async () => {
            // Pre-write patterns.jsonl and kb.jsonl
            const learningDir = join(workflowRoot, 'learning');
            await mkdir(learningDir, { recursive: true });
            const { writeFile } = await import('node:fs/promises');
            const pattern1 = JSON.stringify({ command: 'gemini', frequency: 5, successRate: 0.8, avgDuration: 3000, lastUsed: '2026-01-01T00:00:00Z', contexts: ['a'] });
            const pattern2 = JSON.stringify({ command: 'codex', frequency: 3, successRate: 1.0, avgDuration: 2000, lastUsed: '2026-01-02T00:00:00Z', contexts: ['b'] });
            await writeFile(join(learningDir, 'patterns.jsonl'), pattern1 + '\n' + pattern2 + '\n', 'utf-8');
            const kbEntry = JSON.stringify({ id: 'kb-1', topic: 'Test', content: 'test content', source: 'manual', usageCount: 0, lastAccessed: '2026-01-01T00:00:00Z', tags: ['t'] });
            await writeFile(join(learningDir, 'kb.jsonl'), kbEntry + '\n', 'utf-8');
            // Construct a new service instance (loadPersistedData called in constructor)
            const service2 = new SelfLearningService(eventBus, journal, workflowRoot);
            // Wait for async load
            await new Promise((r) => setTimeout(r, 200));
            expect(service2.getPatterns()).toHaveLength(2);
            expect(service2.getPatterns()[0].command).toBe('gemini'); // sorted by frequency desc
            expect(service2.getKnowledgeBase()).toHaveLength(1);
            expect(service2.getKnowledgeBase()[0].topic).toBe('Test');
        });
        it('skips malformed lines in persisted JSONL', async () => {
            const learningDir = join(workflowRoot, 'learning');
            await mkdir(learningDir, { recursive: true });
            const { writeFile } = await import('node:fs/promises');
            const valid = JSON.stringify({ command: 'qwen', frequency: 2, successRate: 1, avgDuration: 1000, lastUsed: '2026-01-01T00:00:00Z', contexts: [] });
            await writeFile(join(learningDir, 'patterns.jsonl'), valid + '\n' + 'BROKEN{{{' + '\n', 'utf-8');
            const service2 = new SelfLearningService(eventBus, journal, workflowRoot);
            await new Promise((r) => setTimeout(r, 200));
            // Only valid line loaded, malformed skipped
            expect(service2.getPatterns()).toHaveLength(1);
            expect(service2.getPatterns()[0].command).toBe('qwen');
        });
    });
    // -------------------------------------------------------------------------
    // P0: Incremental successRate accuracy
    // -------------------------------------------------------------------------
    describe('incremental successRate accuracy', () => {
        it('computes successRate correctly across completed and failed events', async () => {
            // Setup: 2 issues in journal — A completed, B failed, both with executor 'test-exec'
            journal.addEvent(makeEvent('issue:dispatched', 'ACC-A', '2026-01-01T00:00:00Z', { executor: 'test-exec' }));
            journal.addEvent(makeEvent('issue:completed', 'ACC-A', '2026-01-01T00:01:00Z'));
            journal.addEvent(makeEvent('issue:dispatched', 'ACC-B', '2026-01-01T00:02:00Z', { executor: 'test-exec' }));
            journal.addEvent(makeEvent('issue:failed', 'ACC-B', '2026-01-01T00:03:00Z'));
            // Fire completed for A
            eventBus.emit('execution:completed', { issueId: 'ACC-A', processId: 'p1' });
            await new Promise((r) => setTimeout(r, 300));
            let patterns = service.getPatterns();
            let p = patterns.find((x) => x.command === 'test-exec');
            expect(p).toBeDefined();
            expect(p.frequency).toBe(1);
            expect(p.successRate).toBe(1);
            // Fire failed for B
            eventBus.emit('execution:failed', { issueId: 'ACC-B', processId: 'p2', error: 'timeout' });
            await new Promise((r) => setTimeout(r, 300));
            patterns = service.getPatterns();
            p = patterns.find((x) => x.command === 'test-exec');
            expect(p.frequency).toBe(2);
            expect(p.successRate).toBeCloseTo(0.5, 2);
        });
        it('deduplicates contexts in incremental updates', async () => {
            journal.addEvent(makeEvent('issue:dispatched', 'DUP-1', '2026-01-01T00:00:00Z', { executor: 'dup-exec' }));
            journal.addEvent(makeEvent('issue:completed', 'DUP-1', '2026-01-01T00:01:00Z'));
            // Fire completed twice for same issueId
            eventBus.emit('execution:completed', { issueId: 'DUP-1', processId: 'p1' });
            await new Promise((r) => setTimeout(r, 300));
            eventBus.emit('execution:completed', { issueId: 'DUP-1', processId: 'p1' });
            await new Promise((r) => setTimeout(r, 300));
            const patterns = service.getPatterns();
            const p = patterns.find((x) => x.command === 'dup-exec');
            expect(p).toBeDefined();
            // contexts should only contain 'DUP-1' once
            const dupCount = p.contexts.filter((c) => c === 'DUP-1').length;
            expect(dupCount).toBe(1);
        });
    });
    // -------------------------------------------------------------------------
    // P1: handleExecutionEvent edge cases
    // -------------------------------------------------------------------------
    describe('handleExecutionEvent edge cases', () => {
        it('ignores events without dispatched event in journal', async () => {
            // Journal has only a completed event, no dispatched
            journal.addEvent(makeEvent('issue:completed', 'NO-DISP', '2026-01-01T00:01:00Z'));
            eventBus.emit('execution:completed', { issueId: 'NO-DISP', processId: 'p1' });
            await new Promise((r) => setTimeout(r, 300));
            // Should not create a pattern
            const patterns = service.getPatterns();
            const p = patterns.find((x) => x.contexts.includes('NO-DISP'));
            expect(p).toBeUndefined();
        });
        it('computes avgDuration incrementally', async () => {
            // Issue A: 60s duration
            journal.addEvent(makeEvent('issue:dispatched', 'DUR-A', '2026-01-01T00:00:00Z', { executor: 'dur-exec' }));
            journal.addEvent(makeEvent('issue:completed', 'DUR-A', '2026-01-01T00:01:00Z'));
            // Issue B: 120s duration
            journal.addEvent(makeEvent('issue:dispatched', 'DUR-B', '2026-01-01T00:02:00Z', { executor: 'dur-exec' }));
            journal.addEvent(makeEvent('issue:completed', 'DUR-B', '2026-01-01T00:04:00Z'));
            eventBus.emit('execution:completed', { issueId: 'DUR-A', processId: 'p1' });
            await new Promise((r) => setTimeout(r, 300));
            let p = service.getPatterns().find((x) => x.command === 'dur-exec');
            expect(p.avgDuration).toBe(60_000);
            eventBus.emit('execution:completed', { issueId: 'DUR-B', processId: 'p2' });
            await new Promise((r) => setTimeout(r, 300));
            p = service.getPatterns().find((x) => x.command === 'dur-exec');
            // (60000 * 1 + 120000) / 2 = 90000
            expect(p.avgDuration).toBe(90_000);
        });
    });
});
//# sourceMappingURL=self-learning-service.test.js.map