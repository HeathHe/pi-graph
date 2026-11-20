import { checkLease } from './lease.js';
import { sessionTransitionSchema } from './protocol-schemas.js';
import { createSessionArchiveReceipt, SessionStore } from './store.js';
import { createTransitionOutcome, createTransitionRequest } from './transition-receipts.js';
import { sessionStateV20Schema } from './schemas.js';
export function listRecoveryBlockers(session) {
    const decisions = session.orchestration.decision_points
        .filter(point => point.status === 'escalated')
        .map(point => ({
        kind: 'decision', id: point.point_id, status: 'escalated', dispositions: ['proceed', 'retry'],
    }));
    const steps = session.orchestration.chain
        .filter(step => step.status === 'failed')
        .map(step => ({
        kind: 'step', id: step.step_id, status: 'failed', command: step.command,
        run_id: step.run_id, dispositions: ['retry', 'skip'],
    }));
    return [...decisions, ...steps];
}
function recoveryCommandPrefix(session) {
    return `maestro run recover --session ${session.session_id}`
        + ' --request-id <request-id> --actor <actor> --reason <reason> --evidence <ref>'
        + ` --expected-identity-revision ${session.identity_revision}`
        + ` --expected-activity-revision ${session.activity_revision}`;
}
export function nextRecoveryAction(session) {
    if (session.status !== 'paused') {
        return {
            suggest_only: true,
            command: null,
            reason: `session is ${session.status}; audited recovery applies only to paused Sessions`,
        };
    }
    const blocker = listRecoveryBlockers(session)[0];
    const prefix = recoveryCommandPrefix(session);
    if (!blocker) {
        return {
            suggest_only: true,
            command: `${prefix} --resume`,
            reason: 'all recovery blockers are clear; fill the audit placeholders, then resume explicitly',
        };
    }
    if (blocker.kind === 'decision') {
        return {
            suggest_only: true,
            command: `${prefix} --decision ${blocker.id} --disposition <proceed|retry>`,
            reason: `resolve escalated decision ${blocker.id}; Session remains paused until all blockers are clear`,
        };
    }
    return {
        suggest_only: true,
        command: `${prefix} --step ${blocker.id} --disposition <retry|skip>`,
        reason: `resolve failed chain step ${blocker.id}; Session remains paused until all blockers are clear`,
    };
}
function recoveredNextFromOutcome(result, sessionId) {
    const next = result && typeof result === 'object' && 'next' in result
        ? result.next
        : undefined;
    return next ?? {
        suggest_only: true,
        command: null,
        reason: `legacy recovery receipt has no next snapshot; run maestro run status ${sessionId} before continuing`,
    };
}
function required(value, label) {
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`${label} is required`);
    return normalized;
}
function expectedRevision(value, label) {
    if (!Number.isInteger(value) || value < 0)
        throw new Error(`${label} must be a non-negative integer`);
    return value;
}
function normalizedLeaseClaim(options) {
    const claim = options.leaseClaim ?? {};
    const supplied = [claim.executionOwner, claim.ownerEpoch, claim.leaseId]
        .filter(value => value !== undefined).length;
    if (supplied !== 0 && supplied !== 3) {
        throw new Error('lease claim requires --execution-owner, --owner-epoch, and --lease-id together');
    }
    return supplied === 0 ? {} : claim;
}
function requestFor(store, sessionId, operation, options, payload) {
    const existing = store.readBundle(sessionId).session.requests.find(item => item.type === 'transition' && item.request_id === options.requestId && 'outcome' in item);
    const preconditions = existing?.payload.preconditions ?? store.readSessionFence(sessionId);
    return createTransitionRequest({
        request_id: required(options.requestId, 'request/transition ID'),
        operation,
        subject: { session_id: sessionId, run_id: null, chain_step_id: null },
        requested_at: existing?.payload.requested_at ?? options.requestId,
        preconditions,
        payload,
    });
}
function normalizedEvidence(options) {
    const evidence = (options.evidence ?? []).map(item => item.trim()).filter(Boolean);
    if (evidence.length === 0)
        throw new Error('at least one evidence reference is required');
    return evidence;
}
function commonPayload(options) {
    return {
        actor: required(options.actor, 'actor'),
        reason: required(options.reason, 'reason'),
        evidence: normalizedEvidence(options),
        expected_identity_revision: expectedRevision(options.expectedIdentityRevision, 'expected identity revision'),
        expected_activity_revision: expectedRevision(options.expectedActivityRevision, 'expected activity revision'),
        lease: normalizedLeaseClaim(options),
    };
}
function assertCommonGuards(session, options) {
    if (session.status !== 'paused')
        throw new Error(`session is "${session.status}", expected "paused"`);
    if (session.identity_revision !== options.expectedIdentityRevision) {
        throw new Error(`stale identity revision: expected ${options.expectedIdentityRevision}, current ${session.identity_revision}`);
    }
    if (session.activity_revision !== options.expectedActivityRevision) {
        throw new Error(`stale activity revision: expected ${options.expectedActivityRevision}, current ${session.activity_revision}`);
    }
    if (session.active_run_id)
        throw new Error(`session has active Run ${session.active_run_id}`);
    if (session.orchestration.chain.some(step => step.status === 'running'))
        throw new Error('session has a running chain step');
    const leaseConflict = checkLease(session.orchestration.lease, normalizedLeaseClaim(options));
    if (leaseConflict)
        throw new Error(leaseConflict);
}
function assertNoResumeBlockers(session) {
    const escalated = session.orchestration.decision_points.find(point => point.status === 'escalated');
    if (escalated)
        throw new Error(`unresolved escalated decision: ${escalated.point_id}`);
    const failed = session.orchestration.chain.find(step => step.status === 'failed');
    if (failed)
        throw new Error(`unresolved failed chain step: ${failed.step_id}`);
}
function applyArchiveOperation(projectRoot, sessionId, operation, options) {
    const store = new SessionStore(projectRoot);
    if (!store.sessionExists(sessionId))
        throw new Error(`session not found: ${sessionId}`);
    const requestId = required(options.requestId, 'request id');
    const actor = required(options.actor, 'actor');
    const reason = required(options.reason, 'reason');
    const evidence = normalizedEvidence(options);
    expectedRevision(options.expectedIdentityRevision, 'expected identity revision');
    expectedRevision(options.expectedActivityRevision, 'expected activity revision');
    const prior = store.listSessionArchiveReceipts(sessionId);
    const replay = prior.find(receipt => receipt.receipt_id === requestId);
    if (replay) {
        if (replay.operation !== operation
            || replay.actor !== actor
            || replay.reason !== reason
            || JSON.stringify(replay.evidence_refs) !== JSON.stringify(evidence)
            || replay.before.identity_revision !== options.expectedIdentityRevision
            || replay.before.activity_revision !== options.expectedActivityRevision) {
            throw new Error(`request_id ${requestId} was already used with different archive inputs`);
        }
        return { session: store.applySessionArchiveReceipt(replay), receipt: replay, replayed: true };
    }
    const record = store.readSessionRecord(sessionId);
    if (record.schema_version !== 'session/2.0') {
        throw new Error(`Session ${sessionId} is ${record.schema_version}; archive receipts require session/2.0`);
    }
    const identity = sessionStateV20Schema.parse(record);
    if (identity.identity_revision !== options.expectedIdentityRevision) {
        throw new Error(`stale identity revision: expected ${options.expectedIdentityRevision}, current ${identity.identity_revision}`);
    }
    if (identity.activity_revision !== options.expectedActivityRevision) {
        throw new Error(`stale activity revision: expected ${options.expectedActivityRevision}, current ${identity.activity_revision}`);
    }
    if (operation === 'archive') {
        if (identity.archived_at)
            throw new Error(`Session ${sessionId} is already archived`);
        if (identity.current_execution_id) {
            const current = store.readExecution(sessionId, identity.current_execution_id);
            if (current.status === 'active' || current.status === 'paused') {
                throw new Error(`Session ${sessionId} has ${current.status} current Execution ${current.execution_id}`);
            }
        }
    }
    else if (!identity.archived_at) {
        throw new Error(`Session ${sessionId} is not archived`);
    }
    const recordedAt = (options.now ?? new Date()).toISOString();
    const receipt = createSessionArchiveReceipt({
        receipt_id: requestId,
        operation,
        session_id: sessionId,
        actor,
        reason,
        evidence_refs: evidence,
        recorded_at: recordedAt,
        before: {
            identity_revision: identity.identity_revision,
            activity_revision: identity.activity_revision,
            archived_at: identity.archived_at,
            archived_by: identity.archived_by,
        },
        after: {
            identity_revision: identity.identity_revision,
            activity_revision: identity.activity_revision + 1,
            archived_at: operation === 'archive' ? recordedAt : null,
            archived_by: operation === 'archive' ? actor : null,
        },
        previous_receipt_hash: prior.at(-1)?.receipt_hash ?? null,
    });
    return { session: store.applySessionArchiveReceipt(receipt), receipt, replayed: false };
}
export function archiveSession(projectRoot, sessionId, options) {
    return applyArchiveOperation(projectRoot, sessionId, 'archive', options);
}
export function unarchiveSession(projectRoot, sessionId, options) {
    return applyArchiveOperation(projectRoot, sessionId, 'unarchive', options);
}
export function resolveSession(projectRoot, sessionId, options) {
    const store = new SessionStore(projectRoot);
    if (!store.sessionExists(sessionId))
        throw new Error(`session not found: ${sessionId}`);
    if (store.readSessionRecord(sessionId).schema_version === 'session/2.0') {
        throw new Error(`Session ${sessionId} uses session/2.0; use maestro execution resolve with the current Execution`);
    }
    const payload = { ...commonPayload(options), target: options.target };
    const request = requestFor(store, sessionId, 'resolve', options, payload);
    const evaluated = store.replayOrApplyTransition(sessionId, request, (draft) => {
        assertCommonGuards(draft.session, options);
        const target = options.target;
        if (target.kind === 'decision') {
            const point = draft.session.orchestration.decision_points.find(item => item.point_id === target.id);
            if (!point || point.status !== 'escalated')
                throw new Error(`decision ${target.id} is not escalated`);
            const node = draft.session.orchestration.chain.find(step => step.decision_ref === target.id);
            if (target.disposition === 'proceed') {
                point.status = 'passed';
                if (node)
                    node.status = 'sealed';
            }
            else {
                point.status = 'pending';
                if (node)
                    node.status = 'pending';
            }
            point.evidence_ref = normalizedEvidence(options).join('; ');
        }
        else {
            const step = draft.session.orchestration.chain.find(item => item.step_id === target.id);
            if (!step || step.status !== 'failed')
                throw new Error(`chain step ${target.id} is not failed`);
            if (target.disposition === 'skip')
                step.status = 'skipped';
            else {
                step.status = 'pending';
                step.run_id = null;
            }
        }
        draft.session.activity_revision++;
        const after = { ...request.preconditions, session_activity_revision: draft.session.activity_revision };
        const next = nextRecoveryAction(draft.session);
        return createTransitionOutcome({
            request_id: request.request_id,
            request_hash: request.normalized_request_hash,
            operation: 'resolve',
            status: 'applied',
            applied_at: new Date().toISOString(),
            subject: request.subject,
            postconditions: after,
            exit_code: 0,
            error_code: null,
            result: { target, session_status: draft.session.status, next },
        });
    });
    return sessionTransitionSchema.parse({
        schema_version: 'session-transition/1.0', operation: 'resolve', session_id: sessionId,
        transition_id: evaluated.outcome.transition_id, request_id: request.request_id,
        before: request.preconditions, after: evaluated.outcome.postconditions, replayed: evaluated.replayed,
        next: recoveredNextFromOutcome(evaluated.outcome.result, sessionId),
    });
}
export function resumeSession(projectRoot, sessionId, options) {
    const store = new SessionStore(projectRoot);
    if (!store.sessionExists(sessionId))
        throw new Error(`session not found: ${sessionId}`);
    if (store.readSessionRecord(sessionId).schema_version === 'session/2.0') {
        throw new Error(`Session ${sessionId} uses session/2.0; use maestro execution resume with the current Execution`);
    }
    const payload = commonPayload(options);
    const request = requestFor(store, sessionId, 'resume', options, payload);
    const evaluated = store.replayOrApplyTransition(sessionId, request, (draft) => {
        assertCommonGuards(draft.session, options);
        assertNoResumeBlockers(draft.session);
        draft.session.status = 'running';
        draft.session.activity_revision++;
        const after = { ...request.preconditions, session_activity_revision: draft.session.activity_revision };
        return createTransitionOutcome({
            request_id: request.request_id,
            request_hash: request.normalized_request_hash,
            operation: 'resume', status: 'applied', applied_at: new Date().toISOString(),
            subject: request.subject, postconditions: after, exit_code: 0, error_code: null,
            result: { session_status: 'running' },
        });
    });
    return sessionTransitionSchema.parse({
        schema_version: 'session-transition/1.0', operation: 'resume', session_id: sessionId,
        transition_id: evaluated.outcome.transition_id, request_id: request.request_id,
        before: request.preconditions, after: evaluated.outcome.postconditions, replayed: evaluated.replayed,
        next: { suggest_only: true, command: `maestro run next --session ${sessionId}`, reason: 'Session resumed; Run creation remains an explicit next operation' },
    });
}
//# sourceMappingURL=session-transition.js.map