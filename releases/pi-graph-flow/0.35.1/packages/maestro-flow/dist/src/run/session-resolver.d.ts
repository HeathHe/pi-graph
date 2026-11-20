import { SessionStore, type SessionBundle } from './store.js';
import { type ExecutionState, type SessionState, type SessionStateRead } from './schemas.js';
export interface ResolvedSession {
    sessionId: string;
    sessionDir: string;
    bundle: SessionBundle;
    record: SessionStateRead;
    currentExecution: ExecutionState | null;
    latestExecution: ExecutionState | null;
    /** Compatibility lifecycle derived from Execution for session/2.0. */
    derivedStatus: SessionState['status'];
}
export interface ResolveCompatibleSessionOptions {
    statuses?: SessionState['status'][];
}
export declare function readResolvedSession(store: SessionStore, sessionId: string): ResolvedSession;
/**
 * Resolve an explicit Session or the newest compatible Session.
 *
 * Resolution priority (multi-session safe):
 *   1. Explicit `sessionId` argument → O(1) direct read
 *   2. `MAESTRO_SESSION_ID` environment variable → O(1) direct read
 *   3. `state.json` sessions list — unique running candidate → O(1)
 *   4. Multiple running candidates → null (caller must pass --session)
 *   5. Full directory scan fallback (sorted by mtime)
 */
export declare function resolveCompatibleSession(projectRoot: string, sessionId?: string, options?: ResolveCompatibleSessionOptions): ResolvedSession | null;
//# sourceMappingURL=session-resolver.d.ts.map