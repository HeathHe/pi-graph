/**
 * Per-endpoint circuit breaker for explore jobs.
 *
 * Tracks consecutive failures per endpoint name. When failures reach
 * the configured threshold, the endpoint is marked "open" (tripped)
 * and remaining jobs are re-routed to a fallback endpoint.
 *
 * Supports time-based auto-recovery: tripped endpoints become eligible
 * for retry after `resetAfterMs` (default 1 hour). Persistent state
 * across runs via JSON file.
 */
import type { LlmConfig } from './llm.js';
export interface CircuitBreakerConfig {
    /** Consecutive failures before tripping (default 3) */
    threshold?: number;
    /** Preferred fallback endpoint names, tried in order */
    fallbackOrder?: string[];
    /** Ms before a tripped endpoint is retried (default 3600000 = 1h). 0 = no auto-reset. */
    resetAfterMs?: number;
    /** Timeout for each pre-flight/recovery probe (default 3000). */
    probeTimeoutMs?: number;
}
export interface NamedEndpointRef {
    name: string;
    llmConfig: LlmConfig;
    maxTurns?: number;
}
export declare class EndpointCircuitBreaker {
    private readonly threshold;
    private readonly fallbackOrder;
    private readonly resetAfterMs;
    private readonly states;
    private readonly onTrip?;
    private readonly statePath;
    private readonly now;
    constructor(config: CircuitBreakerConfig | undefined, opts?: {
        onTrip?: (endpointName: string, failures: number) => void;
        statePath?: string;
        now?: () => number;
    });
    private getState;
    private loadPersistedState;
    persistState(): void;
    recordSuccess(endpointName: string): void;
    /** Record a failure. Returns true if the endpoint just tripped. */
    recordFailure(endpointName: string): boolean;
    /** Force-trip an endpoint (e.g. after pre-flight probe failure). */
    trip(endpointName: string): void;
    /** Allow one model-level trial while retaining the previous trip for persistence. */
    allowHalfOpenTrial(endpointName: string): void;
    isOpen(endpointName: string): boolean;
    /**
     * Find a healthy fallback endpoint for a tripped one.
     * Tries fallbackOrder first, then any remaining healthy endpoint.
     */
    selectFallback(trippedName: string, allEndpoints: NamedEndpointRef[]): NamedEndpointRef | null;
    /** Return healthy fallback endpoints in configured priority order. */
    getFallbackCandidates(trippedName: string, allEndpoints: NamedEndpointRef[], excluded?: ReadonlySet<string>): NamedEndpointRef[];
    /** Summary of tripped endpoints for logging */
    getTrippedEndpoints(): string[];
}
//# sourceMappingURL=circuit-breaker.d.ts.map