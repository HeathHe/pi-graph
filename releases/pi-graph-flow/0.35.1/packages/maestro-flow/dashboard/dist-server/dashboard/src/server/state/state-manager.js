import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { SSE_EVENT_TYPES } from '../../shared/constants.js';
import { readJsonSafe } from './file-reader.js';
import { toForwardSlash } from '../../shared/utils.js';
// ---------------------------------------------------------------------------
// StateManager — in-memory projection of .workflow/ directory
// ---------------------------------------------------------------------------
export class StateManager {
    workflowRoot;
    eventBus;
    board;
    /** Cache: phase number → directory path for O(1) lookups */
    phaseDirCache = new Map();
    isSwitching = false;
    constructor(workflowRoot, eventBus) {
        this.workflowRoot = workflowRoot;
        this.eventBus = eventBus;
        this.board = emptyBoard();
    }
    /** Return current workspace project root (parent of .workflow/) */
    getWorkspaceRoot() {
        return resolve(this.workflowRoot, '..');
    }
    /** Return current .workflow/ directory path (updates on workspace switch) */
    getWorkflowRoot() {
        return this.workflowRoot;
    }
    /** Return current board state snapshot */
    getBoard() {
        return this.board;
    }
    /** Return project state */
    getProject() {
        return this.board.project;
    }
    /** Return a specific phase by number, or undefined */
    getPhase(n) {
        return this.board.phases.find((p) => p.phase === n);
    }
    /** Return tasks for a given phase number */
    async getTasks(phaseNum) {
        // Use cached directory path if available
        const cached = this.phaseDirCache.get(phaseNum);
        if (cached)
            return readPhaseTasks(cached);
        const phaseDir = await findPhaseDir(this.workflowRoot, phaseNum);
        if (!phaseDir)
            return [];
        this.phaseDirCache.set(phaseNum, phaseDir);
        return readPhaseTasks(phaseDir);
    }
    // -------------------------------------------------------------------------
    // Full state build — scans the entire .workflow/ directory
    // -------------------------------------------------------------------------
    async buildInitialState() {
        const rawProject = await readJsonSafe(join(this.workflowRoot, 'state.json'));
        const phases = await this.readAllPhases();
        const scratch = await this.readAllScratch();
        this.board = {
            project: rawProject ? normalizeProject(rawProject) : emptyProject(),
            phases,
            scratch,
            lastUpdated: new Date().toISOString(),
        };
        this.eventBus.emit(SSE_EVENT_TYPES.BOARD_FULL, this.board);
        return this.board;
    }
    // -------------------------------------------------------------------------
    // Workspace switch — replace root, rebuild state, broadcast switch event
    // -------------------------------------------------------------------------
    get switching() {
        return this.isSwitching;
    }
    async resetForNewWorkspace(newRoot) {
        if (this.isSwitching) {
            throw new Error('Workspace switch already in progress.');
        }
        this.isSwitching = true;
        try {
            this.phaseDirCache.clear();
            this.workflowRoot = newRoot;
            await this.buildInitialState();
            this.eventBus.emit(SSE_EVENT_TYPES.WORKSPACE_SWITCHED, { workspace: resolve(newRoot, '..') });
        }
        finally {
            this.isSwitching = false;
        }
    }
    // -------------------------------------------------------------------------
    // Delta update — re-read a single changed file and emit event
    // -------------------------------------------------------------------------
    async applyFileChange(filePath) {
        const rel = toForwardSlash(relative(this.workflowRoot, filePath));
        // state.json — project-level change
        if (rel === 'state.json') {
            const rawProject = await readJsonSafe(filePath);
            if (rawProject) {
                this.board.project = normalizeProject(rawProject);
                this.board.lastUpdated = new Date().toISOString();
                this.eventBus.emit(SSE_EVENT_TYPES.PROJECT_UPDATED, this.board.project);
            }
            return;
        }
        // phases/<slug>/index.json — phase updated
        const phaseIndexMatch = rel.match(/^phases\/[^/]+\/index\.json$/);
        if (phaseIndexMatch) {
            const phase = await readJsonSafe(filePath);
            if (phase) {
                this.upsertPhase(phase);
                this.board.lastUpdated = new Date().toISOString();
                this.eventBus.emit(SSE_EVENT_TYPES.PHASE_UPDATED, phase);
            }
            return;
        }
        // phases/<slug>/.task/TASK-*.json — task updated
        const taskMatch = rel.match(/^phases\/[^/]+\/\.task\/TASK-.*\.json$/);
        if (taskMatch) {
            const task = await readJsonSafe(filePath);
            if (task) {
                this.board.lastUpdated = new Date().toISOString();
                this.eventBus.emit(SSE_EVENT_TYPES.TASK_UPDATED, task);
            }
            return;
        }
        // phases/<slug>/{verification,validation,review,plan}.json — phase sidecar updated
        // Re-read index.json from the same directory to pick up merged state
        const phaseSidecarMatch = rel.match(/^phases\/([^/]+)\/(?:verification|validation|review|plan|uat)\.(?:json|md)$/);
        if (phaseSidecarMatch) {
            const slug = phaseSidecarMatch[1];
            const indexPath = join(this.workflowRoot, 'phases', slug, 'index.json');
            const phase = await readJsonSafe(indexPath);
            if (phase) {
                this.upsertPhase(phase);
                this.board.lastUpdated = new Date().toISOString();
                this.eventBus.emit(SSE_EVENT_TYPES.PHASE_UPDATED, phase);
            }
            return;
        }
        // scratch/<slug>/index.json — scratch task updated
        const scratchMatch = rel.match(/^scratch\/[^/]+\/index\.json$/);
        if (scratchMatch) {
            const scratch = await readJsonSafe(filePath);
            if (scratch) {
                this.upsertScratch(scratch);
                this.board.lastUpdated = new Date().toISOString();
                this.eventBus.emit(SSE_EVENT_TYPES.SCRATCH_UPDATED, scratch);
            }
            return;
        }
        // collab/members/*.json — member profile updated
        const collabMemberMatch = rel.match(/^collab\/members\/[^/]+\.json$/);
        if (collabMemberMatch) {
            this.eventBus.emit(SSE_EVENT_TYPES.COLLAB_MEMBERS_UPDATED, { at: Date.now(), path: filePath });
            return;
        }
        // collab/activity.jsonl — activity log updated
        if (rel === 'collab/activity.jsonl') {
            this.eventBus.emit(SSE_EVENT_TYPES.COLLAB_ACTIVITY, { at: Date.now(), path: filePath });
            return;
        }
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    upsertPhase(phase) {
        phase = normalizePhase(phase);
        const idx = this.board.phases.findIndex((p) => p.phase === phase.phase);
        if (idx >= 0) {
            this.board.phases[idx] = phase;
        }
        else {
            this.board.phases.push(phase);
            this.board.phases.sort((a, b) => a.phase - b.phase);
        }
    }
    upsertScratch(card) {
        const idx = this.board.scratch.findIndex((s) => s.id === card.id);
        if (idx >= 0) {
            this.board.scratch[idx] = card;
        }
        else {
            this.board.scratch.push(card);
        }
    }
    async readAllPhases() {
        const phasesDir = join(this.workflowRoot, 'phases');
        const slugs = await safeReaddir(phasesDir);
        const phases = [];
        this.phaseDirCache.clear();
        const usedPhaseNums = new Set();
        let nextFallback = 1;
        for (const slug of slugs) {
            const dirPath = join(phasesDir, slug);
            const indexPath = join(dirPath, 'index.json');
            const phase = await readJsonSafe(indexPath);
            if (phase) {
                phases.push(normalizePhase(phase));
                this.phaseDirCache.set(phase.phase, dirPath);
                usedPhaseNums.add(phase.phase);
                if (phase.phase >= nextFallback)
                    nextFallback = phase.phase + 1;
            }
            else {
                // Advance fallback past any already-used numbers
                while (usedPhaseNums.has(nextFallback))
                    nextFallback++;
                const synth = await synthesizePhaseFromDir(slug, dirPath, nextFallback);
                if (synth) {
                    phases.push(normalizePhase(synth));
                    this.phaseDirCache.set(synth.phase, dirPath);
                    usedPhaseNums.add(synth.phase);
                    nextFallback = synth.phase + 1;
                }
            }
        }
        phases.sort((a, b) => a.phase - b.phase);
        return phases;
    }
    async readAllScratch() {
        const scratchDir = join(this.workflowRoot, 'scratch');
        const slugs = await safeReaddir(scratchDir);
        const cards = [];
        for (const slug of slugs) {
            const indexPath = join(scratchDir, slug, 'index.json');
            const card = await readJsonSafe(indexPath);
            if (card) {
                cards.push(card);
            }
        }
        return cards;
    }
}
// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------
async function findPhaseDir(workflowRoot, phaseNum) {
    const phasesDir = join(workflowRoot, 'phases');
    const slugs = await safeReaddir(phasesDir);
    for (const slug of slugs) {
        const indexPath = join(phasesDir, slug, 'index.json');
        const phase = await readJsonSafe(indexPath);
        if (phase && phase.phase === phaseNum) {
            return join(phasesDir, slug);
        }
    }
    return null;
}
async function readPhaseTasks(phaseDir) {
    // Primary: read from .task/ subdirectory
    const taskDir = join(phaseDir, '.task');
    let entries = await safeReaddirFiles(taskDir);
    let basePath = taskDir;
    // Fallback: read TASK-*.json directly from phase directory
    if (entries.filter((e) => e.startsWith('TASK-')).length === 0) {
        entries = await safeReaddirFiles(phaseDir);
        basePath = phaseDir;
    }
    const tasks = [];
    for (const entry of entries) {
        if (!entry.startsWith('TASK-') || !entry.endsWith('.json'))
            continue;
        const raw = await readJsonSafe(join(basePath, entry));
        if (raw) {
            tasks.push(normalizeTask(raw, entry));
        }
    }
    return tasks;
}
/** Synthesize a minimal PhaseCard from a directory without index.json */
async function synthesizePhaseFromDir(slug, dirPath, fallbackNum) {
    // Try to extract phase number from slug (e.g. "1", "01-auth")
    const leadingMatch = slug.match(/^(\d+)/);
    const phaseNum = leadingMatch ? parseInt(leadingMatch[1], 10) : (fallbackNum ?? 0);
    if (isNaN(phaseNum) || phaseNum <= 0)
        return null;
    // Count TASK-*.json files (in .task/ or directly in dir)
    const taskDirEntries = await safeReaddirFiles(join(dirPath, '.task'));
    const directEntries = await safeReaddirFiles(dirPath);
    const taskFiles = taskDirEntries.length > 0
        ? taskDirEntries.filter((e) => e.startsWith('TASK-') && e.endsWith('.json'))
        : directEntries.filter((e) => e.startsWith('TASK-') && e.endsWith('.json'));
    const taskIds = taskFiles.map((f) => f.replace('.json', ''));
    // Try to read plan.json for wave info
    const plan = await readJsonSafe(join(dirPath, 'plan.json'));
    const planWaves = plan && Array.isArray(plan.waves) ? plan.waves : [];
    return {
        phase: phaseNum,
        slug,
        title: slug.replace(/^(?:\d+|[a-zA-Z]+\d+)-?/, '').replace(/[-_]/g, ' ') || `Phase ${phaseNum}`,
        status: 'not_started',
        created_at: '',
        updated_at: '',
        goal: '',
        success_criteria: [],
        requirements: [],
        spec_ref: null,
        plan: { task_ids: taskIds, task_count: taskFiles.length, complexity: null, waves: planWaves },
        execution: { method: '', started_at: null, completed_at: null, tasks_completed: 0, tasks_total: taskFiles.length, current_wave: 0, commits: [] },
        verification: { status: 'pending', verified_at: null, must_haves: [], gaps: [] },
        validation: { status: 'pending', test_coverage: null, gaps: [] },
        uat: { status: 'pending', test_count: 0, passed: 0, gaps: [] },
        reflection: { rounds: 0, strategy_adjustments: [] },
    };
}
async function safeReaddir(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        return [];
    }
}
async function safeReaddirFiles(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
    }
    catch {
        return [];
    }
}
function emptyProject() {
    return {
        version: '1.0',
        project_name: '',
        current_milestone: '',
        current_phase: 0,
        status: 'idle',
        phases_summary: { total: 0, completed: 0, in_progress: 0, pending: 0 },
        last_updated: new Date().toISOString(),
        accumulated_context: { key_decisions: [], blockers: [], deferred: [] },
    };
}
/** Normalize a raw state.json into a valid ProjectState, handling variant schemas */
function normalizeProject(raw) {
    const defaults = emptyProject();
    const ps = (raw.phases_summary ?? {});
    const ac = (raw.accumulated_context ?? {});
    // Derive phases_summary from milestones + artifacts if not present in state.json
    let phasesSummary = {
        total: typeof ps.total === 'number' ? ps.total : defaults.phases_summary.total,
        completed: typeof ps.completed === 'number' ? ps.completed : defaults.phases_summary.completed,
        in_progress: typeof ps.in_progress === 'number' ? ps.in_progress : defaults.phases_summary.in_progress,
        pending: typeof ps.pending === 'number' ? ps.pending : defaults.phases_summary.pending,
    };
    if (typeof ps.total !== 'number' && Array.isArray(raw.milestones)) {
        const milestones = raw.milestones;
        const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
        let total = 0;
        let completed = 0;
        let inProgress = 0;
        let pending = 0;
        for (const m of milestones) {
            const phases = Array.isArray(m.phases) ? m.phases : [];
            for (const phaseNum of phases) {
                total++;
                // Check artifacts for this phase to determine status
                const phaseArtifacts = artifacts.filter(a => a.phase === phaseNum);
                const hasExecute = phaseArtifacts.some(a => a.type === 'execute' && a.status === 'completed');
                const hasVerify = phaseArtifacts.some(a => a.type === 'verify' && a.status === 'completed');
                const hasAnalyze = phaseArtifacts.some(a => a.type === 'analyze');
                const mStatus = String(m.status ?? 'pending');
                if (mStatus === 'completed' || hasVerify) {
                    completed++;
                }
                else if (hasExecute || hasAnalyze) {
                    inProgress++;
                }
                else {
                    pending++;
                }
            }
        }
        phasesSummary = { total, completed, in_progress: inProgress, pending };
    }
    // Map status variants: state.json uses 'active' but ProjectStatus expects 'planning'|'executing'|'verifying'|'idle'
    const rawStatus = typeof raw.status === 'string' ? raw.status : defaults.status;
    let mappedStatus = defaults.status;
    switch (rawStatus) {
        case 'active': {
            // Infer from latest artifact type
            const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
            const latestType = artifacts.length > 0 ? artifacts[artifacts.length - 1].type : null;
            if (latestType === 'execute')
                mappedStatus = 'executing';
            else if (latestType === 'verify')
                mappedStatus = 'verifying';
            else
                mappedStatus = 'planning';
            break;
        }
        case 'planning':
        case 'executing':
        case 'verifying':
        case 'idle':
            mappedStatus = rawStatus;
            break;
    }
    return {
        version: typeof raw.version === 'string' ? raw.version : defaults.version,
        project_name: typeof raw.project_name === 'string' ? raw.project_name
            : typeof raw.projectName === 'string' ? raw.projectName
                : typeof raw.project === 'string' ? raw.project
                    : defaults.project_name,
        current_milestone: typeof raw.current_milestone === 'string' ? raw.current_milestone : defaults.current_milestone,
        current_phase: typeof raw.current_phase === 'number' ? raw.current_phase
            : typeof raw.currentPhase === 'number' ? raw.currentPhase
                : defaults.current_phase,
        status: mappedStatus,
        phases_summary: phasesSummary,
        last_updated: typeof raw.last_updated === 'string' ? raw.last_updated
            : typeof raw.updatedAt === 'string' ? raw.updatedAt
                : defaults.last_updated,
        accumulated_context: {
            key_decisions: Array.isArray(ac.key_decisions) ? ac.key_decisions : defaults.accumulated_context.key_decisions,
            blockers: Array.isArray(ac.blockers) ? ac.blockers : defaults.accumulated_context.blockers,
            deferred: Array.isArray(ac.deferred) ? ac.deferred : defaults.accumulated_context.deferred,
        },
    };
}
function emptyBoard() {
    return {
        project: emptyProject(),
        phases: [],
        scratch: [],
        lastUpdated: new Date().toISOString(),
    };
}
/** Normalize a raw task JSON into a TaskCard — handles variant field names */
function normalizeTask(raw, filename) {
    // task_id (snake_case) → taskId (camelCase) → id → filename fallback
    const id = String(raw.taskId ?? raw.task_id ?? raw.id ?? filename.replace('.json', ''));
    const title = String(raw.title ?? '');
    const meta = raw.meta ?? {};
    // Status: check meta.status first, then top-level status, then default
    const status = String(meta.status ?? raw.status ?? 'pending');
    const wave = typeof meta.wave === 'number' ? meta.wave : typeof raw.wave === 'number' ? raw.wave : 0;
    const type = String(raw.type ?? raw.category ?? 'feature');
    return {
        id,
        title,
        description: String(raw.description ?? raw.summary ?? ''),
        type,
        priority: String(raw.priority ?? ''),
        effort: String(raw.effort ?? raw.estimate ?? ''),
        action: String(raw.action ?? ''),
        scope: String(raw.scope ?? ''),
        focus_paths: Array.isArray(raw.focus_paths) ? raw.focus_paths : [],
        depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : (Array.isArray(raw.dependsOn) ? raw.dependsOn : []),
        parallel_group: raw.parallel_group ?? null,
        convergence: raw.convergence ?? { criteria: [], verification: '', definition_of_done: '' },
        files: Array.isArray(raw.files) ? raw.files : [],
        implementation: Array.isArray(raw.implementation) ? raw.implementation : (Array.isArray(raw.implementationSteps) ? raw.implementationSteps : []),
        test: raw.test ?? { commands: [], unit: [], integration: [], success_metrics: [] },
        reference: raw.reference ?? { pattern: '', files: [], examples: null },
        rationale: raw.rationale ?? { chosen_approach: '', decision_factors: [], tradeoffs: null },
        risks: Array.isArray(raw.risks) ? raw.risks.map(String) : [],
        code_skeleton: raw.code_skeleton ?? null,
        doc_context: raw.doc_context ?? { affected_features: [], affected_components: [], affected_requirements: [], adr_ids: [] },
        meta: {
            status: status,
            estimated_time: meta.estimated_time ?? null,
            risk: String(meta.risk ?? ''),
            autonomous: Boolean(meta.autonomous ?? false),
            checkpoint: Boolean(meta.checkpoint ?? false),
            wave,
            execution_group: meta.execution_group ?? null,
            executor: String(meta.executor ?? ''),
        },
    };
}
/** Fill missing fields in PhaseCard so components never crash on partial data */
/** Coerce must_haves to string[] — may be string[], object, or missing */
function normalizeMustHaves(raw) {
    if (Array.isArray(raw))
        return raw.map(String);
    if (raw && typeof raw === 'object') {
        // Object form: { truths_total, truths_verified, ... } → summary string
        const obj = raw;
        const parts = [];
        if (typeof obj.truths_verified === 'number' && typeof obj.truths_total === 'number') {
            parts.push(`Truths: ${obj.truths_verified}/${obj.truths_total}`);
        }
        if (typeof obj.artifacts_verified === 'number' && typeof obj.artifacts_total === 'number') {
            parts.push(`Artifacts: ${obj.artifacts_verified}/${obj.artifacts_total}`);
        }
        if (typeof obj.key_links_wired === 'number' && typeof obj.key_links_total === 'number') {
            parts.push(`Links: ${obj.key_links_wired}/${obj.key_links_total}`);
        }
        return parts.length > 0 ? parts : [];
    }
    return [];
}
function normalizePhase(p) {
    const raw = p;
    const verification = raw.verification ?? {};
    const validation = raw.validation ?? {};
    const uat = raw.uat ?? {};
    const execution = raw.execution ?? {};
    return {
        ...p,
        goal: p.goal ?? '',
        success_criteria: p.success_criteria ?? [],
        requirements: p.requirements ?? [],
        spec_ref: p.spec_ref ?? null,
        plan: p.plan ?? { task_ids: [], task_count: 0, complexity: null, waves: [] },
        execution: {
            method: typeof execution.method === 'string' ? execution.method : '',
            started_at: execution.started_at ?? null,
            completed_at: execution.completed_at ?? null,
            tasks_completed: typeof execution.tasks_completed === 'number' ? execution.tasks_completed : 0,
            tasks_total: typeof execution.tasks_total === 'number' ? execution.tasks_total : 0,
            current_wave: typeof execution.current_wave === 'number' ? execution.current_wave : 0,
            commits: Array.isArray(execution.commits) ? execution.commits : [],
        },
        verification: {
            status: String(verification.status ?? 'pending'),
            verified_at: verification.verified_at ?? null,
            must_haves: normalizeMustHaves(verification.must_haves),
            gaps: Array.isArray(verification.gaps) ? verification.gaps : [],
        },
        validation: {
            status: String(validation.status ?? 'pending'),
            test_coverage: validation.test_coverage ?? null,
            gaps: Array.isArray(validation.gaps) ? validation.gaps : [],
        },
        uat: {
            status: String(uat.status ?? 'pending'),
            test_count: typeof uat.test_count === 'number' ? uat.test_count : 0,
            passed: typeof uat.passed === 'number' ? uat.passed : 0,
            gaps: Array.isArray(uat.gaps) ? uat.gaps : [],
        },
        reflection: {
            rounds: raw.reflection?.rounds ?? 0,
            strategy_adjustments: raw.reflection?.strategy_adjustments ?? [],
        },
    };
}
//# sourceMappingURL=state-manager.js.map