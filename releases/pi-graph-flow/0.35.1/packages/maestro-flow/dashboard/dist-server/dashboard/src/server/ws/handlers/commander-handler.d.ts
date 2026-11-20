import type { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { CommanderAgent } from '../../commander/commander-agent.js';
export declare class CommanderWsHandler implements WsHandler {
    private readonly commanderAgent;
    readonly actions: readonly ["commander:start", "commander:stop", "commander:pause", "commander:config"];
    constructor(commanderAgent: CommanderAgent);
    handle(action: string, data: unknown, _ws: WebSocket, _broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
}
