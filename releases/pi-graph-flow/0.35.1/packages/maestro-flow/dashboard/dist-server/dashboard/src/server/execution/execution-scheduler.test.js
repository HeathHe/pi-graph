import { join } from 'node:path';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { DashboardEventBus } from '../state/event-bus.js';
import { AgentManager } from '../agents/agent-manager.js';
import { ExecutionScheduler } from './execution-scheduler.js';
import { BaseAgentAdapter } from '../agents/base-adapter.js';
import { EntryNormalizer } from '../agents/entry-normalizer.js';
// Mock Adapter
class MockAgentAdapter extends BaseAgentAdapter {
    agentType;
    constructor(type) {
        super();
        this.agentType = type;
    }
    async doSpawn(processId, config) {
        return {
            id: processId,
            type: this.agentType,
            status: 'running',
            config,
            startedAt: new Date().toISOString(),
        };
    }
    async doStop(processId) { }
    async doSendMessage(processId, content) { }
    async doRespondApproval(decision) { }
    finish(processId, success = true) {
        console.log(`[MockAdapter] Finishing process ${processId} with success=${success}`);
        const reason = success ? 'Success' : 'Error';
        // In a real adapter, we'd emit status_change entry AND the process would exit.
        // The EntryNormalizer.statusChange returns a StatusChangeEntry.
        const entry = EntryNormalizer.statusChange(processId, success ? 'stopped' : 'error', reason);
        this.emitEntry(processId, entry);
        const proc = this.getProcess(processId);
        if (proc) {
            proc.status = success ? 'stopped' : 'error';
        }
    }
}
async function runTest() {
    const tmpDir = join(process.cwd(), 'tmp-test-execution');
    await mkdir(tmpDir, { recursive: true });
    const jsonlPath = join(tmpDir, 'issues.jsonl');
    const eventBus = new DashboardEventBus();
    const agentManager = new AgentManager(eventBus);
    const adapter = new MockAgentAdapter('claude-code');
    agentManager.registerAdapter(adapter);
    const scheduler = new ExecutionScheduler(agentManager, eventBus, jsonlPath, {
        maxConcurrentAgents: 1,
        pollIntervalMs: 100, // Fast tick for testing
    });
    // Create test issues
    const now = new Date().toISOString();
    const issue1 = {
        id: 'ISS-1',
        title: 'Test Issue 1',
        description: 'Test Description 1',
        type: 'task',
        priority: 'medium',
        status: 'open',
        created_at: now,
        updated_at: now,
    };
    const issue2 = {
        id: 'ISS-2',
        title: 'Test Issue 2',
        description: 'Test Description 2',
        type: 'task',
        priority: 'medium',
        status: 'open',
        created_at: now,
        updated_at: now,
    };
    await writeFile(jsonlPath, JSON.stringify(issue1) + '\n' + JSON.stringify(issue2) + '\n');
    console.log('--- Testing single issue execution ---');
    await scheduler.executeIssue('ISS-1');
    let status = scheduler.getStatus();
    console.log('Running:', status.running.map(s => s.issueId));
    if (status.running.length !== 1 || status.running[0].issueId !== 'ISS-1') {
        throw new Error('Issue 1 should be running');
    }
    const processId1 = status.running[0].processId;
    console.log('Finishing Issue 1...');
    adapter.finish(processId1, true);
    // Wait for event processing
    await new Promise(r => setTimeout(r, 500));
    status = scheduler.getStatus();
    console.log('Running after finish:', status.running.map(s => s.issueId));
    console.log('Stats:', status.stats);
    if (status.stats.totalCompleted !== 1) {
        console.log('\n!!! BUG CONFIRMED: Execution orchestrator did not detect agent completion !!!\n');
    }
    else {
        console.log('SUCCESS: Execution orchestrator detected agent completion.');
    }
    console.log('--- Testing batch execution & auto-dispatch ---');
    // Refresh issues file
    await writeFile(jsonlPath, JSON.stringify(issue1) + '\n' + JSON.stringify(issue2) + '\n');
    await scheduler.executeBatch(['ISS-1', 'ISS-2']);
    status = scheduler.getStatus();
    console.log('Running (batch):', status.running.map(s => s.issueId));
    console.log('Queued (batch):', status.queued);
    if (status.running.length > 0) {
        const processId2 = status.running[0].processId;
        console.log(`Finishing running issue (${status.running[0].issueId})...`);
        adapter.finish(processId2, true);
    }
    // Start supervisor to trigger auto-dispatch
    console.log('Starting supervisor...');
    scheduler.startSupervisor();
    await new Promise(r => setTimeout(r, 1000));
    scheduler.stopSupervisor();
    status = scheduler.getStatus();
    console.log('Running after finish + supervisor ticks:', status.running.map(s => s.issueId));
    console.log('Queued:', status.queued);
    if (status.running.some(s => s.issueId === 'ISS-2')) {
        console.log('SUCCESS: Next issue dispatched from queue.');
    }
    else {
        console.log('FAILURE: Next issue NOT dispatched from queue.');
    }
    // Cleanup
    await rm(tmpDir, { recursive: true });
}
runTest().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=execution-scheduler.test.js.map