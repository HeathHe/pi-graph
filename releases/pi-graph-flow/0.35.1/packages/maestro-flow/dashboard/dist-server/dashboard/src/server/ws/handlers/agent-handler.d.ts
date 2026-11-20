import { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { AgentConfig } from '../../../shared/agent-types.js';
import type { AgentManager } from '../../agents/agent-manager.js';
import type { DashboardEventBus } from '../../state/event-bus.js';
import type { RoomSessionManager } from '../../rooms/room-session-manager.js';
interface DelegateMessageParams {
    execId: string;
    message: string;
    delivery: string;
    requestedBy: string;
}
type DelegateMessageHandler = (params: DelegateMessageParams) => Promise<void>;
export declare class AgentWsHandler implements WsHandler {
    private readonly agentManager;
    private readonly eventBus;
    private readonly workflowRoot;
    private readonly delegateMessage;
    private readonly roomSessionManager?;
    readonly actions: readonly ["spawn", "stop", "message", "delegate:message", "approve", "cli:spawned", "cli:entry", "cli:stopped"];
    constructor(agentManager: AgentManager, eventBus: DashboardEventBus, workflowRoot: string, delegateMessage?: DelegateMessageHandler, roomSessionManager?: RoomSessionManager | undefined);
    handle(action: string, data: unknown, ws: WebSocket, broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
    /**
     * Merge saved agent settings into spawn config, then spawn.
     * Public so ExecutionWsHandler can reuse it for issue analyze/plan.
     */
    mergeSettingsAndSpawn(ws: WebSocket, config: AgentConfig): Promise<void>;
}
export {};
