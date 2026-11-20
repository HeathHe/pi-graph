// ---------------------------------------------------------------------------
// Session resolution shared by the免参 (run-id-less) run verbs. `run complete`
// without a run-id must locate the Run bound to the session's active chain step;
// this resolves the session the same way `run next` does — explicit --session >
// state.active_session_id > the unique running session that has a running chain
// step with a run_id — then returns that step's run_id.
//
// It deliberately mirrors (not imports) next.ts's resolveSession so the M3 next
// logic stays untouched. The distinction: next resolves on a *pending* step,
// complete resolves on a *running* step (the one awaiting completion).
// ---------------------------------------------------------------------------
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readStateJson } from '../utils/state-schema.js';
/** The single running chain step that has a bound run_id, or null. */
export function runningChainStep(session) {
    const chain = session.orchestration.chain;
    for (let i = 0; i < chain.length; i++) {
        const step = chain[i];
        if (step.status === 'running' && step.run_id) {
            return { index: i, step_id: step.step_id, command: step.command, run_id: step.run_id };
        }
    }
    return null;
}
function listRunningSessions(store) {
    const root = store.sessionsRoot;
    if (!existsSync(root))
        return [];
    const candidates = [];
    for (const name of readdirSync(root)) {
        try {
            if (!statSync(join(root, name)).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        if (!store.sessionExists(name))
            continue;
        try {
            const session = store.readBundle(name).session;
            if (session.status === 'running')
                candidates.push({ sessionId: name, session });
        }
        catch {
            /* skip corrupt */
        }
    }
    return candidates;
}
/**
 * Resolve the Run to complete when no run-id is supplied. Session resolution
 * order matches `run next`; within the session, the running chain step with a
 * run_id is the target. Errors list the candidates / point at passing a run-id.
 */
export function resolveRunningRun(projectRoot, store, sessionId, verb = 'run complete') {
    if (sessionId) {
        if (!store.sessionExists(sessionId)) {
            return { kind: 'error', message: `[${verb}] session not found: ${sessionId}` };
        }
        const session = store.readBundle(sessionId).session;
        const step = runningChainStep(session);
        if (!step) {
            return {
                kind: 'error',
                message: `[${verb}] session ${sessionId} has no running chain step; pass a run-id explicitly`,
            };
        }
        return { kind: 'ok', sessionId, session, step };
    }
    const state = readStateJson(projectRoot);
    const active = state?.active_session_id;
    if (active && store.sessionExists(active)) {
        try {
            const session = store.readBundle(active).session;
            const step = runningChainStep(session);
            if (session.status === 'running' && step) {
                return { kind: 'ok', sessionId: active, session, step };
            }
        }
        catch {
            /* fall through to scan */
        }
    }
    const running = listRunningSessions(store);
    const withRunning = running
        .map(c => ({ ...c, step: runningChainStep(c.session) }))
        .filter((c) => c.step !== null);
    if (withRunning.length === 1) {
        const only = withRunning[0];
        return { kind: 'ok', sessionId: only.sessionId, session: only.session, step: only.step };
    }
    if (withRunning.length === 0) {
        return {
            kind: 'error',
            message: `[${verb}] no running session with a running chain step; pass a run-id or --session <id>`,
        };
    }
    const list = withRunning.map(c => `  - ${c.sessionId} (${c.session.intent})`).join('\n');
    return {
        kind: 'error',
        message: `[${verb}] ambiguous: ${withRunning.length} running sessions have an active step. Pass --session <id>:\n${list}`,
    };
}
/**
 * Resolve the active Run (single-Run sessions without a chain step) when no
 * run-id is supplied. Falls back after resolveRunningRun for commands whose
 * no-arg form also covers single-Run sessions.
 */
export function resolveActiveRunTarget(store, sessionId, verb = 'run done') {
    if (sessionId) {
        if (!store.sessionExists(sessionId))
            throw new Error(`session not found: ${sessionId}`);
        const session = store.readBundle(sessionId).session;
        return session.active_run_id ? { sessionId, runId: session.active_run_id } : null;
    }
    const active = store.listSessions({ statuses: ['running'] }).candidates
        .filter(candidate => candidate.session.active_run_id)
        .map(candidate => ({ sessionId: candidate.sessionId, runId: candidate.session.active_run_id }));
    if (active.length === 1)
        return active[0];
    if (active.length > 1) {
        const list = active.map(candidate => `  - ${candidate.sessionId} (${candidate.runId})`).join('\n');
        throw new Error(`[${verb}] ambiguous: ${active.length} running Sessions have active Runs. Pass --session <id>:\n${list}`);
    }
    return null;
}
//# sourceMappingURL=resolve.js.map