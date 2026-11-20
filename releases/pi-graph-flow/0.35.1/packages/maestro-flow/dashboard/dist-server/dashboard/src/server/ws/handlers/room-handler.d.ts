import { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { DashboardEventBus } from '../../state/event-bus.js';
import type { RoomSessionManager } from '../../rooms/room-session-manager.js';
import type { SessionScopedEventFilter } from '../session-scoped-event-filter.js';
export declare class RoomWsHandler implements WsHandler {
    private readonly sessionManager;
    private readonly eventBus;
    private readonly filter;
    private readonly workflowRoot?;
    readonly actions: readonly ["room:create", "room:close", "room:subscribe", "room:unsubscribe", "room:add_agent", "room:remove_agent", "room:set_agent_status", "room:send_message", "room:broadcast", "room:create_task", "room:update_task", "room:snapshot"];
    constructor(sessionManager: RoomSessionManager, eventBus: DashboardEventBus, filter: SessionScopedEventFilter, workflowRoot?: string | undefined);
    handle(action: string, data: unknown, ws: WebSocket, _broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
    /** Remove the meeting-room entry from .mcp.json after room destruction. */
    private cleanupMcpJson;
}
