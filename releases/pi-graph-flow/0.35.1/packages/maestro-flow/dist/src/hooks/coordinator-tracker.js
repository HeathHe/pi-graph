/**
 * Coordinator Tracker — Unified progress tracking for maestro coordinators
 *
 * Tracks session state across three coordinator types:
 *   A) canonical — reads .workflow/sessions/{id}/session.json for every engine
 *      maestro (legacy) — reads .workflow/.maestro/status.json
 *   B) maestro-link-coordinate — captures coord session_id from Bash output,
 *      reads .workflow/.maestro/walker-state.json
 *
 * Bridge file: {tmpdir}/maestro-coord-{cc_session_id}.json
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { COORD_BRIDGE_PREFIX } from './constants.js';
/**
 * Read the most recent canonical/legacy maestro session.
 * Checks standard `.workflow/sessions/` first (all engines),
 * then falls back to legacy `.workflow/.maestro/` (maestro static chain).
 */
export function readMaestroSession(workspaceRoot) {
    // 1. Try canonical Sessions (engine=manual|coordinator|ralph)
    const standardResult = readStandardSession(workspaceRoot);
    // 2. Try legacy .maestro/ sessions
    const legacyResult = readLegacyMaestroSession(workspaceRoot);
    if (!standardResult && !legacyResult)
        return null;
    if (!standardResult)
        return legacyResult;
    if (!legacyResult)
        return standardResult;
    return standardResult.updated_at >= legacyResult.updated_at ? standardResult : legacyResult;
}
function readStandardSession(workspaceRoot) {
    const sessionsDir = join(workspaceRoot, '.workflow', 'sessions');
    if (!existsSync(sessionsDir))
        return null;
    try {
        const sessions = readdirSync(sessionsDir)
            .map(name => {
            const sessionPath = join(sessionsDir, name, 'session.json');
            if (!existsSync(sessionPath))
                return null;
            try {
                return { name, mtime: statSync(sessionPath).mtimeMs, path: sessionPath };
            }
            catch {
                return null;
            }
        })
            .filter((s) => s !== null)
            .sort((a, b) => b.mtime - a.mtime);
        for (const s of sessions) {
            try {
                const raw = JSON.parse(readFileSync(s.path, 'utf8'));
                if (!raw.orchestration?.engine)
                    continue;
                if (raw.status !== 'running' && raw.status !== 'paused')
                    continue;
                return parseStandardSession(raw, s.mtime, s.name, workspaceRoot);
            }
            catch { /* skip corrupt */ }
        }
        return null;
    }
    catch {
        return null;
    }
}
function parseStandardSession(raw, mtime, dirName, workspaceRoot) {
    const chain = raw.orchestration?.chain ?? [];
    const completed = chain.filter(s => s.status === 'completed' || s.status === 'sealed' || s.status === 'skipped').length;
    const realSteps = chain.filter(s => !s.decision_ref);
    const realCompleted = realSteps.filter(s => s.status === 'completed' || s.status === 'sealed' || s.status === 'skipped').length;
    const runningIdx = chain.findIndex(s => s.status === 'running');
    const pendingIdx = chain.findIndex(s => s.status === 'pending');
    const currentIdx = runningIdx >= 0 ? runningIdx : pendingIdx;
    const decisionPending = currentIdx >= 0 && !!chain[currentIdx].decision_ref &&
        (chain[currentIdx].status === 'running' || chain[currentIdx].status === 'pending');
    const currentStep = currentIdx >= 0
        ? { index: currentIdx, skill: chain[currentIdx].command ?? '', args: '' }
        : null;
    const nextIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
    const nextStep = chain[nextIdx]
        ? { index: nextIdx, skill: chain[nextIdx].command ?? '', args: '' }
        : null;
    const remaining = chain.slice(nextIdx).map(s => ({
        skill: s.command ?? '',
        args: '',
    }));
    // Extended fields (lifecycle / phase / passed_gates): session/1.1 promoted them
    // into orchestration.position, so prefer it. When a session predates migration
    // (1.0, no position block) fall back to the legacy ralph-meta.json read. The
    // existsSync guard keeps the fallback a graceful degradation.
    let lifecyclePosition;
    let phase = null;
    let passedGates;
    const position = raw.orchestration?.position;
    if (position) {
        lifecyclePosition = position.lifecycle;
        phase = position.phase ?? null;
        passedGates = position.passed_gates;
    }
    else {
        try {
            const metaPath = join(workspaceRoot, '.workflow', 'sessions', dirName, 'ralph-meta.json');
            if (existsSync(metaPath)) {
                const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
                lifecyclePosition = meta.lifecycle_position;
                phase = meta.phase ?? null;
                passedGates = meta.passed_gates;
            }
        }
        catch { /* ignore */ }
    }
    return {
        session_id: '',
        maestro_session_id: raw.session_id ?? dirName,
        coordinator: raw.orchestration?.engine === 'ralph' ? 'ralph' : 'maestro',
        source: raw.orchestration?.engine === 'ralph' ? 'ralph' : 'maestro',
        chain_name: '',
        intent: raw.intent ?? '',
        phase,
        steps_total: chain.length,
        steps_completed: completed,
        steps_real: realSteps.length,
        steps_real_completed: realCompleted,
        current_step: currentStep,
        next_step: nextStep,
        remaining_steps: remaining,
        status: raw.status ?? 'unknown',
        auto_mode: raw.orchestration?.auto_mode ?? false,
        lifecycle_position: lifecyclePosition,
        quality_mode: raw.orchestration?.quality_mode,
        decision_pending: decisionPending || undefined,
        passed_gates: passedGates,
        updated_at: Math.floor(mtime),
    };
}
function readLegacyMaestroSession(workspaceRoot) {
    const maestroDir = join(workspaceRoot, '.workflow', '.maestro');
    if (!existsSync(maestroDir))
        return null;
    try {
        const sessions = readdirSync(maestroDir)
            .map(name => {
            const statusPath = join(maestroDir, name, 'status.json');
            if (!existsSync(statusPath))
                return null;
            try {
                return { name, mtime: statSync(statusPath).mtimeMs, path: statusPath };
            }
            catch {
                return null;
            }
        })
            .filter((s) => s !== null)
            .sort((a, b) => b.mtime - a.mtime);
        if (sessions.length === 0)
            return null;
        const raw = JSON.parse(readFileSync(sessions[0].path, 'utf8'));
        return parseMaestroStatus(raw, sessions[0].mtime, sessions[0].name);
    }
    catch {
        return null;
    }
}
function parseMaestroStatus(raw, mtime, dirName) {
    const steps = raw.steps ?? [];
    const currentIdx = raw.current_step ?? 0;
    // All steps count (includes decision nodes)
    const completed = steps.filter(s => s.status === 'completed').length;
    // Real step counts — exclude decision nodes for accurate progress
    const realSteps = steps.filter(s => s.type !== 'decision');
    const realCompleted = realSteps.filter(s => s.status === 'completed').length;
    // Detect decision pending state
    const currentStepRaw = steps[currentIdx];
    const decisionPending = currentStepRaw?.type === 'decision' &&
        (currentStepRaw.status === 'running' || currentStepRaw.status === 'pending');
    const currentStep = currentStepRaw
        ? { index: currentIdx, skill: currentStepRaw.skill ?? '', args: currentStepRaw.args ?? '' }
        : null;
    const nextIdx = currentIdx + 1;
    const nextStep = steps[nextIdx]
        ? { index: nextIdx, skill: steps[nextIdx].skill ?? '', args: steps[nextIdx].args ?? '' }
        : null;
    const remaining = steps.slice(nextIdx).map(s => ({
        skill: s.skill ?? '',
        args: s.args ?? '',
    }));
    return {
        session_id: '',
        maestro_session_id: raw.session_id ?? dirName ?? undefined,
        coordinator: raw.source === 'ralph' ? 'ralph' : 'maestro',
        source: raw.source,
        chain_name: raw.chain_name ?? '',
        intent: raw.intent ?? '',
        phase: raw.phase ?? null,
        steps_total: steps.length,
        steps_completed: completed,
        steps_real: realSteps.length,
        steps_real_completed: realCompleted,
        current_step: currentStep,
        next_step: nextStep,
        remaining_steps: remaining,
        status: raw.status ?? 'unknown',
        auto_mode: raw.auto_mode ?? false,
        lifecycle_position: raw.lifecycle_position ?? undefined,
        quality_mode: raw.quality_mode ?? undefined,
        decision_pending: decisionPending || undefined,
        passed_gates: raw.passed_gates ?? undefined,
        updated_at: Math.floor(mtime),
    };
}
// ---------------------------------------------------------------------------
// B: Parse coordinate CLI output (maestro-link-coordinate)
// ---------------------------------------------------------------------------
/**
 * Parse Bash tool output for coordinate session JSON.
 * Looks for JSON containing "session_id":"coord-..." pattern.
 * Returns parsed output or null if not coordinate output.
 */
