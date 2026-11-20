import { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { SelfLearningService } from '../../supervisor/self-learning-service.js';
import type { TaskSchedulerService } from '../../supervisor/task-scheduler-service.js';
export declare class SupervisorWsHandler implements WsHandler {
    private readonly learningService;
    private readonly schedulerService;
    readonly actions: readonly ["supervisor:learning", "supervisor:schedule"];
    constructor(learningService: SelfLearningService, schedulerService: TaskSchedulerService);
    handle(action: string, data: unknown, ws: WebSocket, _broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
}
