import type { RepositoryMutationContext } from '../repository/context.js';
import type { KnowhowEvolutionLink, KnowhowLifecycleResult } from './knowhow-lifecycle.js';
export declare const LIFECYCLE_WORKER_ACTIVE_LIMIT = 4;
export declare const LIFECYCLE_WORKER_QUEUE_LIMIT = 32;
export type KnowhowLifecycleRequest = {
    operation: 'supersede';
    projectRoot: string;
    oldId: string;
    newId: string;
    repositoryContext?: RepositoryMutationContext;
} | {
    operation: 'history';
    projectRoot: string;
    id: string;
} | {
    operation: 'recover';
    projectRoot: string;
    repositoryContext?: RepositoryMutationContext;
};
export type KnowhowLifecycleWorkerRequest = KnowhowLifecycleRequest & {
    ownerGeneration: string;
};
export type KnowhowLifecycleWorkerResult = {
    operation: 'supersede';
    result: KnowhowLifecycleResult;
} | {
    operation: 'history';
    entries: KnowhowEvolutionLink[];
} | {
    operation: 'recover';
    result: KnowhowLifecycleResult;
};
export type KnowhowLifecycleWorkerMessage = {
    type: 'knowhow-lifecycle-result';
    ok: true;
    result: KnowhowLifecycleWorkerResult;
} | {
    type: 'knowhow-lifecycle-result';
    ok: false;
    error: string;
};
export interface KnowhowLifecycleWorkerBridgeOptions {
    workerUrl?: URL;
    timeoutMs?: number;
}
export declare class KnowhowLifecycleBridgeError extends Error {
    readonly code: 'KNOWHOW_LIFECYCLE_BUSY' | 'KNOWHOW_LIFECYCLE_CLEANUP_FAILED';
    constructor(code: 'KNOWHOW_LIFECYCLE_BUSY' | 'KNOWHOW_LIFECYCLE_CLEANUP_FAILED', message: string, options?: ErrorOptions);
}
export declare class LifecycleWorkerScheduler {
    private active;
    private readonly queue;
    private readonly activeMutationKeys;
    schedule<T>(request: KnowhowLifecycleRequest, execute: (request: KnowhowLifecycleWorkerRequest, canonicalRoot: string) => Promise<T>): Promise<T>;
    private drain;
    private finish;
}
export declare function runKnowhowLifecycleAsync(request: KnowhowLifecycleRequest, options?: KnowhowLifecycleWorkerBridgeOptions): Promise<KnowhowLifecycleWorkerResult>;
