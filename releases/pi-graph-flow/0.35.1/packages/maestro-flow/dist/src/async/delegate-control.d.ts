import { CliHistoryStore, type ExecutionMeta } from '../agents/cli-history-store.js';
import { type DelegateBrokerApi, type DelegateMessageDelivery, type DelegateQueuedMessage } from './delegate-broker.js';
import { type DelegateExecutionRequest } from '../commands/delegate.js';
import { deriveExecutionStatus, deriveDelegateStatus, type DelegateJobLike } from '../utils/cli-format.js';
export interface DelegateMessageInput {
    execId: string;
    message: string;
    delivery: DelegateMessageDelivery;
    requestedBy?: string;
}
export interface DelegateMessageResult {
    execId: string;
    accepted: true;
    delivery: DelegateMessageDelivery;
    status: string;
    queuedMessage: DelegateQueuedMessage;
    immediateDispatch: boolean;
    previousStatus: string;
    queueDepth: number;
}
export interface DelegateMessageDependencies {
    historyStore?: CliHistoryStore;
    delegateBroker?: DelegateBrokerApi;
    launchDetachedDelegate?: (request: DelegateExecutionRequest) => void;
}
export declare function normalizeDelegateExecId(value: string): string;
export { deriveExecutionStatus, deriveDelegateStatus, type DelegateJobLike };
/**
 * Map Maestro-internal status names to SEP-1686 Task Lifecycle standard names.
 * queued → submitted, running → working, input_required → input_required,
 * all others pass through unchanged.
 */
export declare function toSep1686Status(maestroStatus: string): string;
export declare function buildDelegateRequestFromState(execId: string, message: string, meta: ExecutionMeta | null, job: {
    metadata?: Record<string, unknown> | null;
} | null): DelegateExecutionRequest | null;
export declare function handleDelegateMessage(input: DelegateMessageInput, dependencies?: DelegateMessageDependencies): DelegateMessageResult;
//# sourceMappingURL=delegate-control.d.ts.map