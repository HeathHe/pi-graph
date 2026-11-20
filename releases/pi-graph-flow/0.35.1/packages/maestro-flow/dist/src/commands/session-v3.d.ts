import type { Command } from 'commander';
import { SessionStore } from '../run/store.js';
import { type V3MutationResult } from '../run/v3/mutation-engine.js';
export interface OpenSessionV3Input {
    objective: string;
    sessionId: string;
    actorId: string;
    requestId: string;
    reason: string;
    evidence?: readonly string[];
    definitionOfDone?: string;
    chain?: readonly string[];
}
/**
 * Open a session/3.0 Session idempotently. Replays the original receipt when
 * the same request-id is retried against an existing Session. Shared by the
 * `maestro session open` CLI and the v3 plan-publish producer flow.
 */
export declare function openSessionV3(store: SessionStore, input: OpenSessionV3Input): V3MutationResult;
export declare function registerSessionV3Command(program: Command): void;
//# sourceMappingURL=session-v3.d.ts.map