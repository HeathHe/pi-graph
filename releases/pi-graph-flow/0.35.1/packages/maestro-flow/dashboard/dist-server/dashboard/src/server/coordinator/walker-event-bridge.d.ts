import type { CoordinateEvent, WalkerEventEmitter } from '../../../../src/coordinator/graph-types.js';
import type { DashboardEventBus } from '../state/event-bus.js';
export declare class WalkerEventBridge implements WalkerEventEmitter {
    private readonly mode;
    private readonly eventBus;
    private readonly sessionId?;
    constructor(mode: 'coordinate' | 'execution', eventBus: DashboardEventBus, sessionId?: string | undefined);
    emit(event: CoordinateEvent): void;
}
