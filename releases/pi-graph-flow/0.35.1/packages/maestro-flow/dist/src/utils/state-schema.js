/**
 * state-schema.ts — Canonical state.json v2 types, derivation, migration, and I/O.
 *
 * Single source of truth for the `.workflow/state.json` schema.
 * All hooks, tools, and workflows should import from here.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Cross-platform atomic rename with bounded retry for Windows transient errors.
 * The committed destination is never unlinked before a successful promotion;
 * callers that need crash recovery must retain a durable transaction intent.
 */
export function safeRename(src, dest) {
    for (let i = 0; i < 3; i++) {
        try {
            renameSync(src, dest);
            return;
        }
        catch (e) {
            if (i < 2 && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code))
                continue;
            throw e;
        }
    }
}
/** Local-time ISO 8601 string with timezone offset, e.g. "2026-04-24T14:30:00+08:00" */
export function localISO() {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
// ---------------------------------------------------------------------------
// Derivation functions — replace stored current_phase / phases_summary
// ---------------------------------------------------------------------------
/**
 * Derive the "current phase" from artifact registry.
 * Priority: phase with in_progress artifact → first phase without completed execute.
 */
export function deriveCurrentPhase(state) {
    const milestone = state.milestones?.find(m => m.name === state.current_milestone || m.id === state.current_milestone);
    if (!milestone?.phases?.length)
        return null;
    // Phase with in_progress work → current
    for (const p of milestone.phases) {
        if (state.artifacts.some(a => a.phase === p
            && a.milestone === state.current_milestone
            && a.status === 'in_progress'))
            return p;
    }
    // First phase without completed execute
    for (const p of milestone.phases) {
        if (!state.artifacts.some(a => a.type === 'execute'
            && a.phase === p
            && a.milestone === state.current_milestone
            && a.status === 'completed'))
            return p;
    }
    return null; // all phases done
}
/**
 * Derive phases_summary from artifact registry.
 */
export function derivePhasesSummary(state) {
    const milestone = state.milestones?.find(m => m.name === state.current_milestone || m.id === state.current_milestone);
    if (!milestone?.phases?.length) {
        return { total: 0, completed: 0, in_progress: 0, pending: 0 };
    }
    const total = milestone.phases.length;
    let completed = 0;
    let in_progress = 0;
    for (const p of milestone.phases) {
        const arts = state.artifacts.filter(a => a.phase === p && a.milestone === state.current_milestone);
        if (arts.some(a => a.type === 'execute' && a.status === 'completed')) {
            completed++;
        }
        else if (arts.length > 0) {
            in_progress++;
        }
    }
    return { total, completed, in_progress, pending: total - completed - in_progress };
}
// ---------------------------------------------------------------------------
// Artifact ID generation
// ---------------------------------------------------------------------------
const TYPE_PREFIX = {
    analyze: 'ANL',
    plan: 'PLN',
    execute: 'EXC',
    verify: 'VRF',
    brainstorm: 'BST',
    spec: 'SPC',
    review: 'REV',
    debug: 'DBG',
    test: 'TST',
};
export function nextArtifactId(artifacts, type) {
    const prefix = TYPE_PREFIX[type];
    let max = 0;
    for (const a of artifacts) {
        if (!a.id.startsWith(prefix + '-'))
            continue;
        const n = parseInt(a.id.slice(prefix.length + 1), 10);
        if (n > max)
            max = n;
    }
    return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}
/**
 * Build artifact entries from legacy phases/ directory structure.
 * Scans .workflow/phases/{NN}-{slug}/ for analysis.md, plan.json, .summaries/, verification.json.
 */
function harvestLegacyPhaseArtifacts(workflowRoot, currentMilestone) {
    const phasesDir = join(workflowRoot, 'phases');
    if (!existsSync(phasesDir))
        return [];
    const entries = [];
    let idCounters = { ANL: 0, PLN: 0, EXC: 0, VRF: 0 };
    const now = localISO();
    let dirs;
    try {
        dirs = readdirSync(phasesDir);
    }
    catch {
        return [];
    }
    for (const d of dirs) {
        const match = d.match(/^(\d+)-(.+)$/);
        if (!match)
            continue;
        const phaseNum = parseInt(match[1], 10);
        const slug = match[2];
        const phaseDir = join(phasesDir, d);
        // Check what artifacts exist in this phase dir
        const hasAnalysis = existsSync(join(phaseDir, 'analysis.md'));
        const hasPlan = existsSync(join(phaseDir, 'plan.json'));
        const hasSummaries = existsSync(join(phaseDir, '.summaries'));
        const hasVerification = existsSync(join(phaseDir, 'verification.json'));
        // Legacy paths are relative to .workflow/
        const legacyPath = `phases/${d}`;
        if (hasAnalysis) {
            idCounters.ANL++;
            const anlId = `ANL-${String(idCounters.ANL).padStart(3, '0')}`;
            entries.push({
                id: anlId,
                type: 'analyze',
                milestone: currentMilestone,
                phase: phaseNum,
                scope: 'phase',
                path: legacyPath,
                status: 'completed',
                depends_on: null,
                harvested: true,
                created_at: now,
                completed_at: now,
            });
        }
        if (hasPlan) {
            idCounters.PLN++;
            const plnId = `PLN-${String(idCounters.PLN).padStart(3, '0')}`;
            const anlId = idCounters.ANL > 0 ? `ANL-${String(idCounters.ANL).padStart(3, '0')}` : null;
            entries.push({
                id: plnId,
                type: 'plan',
                milestone: currentMilestone,
                phase: phaseNum,
                scope: 'phase',
                path: legacyPath,
                status: 'completed',
                depends_on: anlId,
                harvested: hasSummaries,
                created_at: now,
                completed_at: now,
            });
        }
        if (hasSummaries) {
            idCounters.EXC++;
            const excId = `EXC-${String(idCounters.EXC).padStart(3, '0')}`;
            const plnId = idCounters.PLN > 0 ? `PLN-${String(idCounters.PLN).padStart(3, '0')}` : null;
            entries.push({
                id: excId,
                type: 'execute',
                milestone: currentMilestone,
                phase: phaseNum,
                scope: 'phase',
                path: legacyPath,
                status: 'completed',
                depends_on: plnId,
                harvested: true,
                created_at: now,
                completed_at: now,
            });
        }
        if (hasVerification) {
            idCounters.VRF++;
            const vrfId = `VRF-${String(idCounters.VRF).padStart(3, '0')}`;
            const excId = idCounters.EXC > 0 ? `EXC-${String(idCounters.EXC).padStart(3, '0')}` : null;
            entries.push({
                id: vrfId,
                type: 'verify',
                milestone: currentMilestone,
                phase: phaseNum,
                scope: 'phase',
                path: legacyPath,
                status: 'completed',
                depends_on: excId ? [excId] : null,
                harvested: true,
                created_at: now,
                completed_at: now,
            });
        }
    }
    return entries;
}
/**
 * Normalize v1 status string to v2 enum.
 */
function normalizeStatus(old) {
    if (!old)
        return 'idle';
    if (old === 'idle')
        return 'idle';
    if (old.includes('executing'))
        return 'executing';
    if (old === 'completed')
        return 'completed';
    if (old === 'active')
        return 'active';
    // "phase_N_pending", "verifying", etc → active
    return 'active';
}
/**
 * Migrate v1 state.json to v2. Optionally harvests legacy phases/ artifacts.
 */
export function migrateV1toV2(raw, workflowRoot) {
    const currentMilestone = raw.current_milestone ?? null;
    // Enrich milestones with id + status
    const milestones = (raw.milestones ?? []).map((m, i) => ({
        id: m.id ?? `M${i + 1}`,
        name: m.name,
        title: m.title ?? m.name,
        status: m.status
            ?? (m.name === currentMilestone ? 'active' : 'pending'),
        phases: m.phases ?? [],
    }));
    // Start with any existing artifacts from state.json
    let artifacts = Array.isArray(raw.artifacts) ? [...raw.artifacts] : [];
    // Harvest from legacy phases/ if workflowRoot provided and no artifacts exist yet
    if (artifacts.length === 0 && workflowRoot) {
        artifacts = harvestLegacyPhaseArtifacts(workflowRoot, currentMilestone);
    }
    return {
        // Preserve any unknown / forward-compatible fields from the raw state
        ...raw,
        version: '2.0',
        project_name: raw.project_name ?? null,
        status: normalizeStatus(raw.status),
        current_milestone: currentMilestone,
        current_task_id: raw.current_task_id ?? null,
        milestones,
        artifacts,
        accumulated_context: raw.accumulated_context ?? {
            key_decisions: [],
            blockers: [],
            deferred: [],
        },
        transition_history: (raw.transition_history ?? []),
        milestone_history: (raw.milestone_history ?? []),
        last_updated: raw.last_updated ?? localISO(),
    };
}
// ---------------------------------------------------------------------------
// I/O helpers — atomic read/write
// ---------------------------------------------------------------------------
/**
 * Check whether a version string represents a v2+ schema (forward-compatible).
 * Versions "2.0", "3.0", "3.1", "4.0", etc. are all considered modern.
 * Only versions below 2.0 (e.g. "1.0", undefined) need migration.
 */
function isModernVersion(version) {
    if (typeof version !== 'string')
        return false;
    const major = parseInt(version.split('.')[0], 10);
    return !Number.isNaN(major) && major >= 2;
}
/**
 * Read state.json from a workspace. Auto-migrates v1 to v2 in memory (does not write back).
 * Returns null if file doesn't exist.
 */
export function readStateJson(workflowRoot) {
    const statePath = join(workflowRoot, '.workflow', 'state.json');
    if (!existsSync(statePath))
        return null;
    try {
        const raw = JSON.parse(readFileSync(statePath, 'utf8'));
        if (isModernVersion(raw.version))
            return raw;
        // Auto-migrate v1
        return migrateV1toV2(raw, join(workflowRoot, '.workflow'));
    }
    catch {
        return null;
    }
}
/**
 * Write state.json atomically (write-tmp + rename).
 */
export function writeStateJson(workflowRoot, state) {
    const statePath = join(workflowRoot, '.workflow', 'state.json');
    const tmpPath = statePath + '.tmp';
    state.last_updated = localISO();
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    safeRename(tmpPath, statePath);
}
/**
 * Read, migrate if needed, and write back v2 state.json.
 * Returns the migrated state. Use this for one-shot migration.
 */
export function migrateStateFile(workflowRoot) {
    const statePath = join(workflowRoot, '.workflow', 'state.json');
    if (!existsSync(statePath))
        return null;
    let raw;
    try {
        raw = JSON.parse(readFileSync(statePath, 'utf8'));
    }
    catch {
        return null;
    }
    if (isModernVersion(raw.version))
        return raw;
    const v2 = migrateV1toV2(raw, join(workflowRoot, '.workflow'));
    writeStateJson(workflowRoot, v2);
    return v2;
}
// ---------------------------------------------------------------------------
// Canonical Session projection
// ---------------------------------------------------------------------------
/** Ensure state.json carries the canonical Session DAG projection. */
export function ensureSessionProjection(state, session, makeActive = true) {
    const sessions = [...(state.sessions ?? [])];
    const index = sessions.findIndex(entry => entry.session_id === session.session_id);
    if (index >= 0)
        sessions[index] = session;
    else
        sessions.push(session);
    return {
        ...state,
        sessions,
        active_session_id: makeActive ? session.session_id : (state.active_session_id ?? null),
        last_updated: localISO(),
    };
}
//# sourceMappingURL=state-schema.js.map