import type { WebSocket } from 'ws';
import type { WsHandler } from '../ws-handler.js';
import type { WsEventType } from '../../../shared/ws-protocol.js';
import type { RequirementExpander } from '../../requirement/requirement-expander.js';
export declare class RequirementWsHandler implements WsHandler {
    private readonly requirementExpander;
    readonly actions: readonly ["requirement:expand", "requirement:refine", "requirement:commit"];
    constructor(requirementExpander: RequirementExpander);
    handle(action: string, data: unknown, _ws: WebSocket, broadcast: (type: WsEventType, data: unknown) => void): Promise<void>;
}
