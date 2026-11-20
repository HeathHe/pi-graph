import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWsHandler } from './agent-handler.js';
import { DashboardEventBus } from '../../state/event-bus.js';
class MockWebSocket {
    readyState = 1;
    sent = [];
    send(data) {
        this.sent.push(data);
    }
}
describe('AgentWsHandler delegate messaging', () => {
    let agentManager;
    let handler;
    let ws;
    let broadcast;
    let delegateMessage;
    beforeEach(() => {
        agentManager = {
            spawn: vi.fn(),
            stop: vi.fn(),
            sendMessage: vi.fn(),
            respondApproval: vi.fn(),
            registerCliProcess: vi.fn(),
            addCliEntry: vi.fn(),
            updateCliProcessStatus: vi.fn(),
        };
        delegateMessage = vi.fn();
        handler = new AgentWsHandler(agentManager, new DashboardEventBus(), 'D:/maestro2/.workflow', delegateMessage);
        ws = new MockWebSocket();
        broadcast = vi.fn();
    });
    it('declares delegate:message as a supported action', () => {
        expect(handler.actions).toContain('delegate:message');
    });
    it('accepts inject delivery for delegate messages', async () => {
        await handler.handle('delegate:message', {
            action: 'delegate:message',
            processId: 'cli-history-job-2',
            content: 'Inject this message',
            delivery: 'inject',
        }, ws, broadcast);
        expect(delegateMessage).toHaveBeenCalledWith({
            execId: 'cli-history-job-2',
            message: 'Inject this message',
            delivery: 'inject',
            requestedBy: 'dashboard:ws:delegate_message',
        });
        expect(agentManager.sendMessage).not.toHaveBeenCalled();
        expect(ws.sent).toHaveLength(0);
    });
    it('routes async delegate follow-ups through the shared delegate control', async () => {
        await handler.handle('delegate:message', {
            action: 'delegate:message',
            processId: 'cli-history-job-1',
            content: 'Continue after completion',
            delivery: 'after_complete',
        }, ws, broadcast);
        expect(delegateMessage).toHaveBeenCalledWith({
            execId: 'cli-history-job-1',
            message: 'Continue after completion',
            delivery: 'after_complete',
            requestedBy: 'dashboard:ws:delegate_message',
        });
        expect(agentManager.sendMessage).not.toHaveBeenCalled();
        expect(ws.sent).toHaveLength(0);
    });
});
//# sourceMappingURL=agent-handler.test.js.map