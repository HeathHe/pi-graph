import type { LlmFormat } from '../agents/api-explore/llm.js';
import type { CircuitBreakerConfig } from '../agents/api-explore/circuit-breaker.js';
export interface EndpointConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    format?: LlmFormat;
    extraBody?: Record<string, unknown>;
    concurrency?: number;
    maxTurns?: number;
}
export interface ProxyConfig {
    enabled: boolean;
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
}
export interface MoaPresetConfig {
    referenceEndpoints: string[];
    aggregatorEndpoint: string;
    steps?: unknown[];
    enabled?: boolean;
}
export interface MoaConfig {
    defaultPreset?: string;
    presets: Record<string, MoaPresetConfig>;
}
export interface ApiConfig {
    version?: string;
    endpoints?: Record<string, EndpointConfig>;
    defaults?: {
        maxTurns?: number;
        concurrency?: number;
        format?: LlmFormat;
    };
    circuitBreaker?: CircuitBreakerConfig;
    proxy?: ProxyConfig;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    format?: LlmFormat;
    extraBody?: Record<string, unknown>;
    maxTurns?: number;
    concurrency?: number;
    treeDepth?: number;
}
/**
 * Load API endpoint configuration.
 * Priority: api.json → api-explore.json (deprecated fallback) → empty.
 */
export declare function loadApiConfig(): ApiConfig;
/**
 * Load MOA preset configuration.
 * Priority: moa.json → api-explore.json .moa field → undefined.
 */
export declare function loadMoaConfig(): MoaConfig | undefined;
/**
 * Resolve proxy configuration.
 * Priority: api.json proxy → api-explore.json proxy → cli-tools.json proxy.
 */
export declare function resolveProxyConfig(): ProxyConfig | undefined;
//# sourceMappingURL=api-config.d.ts.map