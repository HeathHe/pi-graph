import { V3StructuredError } from './errors.js';
const SESSION_CONTEXT_ERROR_CODE_MAP = {
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    SESSION_INACCESSIBLE: 'INVALID_STATE_TRANSITION',
    SESSION_AMBIGUOUS: 'SESSION_AMBIGUOUS',
    SESSION_CONTEXT_INVALID: 'INVALID_ARGUMENT',
    SESSION_CONTEXT_UNRESOLVED: 'INVALID_STATE_TRANSITION',
};
/** Convert the pure resolver result into the single V3/domain error representation. */
export function sessionContextErrorToV3Error(error) {
    return new V3StructuredError(SESSION_CONTEXT_ERROR_CODE_MAP[error.code], error.message, {
        details: {
            context_error_code: error.code,
            source: error.source,
            candidates: [...error.candidates],
        },
        next_actions: error.next_actions,
    });
}
function compareSessionIds(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function canonicalSessionId(sessionId) {
    return sessionId.trim();
}
function uniqueSortedSessionIds(candidates) {
    return [...new Set(candidates.map(candidate => canonicalSessionId(candidate.session_id)))]
        .sort(compareSessionIds);
}
function invalidId(source) {
    return {
        ok: false,
        error: {
            code: 'SESSION_CONTEXT_INVALID',
            message: `Session context from ${source} contains an empty session ID.`,
            source,
            candidates: [],
            next_actions: ['provide-a-non-empty-session-id'],
        },
    };
}
function resolveReference(reference, source) {
    const sessionId = canonicalSessionId(reference.session_id);
    if (sessionId.length === 0)
        return invalidId(source);
    if (reference.access === 'accessible') {
        return { ok: true, session_id: sessionId, source };
    }
    const code = reference.access === 'not_found' ? 'SESSION_NOT_FOUND' : 'SESSION_INACCESSIBLE';
    const condition = reference.access === 'not_found' ? 'does not exist' : 'is not accessible';
    const nextAction = reference.access === 'not_found'
        ? 'provide-an-existing-session-id'
        : 'check-session-access';
    return {
        ok: false,
        error: {
            code,
            message: `Session ${sessionId} from ${source} ${condition}.`,
            source,
            candidates: [sessionId],
            next_actions: [nextAction],
        },
    };
}
function resolveCandidateTier(candidates, source) {
    if (candidates.some(candidate => canonicalSessionId(candidate.session_id).length === 0)) {
        return invalidId(source);
    }
    const sessionIds = uniqueSortedSessionIds(candidates);
    if (sessionIds.length === 0)
        return null;
    if (sessionIds.length === 1) {
        return { ok: true, session_id: sessionIds[0], source };
    }
    return {
        ok: false,
        error: {
            code: 'SESSION_AMBIGUOUS',
            message: `Multiple sessions are eligible from ${source}; select one explicitly.`,
            source,
            candidates: sessionIds,
            next_actions: sessionIds.map(sessionId => `select-session:${sessionId}`),
        },
    };
}
/**
 * Resolve fail-closed in this exact order:
 * explicit ID > current binding > unique open Session > unique runnable candidate.
 */
export function resolveSessionContext(input) {
    if (input.explicit_session) {
        return resolveReference(input.explicit_session, 'explicit_session_id');
    }
    if (input.current_binding) {
        return resolveReference(input.current_binding, 'current_binding');
    }
    const openResult = resolveCandidateTier(input.open_sessions ?? [], 'open_sessions');
    if (openResult)
        return openResult;
    const runnableResult = resolveCandidateTier(input.runnable_candidates ?? [], 'runnable_candidates');
    if (runnableResult)
        return runnableResult;
    return {
        ok: false,
        error: {
            code: 'SESSION_CONTEXT_UNRESOLVED',
            message: 'No explicit, bound, open, or runnable Session is available.',
            source: null,
            candidates: [],
            next_actions: ['provide-an-explicit-session-id', 'open-a-session'],
        },
    };
}
//# sourceMappingURL=resolve-context.js.map