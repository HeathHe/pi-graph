import { loadDashboardAgentSettings } from '../../config.js';
import { readIssuesJsonl, writeIssuesJsonl, withIssueWriteLock, resolveIssuesJsonlPath } from '../../utils/issue-store.js';
// ---------------------------------------------------------------------------
// ExecutionWsHandler — execute:issue, execute:batch, execute:wave,
//                      supervisor:toggle, issue:analyze, issue:plan
// ---------------------------------------------------------------------------
export class ExecutionWsHandler {
    executionScheduler;
    waveExecutor;
    agentManager;
    eventBus;
    workflowRoot;
    agentHandler;
    actions = [
        'execute:issue',
        'execute:batch',
        'execute:wave',
        'supervisor:toggle',
        'issue:analyze',
        'issue:plan',
        'issue:pipeline',
    ];
    constructor(executionScheduler, waveExecutor, agentManager, eventBus, workflowRoot, agentHandler) {
        this.executionScheduler = executionScheduler;
        this.waveExecutor = waveExecutor;
        this.agentManager = agentManager;
        this.eventBus = eventBus;
        this.workflowRoot = workflowRoot;
        this.agentHandler = agentHandler;
    }
    async handle(action, data, ws, _broadcast) {
        const msg = data;
        switch (action) {
            case 'execute:issue':
                await this.executionScheduler.executeIssue(msg.issueId, msg.executor);
                break;
            case 'execute:batch':
                await this.executionScheduler.executeBatch(msg.issueIds, msg.executor, msg.maxConcurrency);
                break;
            case 'execute:wave':
                await this.handleWaveExecute(ws, msg.issueId);
                break;
            case 'supervisor:toggle':
                if (msg.config) {
                    this.executionScheduler.updateConfig(msg.config);
                }
                if (msg.enabled === true) {
                    this.executionScheduler.startSupervisor();
                }
                else if (msg.enabled === false) {
                    this.executionScheduler.stopSupervisor();
                }
                break;
            case 'issue:analyze':
                if (!msg.issueId) {
                    throw new Error('Missing issueId');
                }
                await this.handleIssueAnalyze(ws, msg.issueId, msg.tool, msg.depth);
                break;
            case 'issue:plan':
                if (!msg.issueId) {
                    throw new Error('Missing issueId');
                }
                await this.handleIssuePlan(ws, msg.issueId, msg.tool);
                break;
            case 'issue:pipeline':
                if (!msg.issueId) {
                    throw new Error('Missing issueId');
                }
                await this.handleIssuePipeline(msg.issueId, msg.tool);
                break;
        }
    }
    async handleWaveExecute(ws, issueId) {
        if (!issueId) {
            throw new Error('Missing issueId');
        }
        const jsonlPath = await resolveIssuesJsonlPath(this.workflowRoot);
        const issues = await readIssuesJsonl(jsonlPath);
        const issue = issues.find((i) => i.id === issueId);
        if (!issue) {
            throw new Error(`Issue not found: ${issueId}`);
        }
        await this.waveExecutor.execute(issue);
    }
    async handleIssuePipeline(issueId, tool) {
        const jsonlPath = await resolveIssuesJsonlPath(this.workflowRoot);
        // Read issue and derive chain mode from current state
        const issues = await readIssuesJsonl(jsonlPath);
        const issue = issues.find((i) => i.id === issueId);
        if (!issue) {
            throw new Error(`Issue not found: ${issueId}`);
        }
        const mode = resolveChainMode(issue);
        // Write chain config into solution (create stub if absent)
        await withIssueWriteLock(async () => {
            const freshIssues = await readIssuesJsonl(jsonlPath);
            const idx = freshIssues.findIndex((i) => i.id === issueId);
            if (idx === -1)
                return;
            const target = freshIssues[idx];
            target.solution = {
                steps: [],
                ...target.solution,
                chain: 'issue-lifecycle',
                chainMode: mode,
            };
            target.updated_at = new Date().toISOString();
            freshIssues[idx] = target;
            await writeIssuesJsonl(jsonlPath, freshIssues);
        });
        // Dispatch via existing executeIssue — it routes to dispatchViaChain when solution.chain is set
        const executor = tool || undefined;
        await this.executionScheduler.executeIssue(issueId, executor);
    }
    async handleIssueAnalyze(ws, issueId, tool, depth) {
        const resolvedTool = tool || 'gemini';
        const resolvedDepth = depth || 'standard';
        const prompt = `/maestro-analyze --gaps ${issueId}`;
        await this.buildIssuePromptAndSpawn(ws, issueId, () => prompt);
    }
    async handleIssuePlan(ws, issueId, tool) {
        const prompt = `/maestro-plan --gaps`;
        await this.buildIssuePromptAndSpawn(ws, issueId, () => prompt);
    }
    async buildIssuePromptAndSpawn(ws, issueId, buildPrompt) {
        const jsonlPath = await resolveIssuesJsonlPath(this.workflowRoot);
        const issues = await readIssuesJsonl(jsonlPath);
        const issue = issues.find((i) => i.id === issueId);
        if (!issue) {
            throw new Error(`Issue not found: ${issueId}`);
        }
        const savedSettings = await loadDashboardAgentSettings(this.workflowRoot, 'agent-sdk');
        const agentType = (savedSettings?.settingsFile || savedSettings?.baseUrl || savedSettings?.apiKey)
            ? 'agent-sdk'
            : 'claude-code';
        const prompt = buildPrompt(issue, agentType);
        await this.agentHandler.mergeSettingsAndSpawn(ws, {
            type: agentType,
            prompt,
            workDir: this.workflowRoot,
            approvalMode: 'auto',
        });
    }
}
function resolveChainMode(issue) {
    if (issue.solution && issue.solution.steps.length > 0)
        return 'direct';
    if (issue.analysis)
        return 'plan-execute';
    return 'full';
}
//# sourceMappingURL=execution-handler.js.map