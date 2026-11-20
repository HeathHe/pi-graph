import { relative, sep } from 'node:path';
import { goalBindingSchema, targetPlatformSchema, } from './schemas.js';
import { SessionStore } from './store.js';
export function resolveTargetPlatform(explicit, run, session) {
    if (explicit)
        return targetPlatformSchema.parse(explicit);
    if (run)
        return run.resolved_platform;
    const executor = targetPlatformSchema.safeParse(session.orchestration.executor?.platform);
    return executor.success ? executor.data : 'claude';
}
export function canonicalRunDir(store, sessionId, runId) {
    return relative(store.projectRoot, store.runDir(sessionId, runId)).split(sep).join('/');
}
export function resolveRunContext(projectRoot, runId, sessionId, platformOverride) {
    const store = new SessionStore(projectRoot);
    const located = store.findRun(runId, sessionId);
    const session = store.readBundle(located.sessionId).session;
    const resolvedPlatform = resolveTargetPlatform(undefined, located.run, session);
    if (platformOverride && platformOverride !== resolvedPlatform) {
        throw new Error(`Run ${runId} is bound to platform "${resolvedPlatform}"; cannot re-attach as "${platformOverride}"`);
    }
    return {
        session_id: located.sessionId,
        run_id: runId,
        run_dir: canonicalRunDir(store, located.sessionId, runId),
        chain_step_id: located.run.chain_step_id,
        resolved_platform: resolvedPlatform,
        command_source_hash: located.run.command.resolved_prompt_hash,
        goal_binding: located.run.goal_binding,
        checkpoint: located.run.checkpoint,
    };
}
export function resolveRunContextFull(projectRoot, runId, sessionId, platformOverride) {
    const store = new SessionStore(projectRoot);
    const located = store.findRun(runId, sessionId);
    const bundle = store.readBundle(located.sessionId);
    const resolvedPlatform = resolveTargetPlatform(undefined, located.run, bundle.session);
    if (platformOverride && platformOverride !== resolvedPlatform) {
        throw new Error(`Run ${runId} is bound to platform "${resolvedPlatform}"; cannot re-attach as "${platformOverride}"`);
    }
    return {
        session_id: located.sessionId,
        run_id: runId,
        run_dir: canonicalRunDir(store, located.sessionId, runId),
        chain_step_id: located.run.chain_step_id,
        resolved_platform: resolvedPlatform,
        command_source_hash: located.run.command.resolved_prompt_hash,
        goal_binding: located.run.goal_binding,
        checkpoint: located.run.checkpoint,
        run: located.run,
        bundle,
        store,
    };
}
/** Store an external Goal observation. It never changes Run or Session status. */
export function observeGoalBinding(projectRoot, runId, input, sessionId) {
    const store = new SessionStore(projectRoot);
    const located = store.findRun(runId, sessionId);
    const binding = goalBindingSchema.parse({
        provider: input.provider,
        external_id: input.external_id ?? null,
        step_goal_ref: input.step_goal_ref ?? null,
        observed_status: input.observed_status,
        observed_at: input.observed_at ?? new Date().toISOString(),
    });
    return store.update(located.sessionId, (_bundle, tx) => {
        const run = tx.readRun(runId);
        run.goal_binding = binding;
        tx.writeRun(run);
        return binding;
    });
}
//# sourceMappingURL=context.js.map