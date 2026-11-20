import type { LlmConfig, LlmFormat } from './llm.js';
import type { CircuitBreakerConfig } from './circuit-breaker.js';
export type { EndpointConfig, ProxyConfig, MoaPresetConfig, MoaConfig } from '../../config/api-config.js';
export type { CircuitBreakerConfig } from './circuit-breaker.js';
export interface ExploreConfig {
    /** Legacy single-endpoint fields (backward compat) */
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    /** API format for legacy single-endpoint (default: 'openai') */
    format?: LlmFormat;
    extraBody?: Record<string, unknown>;
    maxTurns?: number;
    concurrency?: number;
    /** Repository tree depth injected into the first explore prompt (1-6) */
    treeDepth?: number;
    /** Named endpoints for parallel multi-endpoint usage */
    endpoints?: Record<string, import('../../config/api-config.js').EndpointConfig>;
    /** Proxy config */
    proxy?: import('../../config/api-config.js').ProxyConfig;
    /** Circuit breaker for multi-endpoint failover */
    circuitBreaker?: CircuitBreakerConfig;
    /** Mixture-of-Agents presets */
    moa?: import('../../config/api-config.js').MoaConfig;
}
export declare const DEFAULT_EXPLORE_MAX_TURNS = 5;
export declare function loadExploreConfig(): ExploreConfig;
export declare function getDefaultEndpoint(config: ExploreConfig): LlmConfig | null;
export declare function getNamedEndpoint(name: string, config: ExploreConfig): LlmConfig | null;
export interface NamedEndpoint {
    name: string;
    llmConfig: LlmConfig;
    maxTurns?: number;
    /** Per-endpoint max concurrent jobs (unset = unlimited) */
    concurrency?: number;
}
interface StepBase {
    prompt?: string;
    as?: string;
    cache?: boolean;
}
export interface ReferenceStep extends StepBase {
    type: 'reference';
    endpoints?: string[];
    tools?: boolean;
}
export interface AggregateStep extends StepBase {
    type: 'aggregate';
    endpoint?: string;
    tools?: boolean;
}
export interface TransformStep extends StepBase {
    type: 'transform';
}
export interface ValidateStep extends StepBase {
    type: 'validate';
    endpoint?: string;
    tools?: boolean;
}
export interface SupervisorStep extends StepBase {
    type: 'supervisor';
    endpoint?: string;
    tools?: boolean;
}
export interface LoopStep {
    type: 'loop';
    steps: PipelineStep[];
    maxIterations: number;
    until?: string;
}
export type PipelineStep = ReferenceStep | AggregateStep | TransformStep | ValidateStep | SupervisorStep | LoopStep;
export declare const DEFAULT_PIPELINE: PipelineStep[];
export interface ResolvedMoaPreset {
    referenceEndpoints: NamedEndpoint[];
    aggregatorEndpoint: NamedEndpoint;
    steps: PipelineStep[];
}
export declare function getAllEndpoints(config: ExploreConfig): NamedEndpoint[];
export declare function resolveEndpoints(config: ExploreConfig, endpointFilter?: string, all?: boolean): NamedEndpoint[];
/**
 * Resolve the proxy URL for explore HTTP requests.
 * Priority: config.proxy → api.json proxy → api-explore.json proxy → cli-tools.json proxy.
 */
export declare function resolveExploreProxyUrl(config: ExploreConfig): string | undefined;
export declare function injectProxy(endpoints: NamedEndpoint[], proxyUrl: string | undefined): void;
export declare const MOA_MAX_REFERENCES = 4;
export declare function resolveMoaPreset(config: ExploreConfig, presetName?: string): ResolvedMoaPreset | null;
//# sourceMappingURL=config.d.ts.map