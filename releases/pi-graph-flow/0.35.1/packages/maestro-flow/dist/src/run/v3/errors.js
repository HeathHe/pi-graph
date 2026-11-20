import { runResponseErrorDetailV12Schema, } from '../protocol-schemas.js';
function normalizedActions(actions) {
    if (actions === undefined)
        return [];
    return actions.map(action => action.trim()).filter(Boolean);
}
function definedDetails(details) {
    return Object.fromEntries(Object.entries(details ?? {}).filter(([, value]) => value !== undefined));
}
function stableSessionIds(sessionIds) {
    return [...new Set(sessionIds.map(sessionId => sessionId.trim()).filter(Boolean))].sort();
}
export class V3StructuredError extends Error {
    code;
    retryable;
    details;
    target_type;
    target_id;
    expected_revision;
    current_revision;
    changed_by;
    next_actions;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'V3StructuredError';
        this.code = code;
        this.retryable = details.retryable ?? false;
        this.details = definedDetails(details.details);
        this.target_type = details.target_type ?? null;
        this.target_id = details.target_id ?? null;
        this.expected_revision = details.expected_revision ?? null;
        this.current_revision = details.current_revision ?? null;
        this.changed_by = details.changed_by ?? null;
        this.next_actions = normalizedActions(details.next_actions);
    }
    toRunResponseV12ErrorDetail() {
        return runResponseErrorDetailV12Schema.parse({
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            details: { ...this.details },
            target_type: this.target_type,
            target_id: this.target_id,
            expected_revision: this.expected_revision,
            current_revision: this.current_revision,
            changed_by: this.changed_by,
            next_actions: [...this.next_actions],
        });
    }
    toJSON() {
        return this.toRunResponseV12ErrorDetail();
    }
}
export function createRevisionConflictError(input) {
    return new V3StructuredError(input.code, `revision conflict for ${input.targetType} ${input.targetId}`, {
        retryable: true,
        target_type: input.targetType,
        target_id: input.targetId,
        expected_revision: input.expectedRevision,
        current_revision: input.currentRevision,
        changed_by: input.changedBy,
        next_actions: input.nextActions ?? ['reload-target', 're-evaluate-intent', 'resubmit-with-new-request-id'],
    });
}
export function createRequestConflictError(input) {
    return new V3StructuredError('REQUEST_CONFLICT', `request ${input.requestId} conflicts with an existing receipt`, {
        details: {
            request_id: input.requestId,
            ...(input.changedBy !== undefined ? { changed_by: input.changedBy } : {}),
        },
        next_actions: input.nextActions ?? ['use-the-original-payload', 'submit-with-new-request-id'],
    });
}
export function createSessionAmbiguousError(input) {
    const candidates = stableSessionIds(input.candidateSessionIds);
    return new V3StructuredError('SESSION_AMBIGUOUS', 'multiple Sessions match the current context', {
        details: {
            candidates,
            ...(input.source !== undefined ? { source: input.source } : {}),
        },
        next_actions: input.nextActions ?? candidates.map(sessionId => `select-session:${sessionId}`),
    });
}
export function createSessionSchemaUnsupportedError(input) {
    return new V3StructuredError('SESSION_SCHEMA_UNSUPPORTED', `Session ${input.sessionId} uses unsupported schema ${input.schemaVersion}`, {
        details: { session_id: input.sessionId, schema_version: input.schemaVersion },
        next_actions: input.nextActions ?? ['upgrade-maestro', 'use-a-schema-compatible-command'],
    });
}
//# sourceMappingURL=errors.js.map