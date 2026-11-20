import { CliHistoryStore } from '../agents/cli-history-store.js';
import { DelegateBrokerClient } from './delegate-broker-client.js';
import { launchDetachedDelegateWorker, } from '../commands/delegate.js';
import { resolveAgentRepositoryContext } from '../repository/context.js';
import { deriveExecutionStatus, deriveDelegateStatus, } from '../utils/cli-format.js';
function readStringArray(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value.filter((item) => typeof item === 'string');
    return strings.length > 0 ? strings : undefined;
}
export function normalizeDelegateExecId(value) {
    const trimmed = value.trim();
    return trimmed.startsWith('cli-history-')
        ? trimmed.slice('cli-history-'.length)
        : trimmed;
}
export { deriveExecutionStatus, deriveDelegateStatus };
/**
 * Map Maestro-internal status names to SEP-1686 Task Lifecycle standard names.
 * queued → submitted, running → working, input_required → input_required,
 * all others pass through unchanged.
 */
export function toSep1686Status(maestroStatus) {
    switch (maestroStatus) {
        case 'queued':
            return 'submitted';
        case 'running':
            return 'working';
        default:
            return maestroStatus;
    }
}
export function buildDelegateRequestFromState(execId, message, meta, job) {
    const metadata = job?.metadata ?? null;
    const tool = meta?.tool ?? (typeof metadata?.tool === 'string' ? metadata.tool : null);
    const metaMode = meta?.mode === 'analysis' || meta?.mode === 'write'
        ? meta.mode
        : null;
    const metadataMode = metadata?.mode === 'analysis' || metadata?.mode === 'write'
        ? metadata.mode
        : null;
    const mode = metaMode ?? metadataMode;
    const workDir = meta?.workDir ?? (typeof metadata?.workDir === 'string' ? metadata.workDir : null);
    const rawRepositoryContext = metadata?.repositoryContext;
    let repositoryContext = rawRepositoryContext
        && typeof rawRepositoryContext === 'object'
        && typeof rawRepositoryContext.currentProjectRoot === 'string'
        ? rawRepositoryContext
        : null;
    if (!tool || !mode || !workDir)
        return null;
    if (!repositoryContext) {
        try {
            repositoryContext = resolveAgentRepositoryContext(workDir, {
                allowLegacyReadFallback: mode === 'analysis',
            });
        }
        catch {
            return null;
        }
    }
    if (mode === 'write' && (!repositoryContext.currentRepoId || !repositoryContext.identityPersisted))
        return null;
    return {
        prompt: message,
        tool,
        mode,
        model: meta?.model ?? (typeof metadata?.model === 'string' ? metadata.model : undefined),
        workDir,
        rule: typeof metadata?.rule === 'string' ? metadata.rule : undefined,
        execId,
        resume: execId,
        includeDirs: readStringArray(metadata?.includeDirs),
        sessionId: typeof metadata?.sessionId === 'string' ? metadata.sessionId : undefined,
        backend: metadata?.backend === 'terminal' ? 'terminal' : 'direct',
        repositoryContext,
    };
}
export function handleDelegateMessage(input, dependencies = {}) {
    const historyStore = dependencies.historyStore ?? new CliHistoryStore();
    const delegateBroker = dependencies.delegateBroker ?? new DelegateBrokerClient();
    const launchDelegate = dependencies.launchDetachedDelegate ?? launchDetachedDelegateWorker;
    const execId = normalizeDelegateExecId(input.execId);
    const message = input.message.trim();
    if (!execId) {
        throw new Error('execId is required');
    }
    if (!message) {
        throw new Error('message is required');
    }
    const meta = historyStore.loadMeta(execId);
    const job = delegateBroker.getJob(execId);
    if (!meta && !job) {
        throw new Error(`Delegate execution not found: ${execId}`);
    }
    if (!job) {
        throw new Error(`Delegate broker state unavailable for: ${execId}`);
    }
    const currentStatus = deriveDelegateStatus(meta, job);
    const queued = delegateBroker.queueMessage({
        jobId: execId,
        message,
        delivery: input.delivery,
        requestedBy: input.requestedBy,
    });
    let statusAfterQueue = deriveDelegateStatus(meta, delegateBroker.getJob(execId));
    let immediateDispatch = false;
    if (currentStatus === 'completed'
        || currentStatus === 'failed'
        || currentStatus === 'cancelled') {
        const request = buildDelegateRequestFromState(execId, message, meta, job);
        if (!request) {
            delegateBroker.updateMessage({
                jobId: execId,
                messageId: queued.messageId,
                status: 'dropped',
                dispatchReason: 'missing-delegate-context',
            });
            throw new Error(`Unable to reconstruct delegate request for terminal execution: ${execId}`);
        }
        try {
            launchDelegate(request);
            delegateBroker.updateMessage({
                jobId: execId,
                messageId: queued.messageId,
                status: 'dispatched',
                dispatchReason: `terminal:${currentStatus}`,
            });
            immediateDispatch = true;
            statusAfterQueue = deriveDelegateStatus(historyStore.loadMeta(execId), delegateBroker.getJob(execId));
        }
        catch {
            delegateBroker.updateMessage({
                jobId: execId,
                messageId: queued.messageId,
                status: 'dropped',
                dispatchReason: 'launch-failed',
            });
            throw new Error(`Failed to relaunch delegate for terminal execution: ${execId}`);
        }
    }
    else if (input.delivery === 'inject') {
        // Inject delivery: queue the message for poller pickup. The poller in
        // cli-agent-runner auto-routes based on adapter capabilities:
        //   - interactive adapter → sendMessage (no interruption)
        //   - non-interactive adapter → requestCancel + resume
        statusAfterQueue = deriveDelegateStatus(meta, delegateBroker.getJob(execId));
    }
    const queuedMessage = delegateBroker
        .listMessages(execId)
        .find((item) => item.messageId === queued.messageId) ?? queued;
    return {
        execId,
        accepted: true,
        delivery: input.delivery,
        status: statusAfterQueue,
        queuedMessage,
        immediateDispatch,
        previousStatus: currentStatus,
        queueDepth: delegateBroker
            .listMessages(execId)
            .filter((item) => item.status === 'queued')
            .length,
    };
}
//# sourceMappingURL=delegate-control.js.map