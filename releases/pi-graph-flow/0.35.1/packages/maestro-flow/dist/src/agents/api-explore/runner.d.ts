/**
 * Parallel explore runner.
 *
 * Execution model: parallel by default, both across endpoints and within
 * the same endpoint. Each endpoint gets its own queue; a queue is throttled
 * only when a limit is configured.
 *
 * Per-queue limit resolution: `endpointConcurrency` option (CLI override)
 * > endpoint config `concurrency` > unlimited.
 */
import { type LlmConfig } from './llm.js';
import { type StreamEvent } from './stream-json-emitter.js';
import type { ResolvedMoaPreset } from './config.js';
import { EndpointCircuitBreaker, type CircuitBreakerConfig, type NamedEndpointRef } from './circuit-breaker.js';
export interface ExploreJob {
    id: string;
    prompt: string;
    endpointName: string;
    llmConfig: LlmConfig;
    /** Per-endpoint maxTurns override */
    maxTurns?: number;
    /** Per-endpoint max concurrent jobs (unset = unlimited) */
    concurrency?: number;
}
export interface ExploreResult {
    id: string;
    prompt: string;
    endpointName: string;
    model: string;
    content: string | null;
    error?: string;
    durationMs: number;
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
    /** Detailed call trace (messages, tool calls, truncated tool results) — persisted in session JSON */
    trace?: StreamEvent[];
}
export interface RunnerOptions {
    jobs: ExploreJob[];
    cwd: string;
    maxTurns: number;
    /** Max concurrent endpoint queues (default: number of distinct endpoints) */
    concurrency: number;
    /** Explicit max concurrent jobs within the same endpoint (overrides endpoint config; default: unlimited) */
    endpointConcurrency?: number;
    /** Repository tree depth injected into the first prompt (default: 3, range: 1-6) */
    treeDepth?: number;
    /** When set, route each job through MOA instead of a single-endpoint agentLoop */
    moaPreset?: ResolvedMoaPreset;
    /** Circuit breaker config for endpoint failover */
    circuitBreaker?: CircuitBreakerConfig;
    /** All available endpoints for fallback routing */
    allEndpoints?: NamedEndpointRef[];
    onProgress?: (msg: string) => void;
    onJobStart?: (job: ExploreJob) => void;
    onJobDone?: (result: ExploreResult) => void;
}
type EndpointProbe = (config: LlmConfig, timeoutMs?: number) => Promise<boolean>;
/**
 * Half-open recovery sweep used only when no healthy endpoint remains.
 * Persisted trips keep the fast path cheap, but cannot strand explore forever.
 */
export declare function recoverTrippedEndpoints(breaker: EndpointCircuitBreaker, endpoints: NamedEndpointRef[], probe?: EndpointProbe, timeoutMs?: number): Promise<string[]>;
/**
 * Run explore jobs: serial within same endpoint, parallel across endpoints.
 */
export declare function runExploreJobs(opts: RunnerOptions): Promise<ExploreResult[]>;
export interface PromptEntry {
    prompt: string;
    endpoint?: string;
}
type NamedEndpoint = {
    name: string;
    llmConfig: LlmConfig;
    maxTurns?: number;
    concurrency?: number;
};
/**
 * Build job list from prompt entries. Default: 1 prompt = 1 agent (first endpoint).
 * Per-prompt `endpoint` field overrides the global endpoint selection.
 */
export declare function buildJobsFromEntries(entries: PromptEntry[], globalEndpoints: NamedEndpoint[], allEndpoints: NamedEndpoint[]): ExploreJob[];
/**
 * Build job list from prompts × endpoints cartesian product.
 * Used when --all flag fans one prompt to every endpoint.
 */
export declare function buildJobs(prompts: string[], endpoints: NamedEndpoint[]): ExploreJob[];
export {};
//# sourceMappingURL=runner.d.ts.map