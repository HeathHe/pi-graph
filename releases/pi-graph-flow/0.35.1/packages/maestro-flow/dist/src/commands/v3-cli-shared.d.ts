import { type Command } from 'commander';
import type { RunOperationV12 } from '../run/protocol-schemas.js';
import { type SessionStateV30 } from '../run/schemas.js';
import { SessionStore } from '../run/store.js';
import type { V3MutationResult } from '../run/v3/mutation-engine.js';
import { type SessionStatus } from '../run/v3/session-machine.js';
export interface V3CommonOptions {
    session?: string;
    participant: string;
    actor: string;
    requestId: string;
    expectedOrchestrationRevision?: number;
    expectedRunRevision?: number;
    reason: string;
    evidence: string[];
    json?: boolean;
    workflowRoot: string;
}
export type ResolvedV3CommonOptions = Omit<V3CommonOptions, 'session'> & {
    session: string;
};
export declare function collectV3(value: string, previous?: string[]): string[];
export declare function parseV3Revision(value: string): number;
export declare function addV3ReadOptions(command: Command): Command;
export declare function assertV3ParticipantIdentity(options: {
    participant: string;
    actor: string;
}): void;
export declare function applyV3MutationIdentityDefaults(thisCommand: Command): void;
export declare function addV3MutationOptions(command: Command, target: 'run' | 'orchestration'): Command;
export declare function v3Store(options: {
    workflowRoot: string;
}): SessionStore;
export declare function resolveV3Options<T extends {
    session?: string;
    workflowRoot: string;
}>(options: T): {
    store: SessionStore;
    options: T & {
        session: string;
    };
};
export declare function mutationIdentity(options: ResolvedV3CommonOptions): {
    sessionId: string;
    actorId: string;
    requestId: string;
    reason: string;
    evidenceRefs: string[];
};
export declare function emitV3Success(input: {
    operation: RunOperationV12;
    sessionId: string | null;
    runId?: string | null;
    requestId?: string | null;
    result: unknown;
    mutation?: V3MutationResult;
}): void;
export declare function emitV3Error(operation: RunOperationV12, error: unknown, options: {
    session?: string;
    runId?: string;
    requestId?: string;
}): void;
/**
 * Retired v2 command names stay routable on the session/3.0 surface: the stub
 * prints a human hint on stderr AND emits a run-response/1.2
 * SESSION_SCHEMA_UNSUPPORTED envelope on stdout carrying the replacement,
 * matching the retired Execution command family.
 */
export declare function registerV3RetiredStub(parent: Command, commandName: string, operation: RunOperationV12, replacement: string): void;
export type SessionStatusOperation = 'session-archive' | 'session-unarchive';
export declare function mutateSessionStatusV3(store: SessionStore, options: ResolvedV3CommonOptions, toStatus: Extract<SessionStatus, 'open' | 'archived'>, operation?: SessionStatusOperation): V3MutationResult;
/**
 * Enumerate every canonical session/3.0 session.json under .workflow/sessions/.
 * Read-only: no lock acquisition, no recovery writes, no projection writes.
 * Non-v3 and unreadable entries are skipped so a listing never fails the batch.
 */
export declare function listV3Sessions(store: SessionStore): SessionStateV30[];
/**
 * Enumerate every non-session/3.0 session.json under .workflow/sessions/ as a
 * batch migration candidate. Read-only: no lock acquisition, no writes.
 * Unreadable or path-mismatched entries are skipped so a batch migration never
 * fails on a corrupt sibling; every readable entry whose schema_version is not
 * session/3.0 is returned and its individual migration attempt may still fail
 * and be recorded per-session by the caller.
 */
export declare function listLegacyV3MigrationCandidates(store: SessionStore): Array<{
    session_id: string;
    source_schema_version: string;
}>;
//# sourceMappingURL=v3-cli-shared.d.ts.map