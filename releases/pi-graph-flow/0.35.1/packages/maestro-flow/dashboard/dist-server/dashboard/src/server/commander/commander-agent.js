// ---------------------------------------------------------------------------
// CommanderAgent — tick loop + assess + decide + dispatch
// ---------------------------------------------------------------------------
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_COMMANDER_CONFIG } from '../../shared/commander-types.js';
import { CommanderStrategy } from '../execution/strategies/commander-strategy.js';
import { loadCommanderConfig, PROFILES } from './commander-config.js';
import { COMMANDER_SYSTEM_PROMPT, COMMANDER_OUTPUT_SCHEMA, buildAssessmentPrompt, } from './commander-prompts.js';
// ---------------------------------------------------------------------------
// JSONL reader (local helper, same pattern as execution-scheduler)
// ---------------------------------------------------------------------------
async function readIssuesJsonl(filePath) {
    let raw;
    try {
        raw = await readFile(filePath, 'utf-8');
    }
    catch {
        return [];
    }
    const issues = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            issues.push(JSON.parse(trimmed));
        }
        catch {
            // skip malformed lines
        }
    }
    return issues;
}
// ---------------------------------------------------------------------------
// Risk level ordering for threshold comparison
// ---------------------------------------------------------------------------
const RISK_ORDER = { low: 0, medium: 1, high: 2 };
function isWithinThreshold(actionRisk, threshold) {
    return (RISK_ORDER[actionRisk] ?? 2) <= (RISK_ORDER[threshold] ?? 0);
}
// ---------------------------------------------------------------------------
// CommanderAgent
// ---------------------------------------------------------------------------
export class CommanderAgent {
    eventBus;
    stateManager;
    executionScheduler;
    agentManager;
    workflowRoot;
    config;
    state;
    recentDecisions = [];
    consecutiveFailures = 0;
    ticksThisHour = 0;
    hourResetTimer = null;
    previousStrategyName = null;
    constructor(eventBus, stateManager, executionScheduler, agentManager, workflowRoot, config) {
        this.eventBus = eventBus;
        this.stateManager = stateManager;
        this.executionScheduler = executionScheduler;
        this.agentManager = agentManager;
        this.workflowRoot = workflowRoot;
        this.config = { ...DEFAULT_COMMANDER_CONFIG, ...config };
        this.state = {
            status: 'idle',
            lastTickAt: '',
            lastDecision: null,
            activeWorkers: 0,
            sessionId: randomUUID(),
            tickCount: 0,
        };
    }
    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    /** Start the Commander — registers CommanderStrategy with the scheduler. */
    async start() {
        if (this.previousStrategyName !== null)
            return; // already started
        // Load config from disk layers (user + project + env)
        const diskConfig = await loadCommanderConfig(this.workflowRoot);
        this.config = { ...diskConfig, ...this.config };
        // Save current strategy so we can revert on stop()
        this.previousStrategyName = this.executionScheduler.getActiveStrategyName();
        // Register and activate commander strategy
        const commanderStrategy = new CommanderStrategy(this);
        this.executionScheduler.registerStrategy(commanderStrategy);
        this.executionScheduler.setStrategy('commander');
        // Signal that Commander manages dispatch, disable tick-based auto-dispatch
        this.executionScheduler.isCommanderActive = true;
        this.executionScheduler.disableAutoDispatch();
        // Hourly tick counter reset
        this.hourResetTimer = setInterval(() => {
            this.ticksThisHour = 0;
        }, 3_600_000);
        this.emitStatus();
        this.eventBus.emit('commander:config', this.config);
        console.log(`[Commander] Started (model=${this.config.decisionModel}, workers=${this.config.maxConcurrentWorkers})`);
    }
    /** Stop the Commander — reverts scheduler to previous strategy. */
    stop() {
        // Revert to previous strategy
        if (this.previousStrategyName !== null) {
            try {
                this.executionScheduler.setStrategy(this.previousStrategyName);
            }
            catch {
                // Previous strategy may have been unregistered; fall back to priority
                try {
                    this.executionScheduler.setStrategy('priority');
                }
                catch {
                    // ignore — at least we tried
                }
            }
            this.previousStrategyName = null;
        }
        // Release commander dispatch control
        this.executionScheduler.isCommanderActive = false;
        if (this.hourResetTimer) {
            clearInterval(this.hourResetTimer);
            this.hourResetTimer = null;
        }
        this.state.status = 'idle';
        this.emitStatus();
        console.log('[Commander] Stopped');
    }
    /** Pause — keep timer running but skip ticks. */
    pause() {
        this.state.status = 'paused';
        this.emitStatus();
        console.log('[Commander] Paused');
    }
    /** Resume from paused state. */
    resume() {
        if (this.state.status !== 'paused')
            return;
        this.state.status = 'idle';
        this.consecutiveFailures = 0;
        this.emitStatus();
        console.log('[Commander] Resumed');
    }
    /** Update config at runtime. */
    updateConfig(partial) {
        const prevProfile = this.config.profile;
        // If switching profiles, apply profile preset first
        if (partial.profile && partial.profile !== prevProfile && partial.profile !== 'custom') {
            const profilePreset = PROFILES[partial.profile];
            if (profilePreset) {
                Object.assign(this.config, profilePreset);
            }
        }
        // Apply explicit overrides
        Object.assign(this.config, partial);
        this.emitStatus();
        this.eventBus.emit('commander:config', this.config);
    }
    /** Get current state snapshot. */
    getState() {
        return { ...this.state };
    }
    /** Get current config snapshot. */
    getConfig() {
        return { ...this.config };
    }
    // -------------------------------------------------------------------------
    // Core tick loop
    // -------------------------------------------------------------------------
    /**
     * Single tick of the Commander loop:
     *   1. Gather context
     *   2. Assess (Agent SDK query, read-only)
     *   3. Decide (deterministic filtering)
     *   4. Dispatch (execute approved actions)
     *   5. Emit events
     */
    async tick(trigger = 'scheduled_tick') {
        // Skip if paused
        if (this.state.status === 'paused')
            return;
        // Circuit breaker: too many consecutive failures
        if (this.consecutiveFailures >= this.config.safety.circuitBreakerThreshold) {
            console.warn(`[Commander] Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures. Pausing.`);
            this.pause();
            return;
        }
        // Rate limit: max ticks per hour
        if (this.ticksThisHour >= this.config.safety.maxTicksPerHour) {
            console.warn('[Commander] Max ticks per hour reached, skipping tick');
            return;
        }
        this.ticksThisHour++;
        this.state.tickCount++;
        this.state.lastTickAt = new Date().toISOString();
        const tickStart = Date.now();
        // --- Step 1: Gather context ---
        const context = await this.gatherContext();
        // --- Step 2: Assess (Agent SDK query) ---
        let assessment;
        let assessMetrics;
        this.state.status = 'thinking';
        this.emitStatus();
        const assessStart = Date.now();
        try {
            const result = await this.assess(context);
            assessment = result.assessment;
            assessMetrics = result.metrics;
            this.consecutiveFailures = 0;
            // Emit SDK token/latency metrics
            this.eventBus.emit('commander:assess_metrics', assessMetrics);
        }
        catch (err) {
            this.consecutiveFailures++;
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[Commander] Assessment failed (${this.consecutiveFailures}x):`, message);
            this.eventBus.emit('commander:error', {
                error: message,
                context: 'assess',
                timestamp: Date.now(),
            });
            this.state.status = 'idle';
            this.emitStatus();
            return;
        }
        const assessDurationMs = Date.now() - assessStart;
        // --- Step 3: Decide (deterministic, no LLM) ---
        const decideStart = Date.now();
        const decision = this.decide(trigger, assessment, context);
        const decideDurationMs = Date.now() - decideStart;
        // Attach timing metrics
        decision.metrics = {
            assessDurationMs,
            decideDurationMs,
            totalDurationMs: Date.now() - tickStart,
        };
        // Attach SDK assess metrics
        decision.assessMetrics = assessMetrics;
        // --- Step 4: Dispatch ---
        this.state.status = 'dispatching';
        this.emitStatus();
        await this.dispatch(decision);
        // --- Step 5: Emit events + update state ---
        this.state.lastDecision = decision;
        this.state.status = 'idle';
        // Keep last 5 decisions
        this.recentDecisions.push(decision);
        if (this.recentDecisions.length > 5) {
            this.recentDecisions.shift();
        }
        // Persist decision to JSONL
        await this.persistDecision(decision);
        this.emitStatus();
        this.eventBus.emit('execution:scheduler_status', this.executionScheduler.getStatus());
    }
    // -------------------------------------------------------------------------
    // Step 1: Gather context
    // -------------------------------------------------------------------------
    async gatherContext() {
        const project = this.stateManager.getProject();
        const schedulerStatus = this.executionScheduler.getStatus();
        // Read open issues from JSONL
        const { resolveIssuesJsonlPath: resolveJsonl } = await import('../utils/issue-store.js');
        const jsonlPath = await resolveJsonl(this.workflowRoot);
        const allIssues = await readIssuesJsonl(jsonlPath);
        const openIssues = allIssues.filter((i) => i.status === 'open');
        // Get current phase card
        const currentPhase = project.current_phase
            ? this.stateManager.getPhase(project.current_phase)
            : undefined;
        return {
            project,
            openIssues,
            runningWorkers: schedulerStatus.running.length,
            maxWorkers: this.config.maxConcurrentWorkers,
            recentDecisions: this.recentDecisions.slice(-5),
            currentPhase,
            workDir: this.workflowRoot,
        };
    }
    // -------------------------------------------------------------------------
    // Step 2: Assess (Agent SDK query, read-only)
    // -------------------------------------------------------------------------
    async assess(context) {
        const prompt = buildAssessmentPrompt(context);
        let resultText = '';
        let inputTokens = 0;
        let outputTokens = 0;
        const start = Date.now();
        for await (const message of query({
            prompt,
            options: {
                tools: ['Read', 'Glob', 'Grep'],
                allowedTools: ['Read', 'Glob', 'Grep'],
                permissionMode: 'dontAsk',
                systemPrompt: COMMANDER_SYSTEM_PROMPT,
                model: this.config.decisionModel,
                outputFormat: COMMANDER_OUTPUT_SCHEMA,
                cwd: this.workflowRoot,
                maxTurns: this.config.assessMaxTurns,
                persistSession: false,
            },
        })) {
            // Extract result from the success message
            const msg = message;
            if (msg.type === 'result' && msg.subtype === 'success') {
                const successMsg = message;
                resultText = successMsg.result;
                // Extract token usage from SDK response if available
                const usage = successMsg.usage;
                if (usage) {
                    inputTokens = usage.input_tokens ?? 0;
                    outputTokens = usage.output_tokens ?? 0;
                }
            }
        }
        const latencyMs = Date.now() - start;
        if (!resultText) {
            throw new Error('Assessment returned no result');
        }
        const metrics = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            latency_ms: latencyMs,
        };
        return { assessment: JSON.parse(resultText), metrics };
    }
    // -------------------------------------------------------------------------
    // Step 3: Decide (deterministic — no LLM)
    // -------------------------------------------------------------------------
    decide(trigger, assessment, context) {
        const availableSlots = context.maxWorkers - context.runningWorkers;
        // Filter actions by risk threshold
        const withinThreshold = assessment.priority_actions.filter((a) => isWithinThreshold(a.risk, this.config.autoApproveThreshold));
        const aboveThreshold = assessment.priority_actions.filter((a) => !isWithinThreshold(a.risk, this.config.autoApproveThreshold));
        // Sort approved actions by priority (execute_issue first, then by risk ascending)
        const priorityOrder = {
            execute_issue: 0,
            analyze_issue: 1,
            plan_issue: 2,
            flag_blocker: 3,
            create_issue: 4,
            advance_phase: 5,
        };
        withinThreshold.sort((a, b) => {
            const typeDiff = (priorityOrder[a.type] ?? 9) - (priorityOrder[b.type] ?? 9);
            if (typeDiff !== 0)
                return typeDiff;
            return (RISK_ORDER[a.risk] ?? 2) - (RISK_ORDER[b.risk] ?? 2);
        });
        // Limit to available worker capacity (only execute_issue consumes a slot)
        const actions = [];
        const deferred = [...aboveThreshold];
        let slotsUsed = 0;
        for (const action of withinThreshold) {
            if (action.type === 'execute_issue') {
                if (slotsUsed < availableSlots) {
                    actions.push(action);
                    slotsUsed++;
                }
                else {
                    deferred.push(action);
                }
            }
            else {
                // Non-execution actions (flag_blocker, create_issue, advance_phase)
                // don't consume worker slots
                actions.push(action);
            }
        }
        const decision = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            trigger,
            assessment,
            actions,
            deferred,
        };
        this.eventBus.emit('commander:decision', decision);
        return decision;
    }
    // -------------------------------------------------------------------------
    // Step 4: Dispatch
    // -------------------------------------------------------------------------
    async dispatch(decision) {
        for (const action of decision.actions) {
            try {
                switch (action.type) {
                    case 'execute_issue':
                        await this.executionScheduler.executeIssue(action.target, action.executor);
                        break;
                    case 'analyze_issue':
                        // Use AgentManager for lightweight analysis (don't occupy Scheduler slots)
                        await this.agentManager.spawn(action.executor, {
                            type: action.executor,
                            prompt: `Analyze issue ${action.target}: Run /maestro-analyze --gaps ${action.target} to perform root cause analysis and write the analysis record back to the issue.`,
                            workDir: this.workflowRoot,
                            approvalMode: 'auto',
                        });
                        console.log(`[Commander] Dispatched analyze_issue: ${action.target}`);
                        break;
                    case 'plan_issue':
                        await this.agentManager.spawn(action.executor, {
                            type: action.executor,
                            prompt: `Plan solution for issue ${action.target}: Run /maestro-plan --gaps to generate TASK files linked to the issue via task_refs.`,
                            workDir: this.workflowRoot,
                            approvalMode: 'auto',
                        });
                        console.log(`[Commander] Dispatched plan_issue: ${action.target}`);
                        break;
                    case 'flag_blocker':
                        console.log(`[Commander] Blocker flagged: ${action.target} — ${action.reason}`);
                        break;
                    case 'create_issue': {
                        const { generateIssueId, appendIssueJsonl, withIssueWriteLock, resolveIssuesJsonlPath } = await import('../utils/issue-store.js');
                        const issueJsonlPath = await resolveIssuesJsonlPath(this.workflowRoot);
                        const now = new Date().toISOString();
                        const issue = {
                            id: generateIssueId(),
                            title: action.target,
                            description: action.reason,
                            type: 'task',
                            priority: action.risk === 'high' ? 'high' : action.risk === 'medium' ? 'medium' : 'low',
                            status: 'open',
                            created_at: now,
                            updated_at: now,
                        };
                        await withIssueWriteLock(() => appendIssueJsonl(issueJsonlPath, issue));
                        console.log(`[Commander] Created issue ${issue.id}: ${action.target}`);
                        break;
                    }
                    case 'advance_phase': {
                        this.eventBus.emit('commander:decision', {
                            id: randomUUID(),
                            timestamp: new Date().toISOString(),
                            trigger: 'advance_phase_recommendation',
                            assessment: decision.assessment,
                            actions: [action],
                            deferred: [],
                            metrics: { assessDurationMs: 0, decideDurationMs: 0, totalDurationMs: 0 },
                        });
                        console.log(`[Commander] Phase advancement recommended: ${action.target} — ${action.reason}`);
                        break;
                    }
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[Commander] Dispatch failed for ${action.type}:${action.target}:`, message);
            }
        }
        this.state.activeWorkers = this.executionScheduler.getStatus().running.length;
    }
    // -------------------------------------------------------------------------
    // Decision persistence — append to JSONL file
    // -------------------------------------------------------------------------
    async persistDecision(decision) {
        try {
            const dir = join(this.workflowRoot, '.commander');
            await mkdir(dir, { recursive: true });
            const filePath = join(dir, 'decisions.jsonl');
            await appendFile(filePath, JSON.stringify(decision) + '\n', 'utf-8');
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[Commander] Failed to persist decision: ${message}`);
        }
    }
    // -------------------------------------------------------------------------
    // Event emission
    // -------------------------------------------------------------------------
    emitStatus() {
        this.eventBus.emit('execution:scheduler_status', this.executionScheduler.getStatus());
        this.eventBus.emit('commander:status', this.state);
    }
}
//# sourceMappingURL=commander-agent.js.map