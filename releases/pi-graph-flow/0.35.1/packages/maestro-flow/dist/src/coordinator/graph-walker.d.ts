import type { ChainGraph, WalkerState, CommandExecutor, PromptAssembler, ExprEvaluator, OutputParser, StepAnalyzer, WalkerEventEmitter, LLMDecider } from './graph-types.js';
import type { GraphLoader } from './graph-loader.js';
import type { ParallelCommandExecutor } from './parallel-executor.js';
import type { WorkflowHookRegistry } from '../hooks/workflow-hooks.js';
export interface StartOptions {
    tool: string;
    autoMode: boolean;
    dryRun?: boolean;
    stepMode?: boolean;
    workflowRoot: string;
    inputs?: Record<string, unknown>;
}
export declare class GraphWalker {
    private readonly loader;
    private readonly assembler;
    private readonly executor;
    private readonly analyzer;
    private readonly outputParser;
    private readonly evaluator;
    private readonly emitter?;
    private readonly sessionDir?;
    private readonly parallelExecutor?;
    private readonly llmDecider?;
    private readonly hooks?;
    private activeState;
    private saveFailures;
    constructor(loader: GraphLoader, assembler: PromptAssembler, executor: CommandExecutor, analyzer: StepAnalyzer | null, outputParser: OutputParser, evaluator: ExprEvaluator, emitter?: WalkerEventEmitter | undefined, sessionDir?: string | undefined, parallelExecutor?: ParallelCommandExecutor | undefined, llmDecider?: (LLMDecider | null) | undefined, hooks?: WorkflowHookRegistry | undefined);
    start(graphId: string, intent: string, options: StartOptions): Promise<WalkerState>;
    resume(sessionId?: string): Promise<WalkerState>;
    /** Load session state without executing — for status queries. */
    getState(sessionId?: string): WalkerState;
    /** Continue a step_paused session — execute next command node, then pause again. */
    next(sessionId?: string): Promise<WalkerState>;
    stop(): Promise<void>;
    walkGraph(state: WalkerState, graph: ChainGraph): Promise<WalkerState>;
    /**
     * Error barrier for the walk loop. An unhandled exception from a node
     * handler (executor spawn failure, assembler/analyzer throw, broken output
     * parser) must not leave the session stuck in `running`/`waiting_command`
     * with no persisted failure state. Record the failure, persist it, emit an
     * error event, and notify the onError hook so callers observe a clean
     * `failed` session instead of an unhandled rejection.
     */
    private handleWalkFailure;
    private walk;
    private handleCommand;
    private handleDecision;
    private askLLMDecider;
    private buildDecisionPrompt;
    private filterContextByKeys;
    private handleGate;
    private handleEval;
    private handleFork;
    private handleJoin;
    private handleTerminal;
    private countCommandNodes;
    private countCommandsBefore;
    private findPreviousCommand;
    private setContextValue;
    private resolveTemplate;
    private buildInitialContext;
    private reportPathFor;
    private clearNodeReport;
    private loadNodeResult;
    private save;
    private loadState;
    private dryRunWalk;
    private emit;
    private ensureRecovery;
    private resolveRetryPolicy;
    private executeWithRetry;
    private shouldAutoContinue;
    private buildFailureSummary;
}
//# sourceMappingURL=graph-walker.d.ts.map