export const DEFAULT_SESSION_SCHEMA_SELECTION = {
    schema_version: 'session-schema-selection/1.0',
    writer: 'session/3.0',
    features: { session_statusless: false },
};
export function createSessionState(sessionId, intent, options = {}) {
    return {
        schema_version: 'session/1.3',
        session_id: sessionId,
        intent,
        intent_identity: options.intentIdentity ?? null,
        topic_identity: null,
        provenance: options.provenance ?? {
            source: 'native',
            forked_from: null,
            imported_from: [],
            created_by: 'session-store',
        },
        status: 'running',
        identity_revision: 1,
        activity_revision: 0,
        active_run_id: null,
        latest_completed_run_id: null,
        boundary_contract: {
            in_scope: [],
            out_of_scope: [],
            constraints: [],
            definition_of_done: '',
        },
        orchestration: {
            engine: 'manual',
            quality_mode: 'standard',
            auto_mode: false,
            chain: [],
            decision_points: [],
            position: null,
            decomposition: null,
            lease: null,
            executor: null,
        },
        requests: [],
        ralph_authority: null,
        lifecycle: {
            sealed_at: null,
            seal_summary: null,
            promoted_spec_ids: [],
            promoted_knowhow_ids: [],
            forked_from: null,
        },
        refs: { gates: 'gates.json', artifacts: 'artifacts.json', evidence: 'evidence.json' },
    };
}
export function createSessionIdentityV20(sessionId, intent, options = {}) {
    return {
        schema_version: 'session/2.0',
        session_id: sessionId,
        intent,
        topic_identity: options.topicIdentity ?? null,
        identity_revision: options.identityRevision ?? 1,
        activity_revision: options.activityRevision ?? 0,
        current_execution_id: options.currentExecutionId ?? null,
        latest_execution_id: options.latestExecutionId ?? null,
        latest_completed_run_id: options.latestCompletedRunId ?? null,
        archived_at: options.archivedAt ?? null,
        archived_by: options.archivedBy ?? null,
    };
}
export function createGateRegistry() {
    return {
        schema_version: 'gates/1.0',
        revision: 0,
        gates: {},
        summary: { total: 0, passed: 0, blocked: 0, failed: 0, active_gate_ids: [], blocking_run_id: null },
    };
}
export function createArtifactRegistry() {
    return { schema_version: 'artifacts/1.0', revision: 0, artifacts: {}, aliases: {} };
}
export function createEvidenceStore() {
    return { schema_version: 'evidence/1.0', revision: 0, records: {} };
}
/**
 * Create the additive execution/1.0 projection for an existing Session. The
 * legacy Session remains authoritative for compatibility callers and is not
 * mutated by this projection.
 */
export function createExecutionState(session, options) {
    return {
        schema_version: 'execution/1.0',
        execution_id: options.executionId,
        session_id: session.session_id,
        generation: options.generation,
        status: session.status === 'paused' ? 'paused' : 'active',
        revision: 0,
        active_run_id: session.active_run_id,
        chain: structuredClone(session.orchestration.chain),
        decision_points: structuredClone(session.orchestration.decision_points),
        gates_ref: 'gates.json',
        artifacts_ref: 'artifacts.json',
        evidence_ref: 'evidence.json',
        lease: null,
        started_at: options.startedAt,
        sealed_at: null,
        seal_summary: null,
        final_outcome: null,
    };
}
//# sourceMappingURL=defaults.js.map