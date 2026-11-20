import { V3StructuredError } from './errors.js';
export type SessionContextSource = 'explicit_session_id' | 'current_binding' | 'open_sessions' | 'runnable_candidates';
export type SessionReferenceAccess = 'accessible' | 'not_found' | 'inaccessible';
/**
 * Store adapters resolve reference availability before calling this module.
 * This keeps context selection deterministic and independent of schema/store I/O.
 */
export interface SessionReferenceInput {
    session_id: string;
    access: SessionReferenceAccess;
}
export interface SessionContextCandidateInput {
    session_id: string;
}
export interface ResolveSessionContextInput {
    explicit_session?: SessionReferenceInput | null;
    current_binding?: SessionReferenceInput | null;
    open_sessions?: readonly SessionContextCandidateInput[];
    runnable_candidates?: readonly SessionContextCandidateInput[];
}
export interface ResolvedSessionContext {
    ok: true;
    session_id: string;
    source: SessionContextSource;
}
export type SessionContextErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_INACCESSIBLE' | 'SESSION_AMBIGUOUS' | 'SESSION_CONTEXT_INVALID' | 'SESSION_CONTEXT_UNRESOLVED';
export interface SessionContextResolutionError {
    code: SessionContextErrorCode;
    message: string;
    source: SessionContextSource | null;
    candidates: string[];
    next_actions: string[];
}
export interface UnresolvedSessionContext {
    ok: false;
    error: SessionContextResolutionError;
}
export type ResolveSessionContextResult = ResolvedSessionContext | UnresolvedSessionContext;
/** Convert the pure resolver result into the single V3/domain error representation. */
export declare function sessionContextErrorToV3Error(error: SessionContextResolutionError): V3StructuredError;
/**
 * Resolve fail-closed in this exact order:
 * explicit ID > current binding > unique open Session > unique runnable candidate.
 */
export declare function resolveSessionContext(input: ResolveSessionContextInput): ResolveSessionContextResult;
