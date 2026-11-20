import type { TargetPlatform } from '../core/skill-converter.js';
import { type CommandRun, type GoalBinding, type RunCheckpoint, type SessionState } from './schemas.js';
import { SessionStore, type SessionBundle } from './store.js';
export interface ResolvedRunContext {
    session_id: string;
    run_id: string;
    run_dir: string;
    chain_step_id: string | null;
    resolved_platform: TargetPlatform;
    command_source_hash: string;
    goal_binding: GoalBinding | null;
    checkpoint: RunCheckpoint | null;
}
export interface ResolvedRunContextFull extends ResolvedRunContext {
    run: CommandRun;
    bundle: SessionBundle;
    store: SessionStore;
}
export declare function resolveTargetPlatform(explicit: TargetPlatform | undefined, run: CommandRun | undefined, session: SessionState): TargetPlatform;
export declare function canonicalRunDir(store: SessionStore, sessionId: string, runId: string): string;
export declare function resolveRunContext(projectRoot: string, runId: string, sessionId?: string, platformOverride?: TargetPlatform): ResolvedRunContext;
export declare function resolveRunContextFull(projectRoot: string, runId: string, sessionId?: string, platformOverride?: TargetPlatform): ResolvedRunContextFull;
export interface ObserveGoalBindingInput {
    provider: string;
    external_id?: string | null;
    step_goal_ref?: string | null;
    observed_status: GoalBinding['observed_status'];
    observed_at?: string;
}
/** Store an external Goal observation. It never changes Run or Session status. */
export declare function observeGoalBinding(projectRoot: string, runId: string, input: ObserveGoalBindingInput, sessionId?: string): GoalBinding;
//# sourceMappingURL=context.d.ts.map