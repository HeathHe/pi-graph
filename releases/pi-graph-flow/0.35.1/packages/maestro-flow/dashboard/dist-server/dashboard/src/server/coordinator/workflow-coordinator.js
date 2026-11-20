// ---------------------------------------------------------------------------
// WorkflowCoordinator -- multi-agent orchestration via GraphWalker
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QualityReviewerAgent } from './agents/quality-reviewer-agent.js';
import { GraphWalkerFactory } from './graph-walker-factory.js';
import { WalkerEventBridge } from './walker-event-bridge.js';
import { DashboardStepAnalyzer } from './dashboard-step-analyzer.js';
// ---------------------------------------------------------------------------
// WorkflowCoordinator
// ---------------------------------------------------------------------------
export class WorkflowCoordinator {
    eventBus;
    agentManager;
    stateManager;
    workflowRoot;
    session = null;
    qualityReviewer;
    // GraphWalker factory and lazily initialized components
    factory;
    graphWalker = null;
    graphWalkerInitPromise = null;
    constructor(eventBus, agentManager, stateManager, workflowRoot) {
        this.eventBus = eventBus;
        this.agentManager = agentManager;
        this.stateManager = stateManager;
        this.workflowRoot = workflowRoot;
        this.factory = new GraphWalkerFactory();
        this.qualityReviewer = new QualityReviewerAgent();
    }
    // Lazy initialization — only created on first use
    async getGraphWalker() {
        if (this.graphWalker)
            return this.graphWalker;
        if (!this.graphWalkerInitPromise) {
            const sessionDir = join(this.workflowRoot, '.workflow', '.maestro');
            this.graphWalkerInitPromise = this.factory.create({
                agentManager: this.agentManager,
                eventBus: this.eventBus,
                workDir: this.workflowRoot,
                emitter: new WalkerEventBridge('coordinate', this.eventBus),
                analyzer: new DashboardStepAnalyzer(this.qualityReviewer),
                sessionDir,
            });
        }
        this.graphWalker = await this.graphWalkerInitPromise;
        return this.graphWalker;
    }
    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    async start(intent, opts) {
        if (this.session?.status === 'running') {
            throw new Error('A coordinate session is already running. Stop it first or wait for completion.');
        }
        return this.startViaGraphWalker(intent, opts);
    }
    async stop() {
        if (this.graphWalker) {
            await this.stopViaGraphWalker();
            return;
        }
        if (!this.session)
            return;
        this.session.status = 'failed';
        this.emitStatus();
        await this.persistState();
    }
    async resume(sessionId) {
        return this.resumeViaGraphWalker(sessionId);
    }
    async clarify(_sessionId, _response) {
        // Clarification is handled via gate:waiting → WalkerEventBridge in graph walker path.
        // This stub preserves the API for routes/WS handlers that still reference it.
    }
    getSession() {
        return this.session ? { ...this.session, steps: this.session.steps.map(s => ({ ...s })) } : null;
    }
    destroy() {
        // No-op — graph walker manages its own lifecycle
    }
    // -------------------------------------------------------------------------
    // GraphWalker bridge methods
    // -------------------------------------------------------------------------
    async startViaGraphWalker(intent, opts) {
        const gw = await this.getGraphWalker();
        const graphId = opts?.chainName
            ? opts.chainName
            : gw.router.resolve(intent);
        const sessionId = `coord-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        this.session = {
            sessionId,
            status: 'running',
            intent,
            chainName: graphId,
            tool: opts?.tool ?? 'claude',
            autoMode: opts?.autoMode ?? false,
            currentStep: 0,
            steps: [],
            avgQuality: null,
        };
        this.emitStatus();
        await this.persistState();
        // Run walker in background — session returned immediately, UI gets step events via emitter
        void this.runGraphWalker(gw, graphId, intent, opts);
        return this.session;
    }
    async runGraphWalker(gw, graphId, intent, opts) {
        try {
            const walkerState = await gw.walker.start(graphId, intent, {
                tool: opts?.tool ?? 'claude',
                autoMode: opts?.autoMode ?? false,
                workflowRoot: this.workflowRoot,
                inputs: {
                    phase: opts?.phase ?? '',
                    description: intent,
                },
            });
            if (!this.session)
                return;
            // Sync final WalkerState -> CoordinateSession
            this.syncWalkerToSession(walkerState);
            this.emitStatus();
            await this.persistState();
        }
        catch (err) {
            if (!this.session)
                return;
            const message = err instanceof Error ? err.message : String(err);
            this.session.status = 'failed';
            this.eventBus.emit('coordinate:error', {
                error: message,
                context: 'graph_walker',
                step: this.session.currentStep,
                timestamp: Date.now(),
            });
            this.emitStatus();
            await this.persistState();
        }
    }
    /** Convert WalkerState history -> CoordinateSession steps */
    syncWalkerToSession(walkerState) {
        if (!this.session)
            return;
        this.session.steps = walkerState.history
            .filter(h => h.node_type === 'command')
            .map((h, i) => ({
            index: i,
            cmd: h.node_id,
            args: '',
            status: h.outcome === 'success' ? 'completed'
                : h.outcome === 'failure' ? 'failed'
                    : 'skipped',
            processId: h.exec_id ?? null,
            analysis: null,
            summary: h.summary ?? null,
            qualityScore: h.quality_score ?? null,
            startedAt: h.entered_at,
            completedAt: h.exited_at,
        }));
        this.session.status = walkerState.status === 'completed' ? 'completed'
            : walkerState.status === 'failed' ? 'failed'
                : 'paused';
    }
    async stopViaGraphWalker() {
        const gw = await this.getGraphWalker();
        await gw.walker.stop();
        if (this.session) {
            this.session.status = 'failed';
            this.emitStatus();
            await this.persistState();
        }
    }
    async resumeViaGraphWalker(sessionId) {
        const gw = await this.getGraphWalker();
        try {
            // Resume runs the walker to completion — returns final state
            const walkerState = await gw.walker.resume(sessionId);
            this.session = {
                sessionId: walkerState.session_id,
                status: 'running',
                intent: walkerState.intent,
                chainName: walkerState.graph_id,
                tool: walkerState.tool,
                autoMode: walkerState.auto_mode,
                currentStep: 0,
                steps: [],
                avgQuality: null,
            };
            this.syncWalkerToSession(walkerState);
            this.emitStatus();
            await this.persistState();
            return this.session;
        }
        catch {
            return null;
        }
    }
    // -------------------------------------------------------------------------
    // State persistence
    // -------------------------------------------------------------------------
    get sessionDir() {
        if (!this.session)
            throw new Error('No active session');
        return join(this.workflowRoot, '.workflow', '.maestro', this.session.sessionId);
    }
    async persistState() {
        if (!this.session)
            return;
        try {
            const dir = this.sessionDir;
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'state.json'), JSON.stringify(this.session, null, 2), 'utf-8');
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[WorkflowCoordinator] Failed to persist state: ${message}`);
        }
    }
    async loadState(sessionId) {
        try {
            let stateDir;
            if (sessionId) {
                stateDir = join(this.workflowRoot, '.workflow', '.maestro', sessionId);
            }
            else if (this.session) {
                stateDir = this.sessionDir;
            }
            else {
                return null;
            }
            const raw = await readFile(join(stateDir, 'state.json'), 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    // -------------------------------------------------------------------------
    // Event emission
    // -------------------------------------------------------------------------
    emitStatus() {
        if (!this.session)
            return;
        this.eventBus.emit('coordinate:status', { session: this.session });
    }
}
//# sourceMappingURL=workflow-coordinator.js.map