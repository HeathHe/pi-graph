import { activeStepIndex } from './chain.js';
import { inspectSessionContinuation } from './continuation.js';
import { sessionStateV20Schema } from './schemas.js';
import { listRecoveryBlockers, nextRecoveryAction } from './session-transition.js';
export function summarizeSession(projectRoot, resolved) {
    const { session, artifacts, evidence, gates } = resolved.bundle;
    if (resolved.record.schema_version === 'session/2.0') {
        const identity = sessionStateV20Schema.parse(resolved.record);
        const execution = resolved.currentExecution ?? resolved.latestExecution;
        const chain = execution?.chain ?? [];
        return {
            schema_version: 'session/2.0',
            session_id: resolved.sessionId,
            intent: identity.intent,
            archived_at: identity.archived_at,
            archived_by: identity.archived_by,
            current_execution_id: identity.current_execution_id,
            latest_execution_id: identity.latest_execution_id,
            latest_completed_run_id: identity.latest_completed_run_id,
            derived: {
                availability: identity.archived_at ? 'archived' : 'available',
                execution_status: execution?.status ?? null,
                active_run_id: resolved.currentExecution?.active_run_id ?? null,
            },
            progress: {
                terminal: chain.filter(step => ['completed', 'sealed', 'skipped'].includes(step.status)).length,
                total: chain.length,
                pending: chain.filter(step => step.status === 'pending').length,
            },
            revisions: { identity: identity.identity_revision, activity: identity.activity_revision },
            registry: {
                artifacts: Object.keys(artifacts.artifacts).length,
                evidence: Object.keys(evidence.records).length,
                gates: Object.keys(gates.gates).length,
            },
        };
    }
    const chain = session.orchestration.chain;
    const active = activeStepIndex(session);
    const terminal = chain.filter(step => ['completed', 'sealed', 'skipped'].includes(step.status)).length;
    const pending = chain.filter(step => step.status === 'pending').length;
    const activeStep = active === null ? null : {
        index: active,
        step: chain[active],
    };
    const blockers = listRecoveryBlockers(session);
    return {
        session_id: resolved.sessionId,
        status: session.status,
        engine: session.orchestration.engine,
        intent: session.intent,
        progress: { terminal, total: chain.length, pending },
        active_step: activeStep ? {
            index: activeStep.index,
            step_id: activeStep.step.step_id,
            command: activeStep.step.command,
            status: activeStep.step.status,
            run_id: activeStep.step.run_id,
            decision_ref: activeStep.step.decision_ref,
        } : null,
        active_run_id: session.active_run_id,
        latest_completed_run_id: session.latest_completed_run_id,
        revisions: { identity: session.identity_revision, activity: session.activity_revision },
        recovery: {
            blockers,
            can_resume: session.status === 'paused' && blockers.length === 0,
            next: nextRecoveryAction(session),
        },
        position: session.orchestration.position,
        decomposition: session.orchestration.decomposition,
        registry: {
            artifacts: Object.keys(artifacts.artifacts).length,
            evidence: Object.keys(evidence.records).length,
            gates: Object.keys(gates.gates).length,
        },
        continuation: inspectSessionContinuation(projectRoot, resolved.sessionId),
    };
}
//# sourceMappingURL=session-status.js.map