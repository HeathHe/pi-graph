import { watch } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { SSE_EVENT_TYPES } from '../../shared/constants.js';
// ---------------------------------------------------------------------------
// FSWatcher — chokidar-based file watcher for .workflow/ directory
// ---------------------------------------------------------------------------
const REBUILD_DELAY_MS = 5_000;
export class FSWatcher {
    workflowRoot;
    stateManager;
    eventBus;
    debounceMs;
    watcher = null;
    rebuildTimer = null;
    /** Per-file debounce timers keyed by absolute path */
    debounceTimers = new Map();
    constructor(workflowRoot, stateManager, eventBus, debounceMs = 150) {
        this.workflowRoot = workflowRoot;
        this.stateManager = stateManager;
        this.eventBus = eventBus;
        this.debounceMs = debounceMs;
    }
    /** Start watching .workflow/ for relevant file changes */
    start() {
        if (this.watcher)
            return;
        const patterns = [
            `${this.workflowRoot}/state.json`,
            `${this.workflowRoot}/phases/*/index.json`,
            `${this.workflowRoot}/phases/*/.task/TASK-*.json`,
            `${this.workflowRoot}/phases/*/verification.json`,
            `${this.workflowRoot}/phases/*/validation.json`,
            `${this.workflowRoot}/phases/*/review.json`,
            `${this.workflowRoot}/phases/*/plan.json`,
            `${this.workflowRoot}/phases/*/uat.md`,
            `${this.workflowRoot}/scratch/*/index.json`,
            // Wiki index sources — unified /api/wiki endpoint
            `${this.workflowRoot}/project.md`,
            `${this.workflowRoot}/roadmap.md`,
            `${this.workflowRoot}/specs/*.md`,
            `${this.workflowRoot}/phases/*/*.md`,
            `${this.workflowRoot}/memory/*.md`,
            `${this.workflowRoot}/issues/*.jsonl`,
            `${this.workflowRoot}/knowhow/*.md`,
            // Collab — member profiles and activity log
            `${this.workflowRoot}/collab/members/*.json`,
            `${this.workflowRoot}/collab/activity.jsonl`,
            // CSV Wave — async delegate task execution tracking
            `${this.workflowRoot}/.csv-wave/**/*.csv`,
            // Maestro Coordinate — session status.json and walker-state.json
            `${this.workflowRoot}/.maestro/*/status.json`,
            `${this.workflowRoot}/.maestro/*/walker-state.json`,
        ];
        this.watcher = watch(patterns, {
            ignoreInitial: true,
            persistent: true,
            // Use polling on Windows as fallback for reliability
            usePolling: process.platform === 'win32',
            interval: 200,
        });
        this.watcher.on('add', (path) => this.handleChange(path));
        this.watcher.on('change', (path) => this.handleChange(path));
        this.watcher.on('unlink', (path) => this.handleChange(path));
        this.watcher.on('error', (error) => {
            console.error('FSWatcher error:', error);
            this.eventBus.emit(SSE_EVENT_TYPES.WATCHER_ERROR, String(error));
            this.scheduleFullRebuild();
        });
    }
    /** Stop watching and clean up */
    async stop() {
        // Clear all debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        if (this.rebuildTimer) {
            clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
    }
    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------
    handleChange(filePath) {
        // Per-file debounce: reset timer on each event for the same file
        const existing = this.debounceTimers.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.debounceTimers.delete(filePath);
            if (isWikiPath(filePath)) {
                this.eventBus.emit('wiki:invalidated', { at: Date.now(), path: filePath });
            }
            if (isMaestroSessionPath(filePath)) {
                this.emitMaestroSessionUpdate(filePath);
            }
            this.stateManager.applyFileChange(filePath).catch((err) => {
                console.error(`Failed to apply file change for ${filePath}:`, err);
                this.scheduleFullRebuild();
            });
        }, this.debounceMs);
        this.debounceTimers.set(filePath, timer);
    }
    // ---- Wiki-path detection -------------------------------------------------
    // Helper used inside debounced callback — see isWikiPath below.
    scheduleFullRebuild() {
        // Avoid stacking rebuild timers
        if (this.rebuildTimer)
            return;
        this.rebuildTimer = setTimeout(() => {
            this.rebuildTimer = null;
            this.stateManager.buildInitialState().catch((err) => {
                console.error('Full state rebuild failed:', err);
            });
        }, REBUILD_DELAY_MS);
    }
    /** Parse a maestro session file and emit WS push event */
    async emitMaestroSessionUpdate(filePath) {
        try {
            const raw = await readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);
            // Extract dirName from path: .../.maestro/{dirName}/status.json
            const normalized = filePath.replace(/\\/g, '/');
            const maestroIdx = normalized.indexOf('/.maestro/');
            if (maestroIdx < 0)
                return;
            const afterMaestro = normalized.slice(maestroIdx + '/.maestro/'.length);
            const dirName = afterMaestro.split('/')[0];
            if (!dirName)
                return;
            const steps = Array.isArray(data.steps) ? data.steps : [];
            const currentStep = typeof data.current_step === 'number' ? data.current_step : 0;
            // Detect source
            let source = 'maestro';
            if (data.source === 'ralph')
                source = 'ralph';
            else if (dirName.startsWith('coord-'))
                source = 'coordinate';
            this.eventBus.emit('maestro:session_updated', {
                session: {
                    dirName,
                    source,
                    sessionId: data.session_id ?? dirName,
                    intent: data.intent ?? '',
                    status: data.status ?? 'unknown',
                    chainName: data.chain_name ?? data.graph_id ?? null,
                    lifecyclePosition: source === 'ralph' ? data.lifecycle_position : undefined,
                    phase: data.phase ?? null,
                    milestone: data.milestone,
                    currentStep,
                    totalSteps: steps.length,
                    updatedAt: new Date().toISOString(),
                },
            });
        }
        catch {
            // Silently ignore parse errors — file may be mid-write
        }
    }
}
/**
 * Detect whether a changed file should invalidate the wiki index.
 * Covers project/roadmap root markdowns, specs, phase markdowns, memory,
 * and JSONL sources under issues/ and learning/.
 */
function isWikiPath(absPath) {
    const p = absPath.replace(/\\/g, '/');
    if (p.endsWith('/project.md') || p.endsWith('/roadmap.md'))
        return true;
    if (/\/specs\/[^/]+\.md$/.test(p))
        return true;
    if (/\/phases\/[^/]+\/[^/]+\.md$/.test(p))
        return true;
    if (/\/memory\/[^/]+\.md$/.test(p))
        return true;
    if (/\/issues\/[^/]+\.jsonl$/.test(p))
        return true;
    if (/\/knowhow\/[^/]+\.md$/.test(p))
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Maestro session file detection and event emission
// ---------------------------------------------------------------------------
function isMaestroSessionPath(absPath) {
    const p = absPath.replace(/\\/g, '/');
    return (/\/\.maestro\/[^/]+\/status\.json$/.test(p) ||
        /\/\.maestro\/[^/]+\/walker-state\.json$/.test(p));
}
//# sourceMappingURL=fs-watcher.js.map