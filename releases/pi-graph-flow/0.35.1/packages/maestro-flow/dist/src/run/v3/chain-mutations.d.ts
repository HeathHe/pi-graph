import type { TransitionReceiptV20 } from '../protocol-schemas.js';
import { SessionStore } from '../store.js';
export type ChainMutation = {
    kind: 'insert';
    stepId: string;
    command: string;
    args?: readonly string[];
    afterStepId?: string | null;
    goalRef?: string | null;
    stage?: string | null;
    decisionRef?: string | null;
} | {
    kind: 'skip';
    stepId: string;
} | {
    kind: 'replace';
    stepId: string;
    command: string;
    args?: readonly string[];
} | {
    kind: 'update';
    stepId: string;
    command?: string;
    args?: readonly string[];
    goalRef?: string;
    stage?: string;
    decisionRef?: string;
};
export interface MutateChainV3Input {
    sessionId: string;
    actorId: string;
    requestId: string;
    expectedOrchestrationRevision: number;
    reason: string;
    evidenceRefs?: readonly string[];
    recordedAt?: string;
    mutation: ChainMutation;
}
export interface ChainMutationResult {
    status: 'applied' | 'replayed';
    transition: TransitionReceiptV20;
}
export declare function mutateChainV3(store: SessionStore, input: MutateChainV3Input): ChainMutationResult;
//# sourceMappingURL=chain-mutations.d.ts.map