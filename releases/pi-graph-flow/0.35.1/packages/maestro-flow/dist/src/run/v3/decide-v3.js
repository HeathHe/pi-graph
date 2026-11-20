import { randomUUID } from 'node:crypto';
import { assertSafePathSegment } from '../ids.js';
import { createRevisionConflictError, V3StructuredError } from './errors.js';
import { v3DecideNext, v3RunNext, v3SessionCompleteNext } from './continuation-v3.js';
import { canonicalPayloadHash, createRequestReceipt, createTransitionReceipt, replayRequestReceipt, transitionReceiptRef, } from './receipts.js';
import { assertSessionOperationAllowed, } from './session-machine.js';
const VERDICTS = ['proceed', 'fix', 'escalate'];
const CONFIDENCES = ['high', 'medium', 'low'];
function required(value, label) {
    const normalized = value.trim();
    if (!normalized)
        throw new V3StructuredError('INVALID_ARGUMENT', `${label} is required`);
    return normalized;
}
function normalizedIdentity(input) {
    const sessionId = required(input.sessionId, 'session ID');
    const requestId = required(input.requestId, 'request ID');
    const actorId = required(input.actorId, 'actor ID');
    assertSafePathSegment(sessionId, 'session ID');
    assertSafePathSegment(requestId, 'request ID');
    return {
        sessionId,
        requestId,
        actorId,
        reason: required(input.reason, 'reason'),
        evidenceRefs: [...new Set((input.evidenceRefs ?? []).map(item => item.trim()).filter(Boolean))].sort(),
        recordedAt: input.recordedAt ?? new Date().toISOString(),
    };
}
function auditPayload(identity) {
    return {
        actor_id: identity.actorId,
        reason: identity.reason,
        evidence_refs: identity.evidenceRefs,
    };
}
function assertRevision(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new V3StructuredError('INVALID_ARGUMENT', `${label} must be a non-negative safe integer`);
    }
}
function assertOrchestrationRevision(session, expected) {
    assertRevision(expected, 'expected orchestration revision');
    if (session.orchestration_revision !== expected) {
        throw createRevisionConflictError({
            code: 'ORCHESTRATION_REVISION_CONFLICT',
            targetType: 'orchestration',
            targetId: session.session_id,
            expectedRevision: expected,
            currentRevision: session.orchestration_revision,
            changedBy: 'unknown',
        });
    }
}
function replay(tx, identity, payloadHash) {
    const transition = replayRequestReceipt({
        tx,
        sessionId: identity.sessionId,
        requestId: identity.requestId,
        // participant_id = actor_id on receipts; the replay key is actor-based.
        participantId: identity.actorId,
        payloadHash,
    });
    return transition ? { status: 'replayed', transition } : null;
}
function stageApplied(input) {
    const transitionId = `tr_${randomUUID()}`;
    const transition = createTransitionReceipt({
        transitionId,
        requestId: input.identity.requestId,
        sessionId: input.identity.sessionId,
        activityRevision: input.session.activity_revision,
        targetType: input.targetType,
        targetId: input.targetId,
        revisionBefore: input.revisionBefore,
        revisionAfter: input.revisionAfter,
        actorId: input.identity.actorId,
        participantId: input.identity.actorId,
        reason: input.identity.reason,
        evidenceRefs: input.identity.evidenceRefs,
        recordedAt: input.identity.recordedAt,
        result: input.result,
    });
    const reference = transitionReceiptRef(transition.activity_revision, transition.transition_id);
    const request = createRequestReceipt({
        requestId: input.identity.requestId,
        participantId: input.identity.actorId,
        payloadHash: input.payloadHash,
        transitionReceiptRef: reference,
    });
    input.tx.writeSession(input.session);
    input.tx.writeTransitionReceipt(transition);
    input.tx.writeRequestReceipt(request);
    return { status: 'applied', transition };
}
function updatedSessionActivity(session, recordedAt, orchestrationRevision = session.orchestration_revision) {
    return {
        ...session,
        orchestration_revision: orchestrationRevision,
        activity_revision: session.activity_revision + 1,
        updated_at: recordedAt,
    };
}
function decisionStatusForVerdict(verdict) {
    return verdict === 'escalate' ? 'escalated' : 'resolved';
}
/**
 * Record a decision point verdict against a session/3.0 Session authority.
 *
 * Shared by `decideV3` (standalone mutation) and `completeRunAndAdvance`
 * (chain-proposal decide operations, applied atomically inside the same
 * transaction). It owns the decisions-array upsert, the chain step
 * decision_refs linkage, and the verdict → status / status transition
 * mapping. It deliberately does NOT stage transactions, CAS revisions, or
 * receipts — callers own those (plus the payload hash for replay identity).
 *
 * Verdict semantics:
 *   proceed/fix → decision ref becomes `resolved`, Session stays `open`
 *   escalate    → decision ref becomes `escalated`, Session stays in its
 *                 current status (no pause). Chain advancement past a gate
 *                 stays blocked until the decision is re-decided to
 *                 proceed/fix (enforced by the run next gate check in
 *                 mutation-engine.ts).
 */
