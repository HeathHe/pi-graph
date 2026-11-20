import type { AgentType } from './agent-types.js';
import type { WorkspacePolicy } from './execution-types.js';
export interface CommanderSafetyConfig {
    /** Event debounce interval (ms) */
    eventDebounceMs: number;
    /** Auto-pause after N consecutive failures */
    circuitBreakerThreshold: number;
    /** Max ticks per hour (prevent runaway loops) */
    maxTicksPerHour: number;
    /** Max token budget per hour */
    maxTokensPerHour: number;
    /** File globs that Commander must not operate on */
    protectedPaths: string[];
}
export interface CommanderConfig {
    /** Tick interval (ms). Lower = more aggressive */
    pollIntervalMs: number;
    /** Maximum concurrent worker agents */
    maxConcurrentWorkers: number;
    /** Worker timeout (ms), marks stalled after this */
    stallTimeoutMs: number;
    /** Max retries per issue */
    maxRetries: number;
    /** Retry backoff interval (ms) */
    retryBackoffMs: number;
    /** Model used for assessment queries */
    decisionModel: 'haiku' | 'sonnet' | 'opus';
    /** Max exploration turns for assessment */
    assessMaxTurns: number;
    /** Auto-approve risk threshold: low=only low risk, medium=incl medium, high=fully auto */
    autoApproveThreshold: 'low' | 'medium' | 'high';
    /** Default executor agent type */
    defaultExecutor: AgentType;
    safety: CommanderSafetyConfig;
    workspace: WorkspacePolicy;
    /** Preset environment profile, overrides specific fields */
    profile: 'development' | 'staging' | 'production' | 'custom';
}
export interface CommanderState {
    status: 'idle' | 'thinking' | 'dispatching' | 'paused';
    lastTickAt: string;
    lastDecision: Decision | null;
    activeWorkers: number;
    sessionId: string;
    tickCount: number;
}
export interface PriorityAction {
    type: 'execute_issue' | 'analyze_issue' | 'plan_issue' | 'create_issue' | 'advance_phase' | 'flag_blocker';
    /** Target identifier (ISS-xxx or phase-slug) */
    target: string;
    reason: string;
    risk: 'low' | 'medium' | 'high';
    /** Executor agent type identifier */
    executor: string;
}
export interface Assessment {
    priority_actions: PriorityAction[];
    observations: string[];
    risks: string[];
}
export interface DecisionMetrics {
    assessDurationMs: number;
    decideDurationMs: number;
    totalDurationMs: number;
}
export interface AssessMetrics {
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
}
export interface Decision {
    id: string;
    timestamp: string;
    /** What triggered this decision (scheduled_tick, issue:created, etc.) */
    trigger: string;
    assessment: Assessment;
    /** Actions approved by threshold + capacity filter */
    actions: PriorityAction[];
    /** Actions blocked by capacity or threshold */
    deferred: PriorityAction[];
    /** Timing metrics for observability */
    metrics?: DecisionMetrics;
    /** Agent SDK token/latency metrics from the assess() call */
    assessMetrics?: AssessMetrics;
}
export declare const DEFAULT_COMMANDER_CONFIG: CommanderConfig;
