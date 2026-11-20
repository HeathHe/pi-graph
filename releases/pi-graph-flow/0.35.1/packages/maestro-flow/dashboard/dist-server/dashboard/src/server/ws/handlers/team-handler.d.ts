import { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { DashboardEventBus } from '../../state/event-bus.js';
export declare class TeamWsHandler implements WsHandler {
    private readonly eventBus;
    readonly actions: readonly ["team:message", "team:broadcast", "team:set_mode", "team:approve"];
    constructor(eventBus: DashboardEventBus);
    handle(action: string, data: unknown, _ws: WebSocket, _broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
}
