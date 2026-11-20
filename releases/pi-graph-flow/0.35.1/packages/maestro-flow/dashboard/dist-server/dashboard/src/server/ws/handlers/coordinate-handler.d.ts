import type { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { WorkflowCoordinator } from '../../coordinator/workflow-coordinator.js';
export declare class CoordinateWsHandler implements WsHandler {
    private readonly coordinateRunner;
    readonly actions: readonly ["coordinate:start", "coordinate:stop", "coordinate:resume", "coordinate:clarify"];
    constructor(coordinateRunner: WorkflowCoordinator);
    handle(action: string, data: unknown, _ws: WebSocket, _broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
}