export function applyV3DecisionRecord(session, input) {
    const pointId = required(input.pointId, 'decision point ID');
    if (!VERDICTS.includes(input.verdict)) {
        throw new V3StructuredError('INVALID_ARGUMENT', 'verdict must be proceed, fix, or escalate');
    }
    if (!CONFIDENCES.includes(input.confidence)) {
        throw new V3StructuredError('INVALID_ARGUMENT', 'confidence must be high, medium, or low');
    }
    const verdict = input.verdict;
    const afterStepId = input.afterStepId?.trim() || null;
    const stepIndex = afterStepId
        ? session.chain.findIndex(step => step.step_id === afterStepId)
        : session.chain.findIndex(step => step.status === 'pending');
    if (afterStepId && stepIndex < 0) {
        throw new V3StructuredError('INVALID_ARGUMENT', `unknown chain step ${afterStepId}`);
    }
    const afterStepIdResolved = stepIndex >= 0 ? session.chain[stepIndex].step_id : null;
    const decisionStatus = decisionStatusForVerdict(verdict);
    const evidenceRefs = [...new Set((input.evidenceRefs ?? []).map(item => item.trim()).filter(Boolean))].sort();
    const existing = session.decisions.find(decision => decision.decision_id === pointId);
    const decisions = existing
        ? session.decisions.map(decision => decision.decision_id === pointId
            ? {
                ...decision,
                status: decisionStatus,
                evidence_refs: [...new Set([...decision.evidence_refs, ...evidenceRefs])].sort(),
            }
            : decision)
        : [...session.decisions, {
                decision_id: pointId,
                after_step_id: afterStepIdResolved,
                status: decisionStatus,
                evidence_refs: evidenceRefs,
            }];
    const chain = stepIndex >= 0
        ? session.chain.map((step, index) => index === stepIndex
            ? { ...step, decision_refs: [...new Set([...step.decision_refs, pointId])].sort() }
            : step)
        : session.chain;
    const nextSession = { ...session, decisions, chain };
    return { session: nextSession, decisionStatus };
}
/**
 * Record a decision point verdict against a session/3.0 Session.
 *
 * Mirrors `completeRunAndAdvance` from mutation-engine.ts: normalized identity,
 * canonical payload hash, one locked withV30Transaction, request-receipt replay
 * idempotency, orchestration-revision CAS, then one staged transition receipt.
 * The decisions array upsert and the chain step decision_refs linkage commit
 * together with the receipt, so replays never re-apply.
 *
 * Verdict semantics:
 *   proceed/fix → decision ref becomes `resolved`, Session stays `open`
 *   escalate    → decision ref becomes `escalated`, Session stays in its
 *                 current status (no pause). Chain advancement past a gate
 *                 stays blocked until the decision is re-decided.
 */
export function decideV3(store, input) {
    const identity = normalizedIdentity(input);
    const pointId = required(input.pointId, 'decision point ID');
    const verdict = input.verdict;
    const afterStepId = input.afterStepId?.trim() || null;
    const payload = {
        operation: 'run-decide', point_id: pointId, verdict,
        confidence: input.confidence,
        summary: input.summary?.trim() || null,
        expected_orchestration_revision: input.expectedOrchestrationRevision,
        after_step_id: afterStepId,
        ...auditPayload(identity),
    };
    const payloadHash = canonicalPayloadHash(payload);
    return store.withV30Transaction(identity.sessionId, tx => {
        const replayed = replay(tx, identity, payloadHash);
        if (replayed)
            return replayed;
        const session = tx.readSession();
        assertOrchestrationRevision(session, input.expectedOrchestrationRevision);
        assertSessionOperationAllowed(session.status, 'decide');
        const applied = applyV3DecisionRecord(session, {
            pointId,
            verdict,
            confidence: input.confidence,
            summary: input.summary,
            evidenceRefs: identity.evidenceRefs,
            afterStepId,
        });
        const decisionStatus = applied.decisionStatus;
        const nextSession = updatedSessionActivity(applied.session, identity.recordedAt, session.orchestration_revision + 1);
        const unresolvedGate = nextSession.chain
            .filter(step => step.status === 'completed' && step.decision_ref !== null)
            .map(step => step.decision_ref)
            .find(decisionId => {
            const decision = nextSession.decisions.find(item => item.decision_id === decisionId);
            return !decision || decision.status === 'open' || decision.status === 'escalated';
        });
        const hasPendingStep = nextSession.chain.some(step => step.status === 'pending');
        const continuation = verdict === 'escalate' || unresolvedGate !== undefined
            ? v3DecideNext({
                sessionId: identity.sessionId,
                pointId: verdict === 'escalate' ? pointId : unresolvedGate,
                orchestrationRevision: nextSession.orchestration_revision,
                reason: verdict === 'escalate'
                    ? 'Decision escalated - re-decide once the blocker is resolved; run next remains blocked'
                    : `Decision ${unresolvedGate} remains unresolved; decide it before continuing`,
            })
            : hasPendingStep
                ? v3RunNext({
                    sessionId: identity.sessionId,
                    orchestrationRevision: nextSession.orchestration_revision,
                    reason: 'Decision recorded - run next may advance the chain',
                })
                : v3SessionCompleteNext({
                    sessionId: identity.sessionId,
                    orchestrationRevision: nextSession.orchestration_revision,
                    reason: 'Decision recorded - no pending chain step remains, so complete the Session',
                });
        return stageApplied({
            tx, identity, payloadHash, session: nextSession,
            targetType: 'orchestration', targetId: identity.sessionId,
            revisionBefore: session.orchestration_revision,
            revisionAfter: nextSession.orchestration_revision,
            result: {
                point_id: pointId,
                status: decisionStatus,
                orchestration_revision: nextSession.orchestration_revision,
                ...continuation,
            },
        });
    });
}
//# sourceMappingURL=decide-v3.js.map