export function parseCoordinateOutput(toolOutput) {
    if (!toolOutput || !toolOutput.includes('"session_id"'))
        return null;
    // Find JSON object in output (may be preceded by stderr lines)
    const jsonStart = toolOutput.indexOf('{');
    if (jsonStart < 0)
        return null;
    try {
        const parsed = JSON.parse(toolOutput.slice(jsonStart));
        if (typeof parsed.session_id !== 'string' || !parsed.session_id.startsWith('coord-')) {
            return null;
        }
        return {
            session_id: parsed.session_id,
            status: parsed.status ?? 'unknown',
            graph_id: parsed.graph_id ?? '',
            current_node: parsed.current_node ?? '',
            steps_completed: parsed.steps_completed ?? 0,
            steps_failed: parsed.steps_failed ?? 0,
            history: Array.isArray(parsed.history) ? parsed.history : [],
        };
    }
    catch {
        return null;
    }
}
/**
 * Read walker-state.json for a specific coordinate session.
 * Resolves next node from the chain graph.
 */
export function readWalkerState(workspaceRoot, coordSessionId) {
    const coordDir = join(workspaceRoot, '.workflow', '.maestro');
    const statePath = join(coordDir, coordSessionId, 'walker-state.json');
    if (!existsSync(statePath))
        return null;
    try {
        const raw = JSON.parse(readFileSync(statePath, 'utf8'));
        const history = Array.isArray(raw.history) ? raw.history : [];
        const commandNodes = history.filter(h => h.node_type === 'command');
        const completed = commandNodes.filter(h => h.outcome === 'success').length;
        // Count total command nodes in graph to estimate steps_total
        const graphId = raw.graph_id ?? '';
        const currentNode = raw.current_node ?? '';
        // Resolve next step from chain graph
        const nextNode = resolveNextNode(workspaceRoot, graphId, currentNode);
        return {
            session_id: '',
            coord_session_id: coordSessionId,
            coordinator: 'maestro-link-coordinate',
            chain_name: graphId,
            intent: raw.intent ?? '',
            phase: raw.context?.project?.current_phase ?? null,
            steps_total: countGraphCommands(workspaceRoot, graphId),
            steps_completed: completed,
            current_step: currentNode ? { index: completed, skill: currentNode, args: '' } : null,
            next_step: nextNode ? { index: completed + 1, skill: nextNode.skill, args: nextNode.args } : null,
            remaining_steps: nextNode ? [{ skill: nextNode.skill, args: nextNode.args }] : [],
            status: raw.status ?? 'unknown',
            auto_mode: raw.auto_mode ?? false,
            updated_at: Math.floor(statSync(statePath).mtimeMs),
        };
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Chain graph resolution
// ---------------------------------------------------------------------------
/**
 * Resolve the next command node from a chain graph JSON file.
 * Follows `node.next` edges, skipping decision/gate/eval nodes.
 */
export function resolveNextNode(workspaceRoot, graphId, currentNode) {
    const graph = loadChainGraph(workspaceRoot, graphId);
    if (!graph)
        return null;
    const node = graph.nodes?.[currentNode];
    if (!node)
        return null;
    // Follow next edge, skip non-command nodes
    let nextId = node.next;
    for (let i = 0; i < 10 && nextId; i++) {
        const next = graph.nodes?.[nextId];
        if (!next)
            break;
        if (next.type === 'command') {
            return { skill: next.cmd ?? nextId, args: next.args ?? '' };
        }
        // Decision/gate/eval/terminal — try following default edge
        if (next.type === 'decision' && Array.isArray(next.edges)) {
            const defaultEdge = next.edges.find((e) => e.default);
            nextId = defaultEdge?.target ?? next.edges[0]?.target;
        }
        else if (next.type === 'terminal') {
            break;
        }
        else {
            nextId = next.next;
        }
    }
    return null;
}
/** Count total command nodes in a chain graph. */
function countGraphCommands(workspaceRoot, graphId) {
    const graph = loadChainGraph(workspaceRoot, graphId);
    if (!graph?.nodes)
        return 0;
    return Object.values(graph.nodes).filter(n => n.type === 'command').length;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadChainGraph(workspaceRoot, graphId) {
    if (!graphId)
        return null;
    // Try local chains/ first, then global ~/.maestro/chains/
    const localPath = join(workspaceRoot, 'chains', `${graphId}.json`);
    const globalPath = join(homedir(), '.maestro', 'chains', `${graphId}.json`);
    for (const p of [localPath, globalPath]) {
        if (existsSync(p)) {
            try {
                return JSON.parse(readFileSync(p, 'utf8'));
            }
            catch { /* skip */ }
        }
    }
    // Try singles/ subdirectory
    const localSingles = join(workspaceRoot, 'chains', 'singles', `${graphId}.json`);
    const globalSingles = join(homedir(), '.maestro', 'chains', 'singles', `${graphId}.json`);
    for (const p of [localSingles, globalSingles]) {
        if (existsSync(p)) {
            try {
                return JSON.parse(readFileSync(p, 'utf8'));
            }
            catch { /* skip */ }
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Bridge file I/O
// ---------------------------------------------------------------------------
function bridgePath(sessionId) {
    return join(tmpdir(), `${COORD_BRIDGE_PREFIX}${sessionId}.json`);
}
/** Write bridge file to tmpdir. */
export function writeCoordBridge(sessionId, data) {
    try {
        writeFileSync(bridgePath(sessionId), JSON.stringify(data));
    }
    catch {
        // Best-effort — bridge write must not break hook
    }
}
/** Read bridge file from tmpdir. Returns null if missing/corrupt. */
export function readCoordBridge(sessionId) {
    const p = bridgePath(sessionId);
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Latest session resolver
// ---------------------------------------------------------------------------
/**
 * Pick the most recently updated session across maestro and coordinate types.
 * Compares file mtime to determine which is newest.
 */
export function readLatestSession(workspaceRoot, existingBridge, 
/**
 * Already-computed `readMaestroSession` result, if the caller has one. Pass
 * `null` to say "computed, found nothing" — callers that check it first would
 * otherwise pay the whole session scan twice for the same answer. Omit to let
 * this function do the scan itself.
 */
maestroSession) {
    const maestro = maestroSession !== undefined ? maestroSession : readMaestroSession(workspaceRoot);
    const coord = readLatestCoordinateSession(workspaceRoot);
    const candidates = [maestro, coord, existingBridge ?? null].filter((c) => c !== null);
    if (candidates.length === 0)
        return null;
    return candidates.sort((a, b) => b.updated_at - a.updated_at)[0];
}
/** Find the latest walker-state.json across all coordinate sessions. */
function readLatestCoordinateSession(workspaceRoot) {
    const coordDir = join(workspaceRoot, '.workflow', '.maestro');
    if (!existsSync(coordDir))
        return null;
    try {
        const sessions = readdirSync(coordDir)
            .filter(name => name.startsWith('coord-'))
            .map(name => {
            // Try walker-state.json (link-coordinate) then status.json
            for (const file of ['walker-state.json', 'status.json']) {
                const statePath = join(coordDir, name, file);
                if (existsSync(statePath)) {
                    try {
                        return { name, mtime: statSync(statePath).mtimeMs, file };
                    }
                    catch { /* skip */ }
                }
            }
            return null;
        })
            .filter((s) => s !== null)
            .sort((a, b) => b.mtime - a.mtime);
        if (sessions.length === 0)
            return null;
        const latest = sessions[0];
        if (latest.file === 'walker-state.json') {
            return readWalkerState(workspaceRoot, latest.name);
        }
        // status.json uses same format as maestro status.json
        const raw = JSON.parse(readFileSync(join(coordDir, latest.name, 'status.json'), 'utf8'));
        return parseMaestroStatus(raw, latest.mtime, latest.name);
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Next-step hint builder
// ---------------------------------------------------------------------------
/**
 * Build a "next step" hint string for additionalContext injection.
 * Returns null if session is completed/failed or has no next step.
 */
export function buildNextStepHint(data) {
    const isPaused = data.status === 'paused' || data.status === 'step_paused';
    if (!isPaused && data.status !== 'running')
        return null;
    if (!data.next_step)
        return null;
    const progress = `[${data.steps_completed}/${data.steps_total}]`;
    const lastSkill = data.current_step?.skill ?? '(unknown)';
    const nextSkill = data.next_step.skill;
    const nextArgs = data.next_step.args ? ` ${data.next_step.args}` : '';
    const lines = [
        `## Coordinator Session Active`,
        `Chain: ${data.chain_name} ${progress} | Status: ${data.status}`,
        `Last: ${lastSkill}`,
        `Next: ${nextSkill}${nextArgs}`,
    ];
    if (data.remaining_steps.length > 1) {
        const remaining = data.remaining_steps.slice(1, 4).map(s => s.skill).join(' → ');
        lines.push(`Then: ${remaining}${data.remaining_steps.length > 4 ? ' …' : ''}`);
    }
    // Resume hint
    if (data.coord_session_id) {
        lines.push(`Resume: maestro coordinate -c ${data.coord_session_id}`);
    }
    else if (data.source === 'ralph') {
        lines.push(`Resume: /maestro-ralph -c`);
    }
    else {
        lines.push(`Resume: /maestro -c`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=coordinator-tracker.js.map