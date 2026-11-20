import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SupervisorWsHandler } from './supervisor-handler.js';
// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------
class MockWebSocket {
    readyState = 1; // WebSocket.OPEN
    sent = [];
    send(data) { this.sent.push(data); }
}
// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------
class MockLearningService {
    getStats() {
        return {
            totalCommands: 10,
            uniquePatterns: 3,
            topPatterns: [],
            suggestions: [],
            knowledgeBaseSize: 5,
        };
    }
}
class MockSchedulerService {
    listTasks() {
        return [
            {
                id: 'task-1',
                name: 'Health Check',
                cronExpression: '0 * * * *',
                taskType: 'health-check',
                config: {},
                enabled: true,
                lastRun: null,
                nextRun: null,
                history: [],
            },
        ];
    }
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SupervisorWsHandler', () => {
    let handler;
    let ws;
    let broadcast;
    beforeEach(() => {
        handler = new SupervisorWsHandler(new MockLearningService(), new MockSchedulerService());
        ws = new MockWebSocket();
        broadcast = vi.fn();
    });
    describe('actions', () => {
        it('declares supervisor:learning and supervisor:schedule actions', () => {
            expect(handler.actions).toContain('supervisor:learning');
            expect(handler.actions).toContain('supervisor:schedule');
        });
    });
    describe('supervisor:learning', () => {
        it('sends learning stats to websocket', async () => {
            await handler.handle('supervisor:learning', undefined, ws, broadcast);
            expect(ws.sent).toHaveLength(1);
            const msg = JSON.parse(ws.sent[0]);
            expect(msg.type).toBe('supervisor:learning_update');
            expect(msg.data.totalCommands).toBe(10);
            expect(msg.data.uniquePatterns).toBe(3);
            expect(msg.data.knowledgeBaseSize).toBe(5);
        });
        it('does not call broadcast', async () => {
            await handler.handle('supervisor:learning', undefined, ws, broadcast);
            expect(broadcast).not.toHaveBeenCalled();
        });
    });
    describe('supervisor:schedule', () => {
        it('sends schedule data to websocket', async () => {
            await handler.handle('supervisor:schedule', undefined, ws, broadcast);
            expect(ws.sent).toHaveLength(1);
            const msg = JSON.parse(ws.sent[0]);
            expect(msg.type).toBe('supervisor:schedule_update');
            expect(msg.data.tasks).toHaveLength(1);
            expect(msg.data.tasks[0].name).toBe('Health Check');
        });
    });
    describe('closed websocket', () => {
        it('does not send when readyState is not OPEN', async () => {
            ws.readyState = 3; // CLOSED
            await handler.handle('supervisor:learning', undefined, ws, broadcast);
            expect(ws.sent).toHaveLength(0);
        });
    });
    describe('unknown action', () => {
        it('does not send anything for unhandled actions', async () => {
            await handler.handle('unknown:action', undefined, ws, broadcast);
            expect(ws.sent).toHaveLength(0);
        });
    });
    // -------------------------------------------------------------------------
    // P1: Data format completeness
    // -------------------------------------------------------------------------
    describe('data format completeness', () => {
        it('supervisor:learning response has all LearningStats fields', async () => {
            await handler.handle('supervisor:learning', undefined, ws, broadcast);
            const msg = JSON.parse(ws.sent[0]);
            const data = msg.data;
            expect(data).toHaveProperty('totalCommands');
            expect(data).toHaveProperty('uniquePatterns');
            expect(data).toHaveProperty('topPatterns');
            expect(data).toHaveProperty('suggestions');
            expect(data).toHaveProperty('knowledgeBaseSize');
        });
        it('supervisor:schedule response has tasks array with correct shape', async () => {
            await handler.handle('supervisor:schedule', undefined, ws, broadcast);
            const msg = JSON.parse(ws.sent[0]);
            expect(msg.data).toHaveProperty('tasks');
            expect(Array.isArray(msg.data.tasks)).toBe(true);
            const task = msg.data.tasks[0];
            expect(task).toHaveProperty('id');
            expect(task).toHaveProperty('name');
            expect(task).toHaveProperty('cronExpression');
            expect(task).toHaveProperty('taskType');
            expect(task).toHaveProperty('enabled');
            expect(task).toHaveProperty('history');
        });
    });
});
//# sourceMappingURL=supervisor-handler.test.js.map