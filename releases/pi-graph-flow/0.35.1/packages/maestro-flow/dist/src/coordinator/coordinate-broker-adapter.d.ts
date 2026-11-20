import type { CoordinateEvent, WalkerEventEmitter } from './graph-types.js';
import type { DelegateBrokerApi, JsonObject } from '../async/delegate-broker.js';
export interface CoordinateBrokerAdapterOptions {
    /** Optional jobMetadata attached to every event. */
    jobMetadata?: JsonObject;
}
export declare class CoordinateBrokerAdapter implements WalkerEventEmitter {
    private readonly broker;
    private readonly opts;
    constructor(broker: DelegateBrokerApi, opts?: CoordinateBrokerAdapterOptions);
    emit(event: CoordinateEvent): void;
}
//# sourceMappingURL=coordinate-broker-adapter.d.ts.map