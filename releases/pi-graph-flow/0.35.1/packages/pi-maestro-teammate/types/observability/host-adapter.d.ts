import { type JournalFactoryBinding, type Clock } from 'pi-graph-observability';
import type { SessionProgressInput } from 'pi-graph-observability/execution';
import type { WorkspaceOwnerSnapshot } from '../extension/workspace-peers.ts';
export declare const hostClock: Clock;
export declare function sessionProgressInput(owner: WorkspaceOwnerSnapshot, lifecycle: SessionProgressInput['lifecycle']): SessionProgressInput;
export declare function observationPartition(cwd: string, sessionId: string): {
    workspaceDigest: string;
    sessionDigest: string;
};
export interface RootFenceInput {
    generation: number;
    sessionId: string | null;
    workspaceId: string | undefined;
    sourceId: string | undefined;
    baseCwd: string;
}
/** Capture delegates to the actual extension closure; no JSON copy becomes authority. */
export declare function createRootObservationBridge(capture: () => RootFenceInput, owns: (fence: RootFenceInput) => boolean, publisher: () => {
    ownerId: string;
    ownerNonce: string;
} | undefined): {
    capture: () => JournalFactoryBinding | undefined;
    refresh(): void;
    dispose(): void;
};
