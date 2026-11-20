/**
 * Mixture-of-Agents (MOA) core — pipeline-based execution.
 *
 * moaAgentLoop delegates to the pipeline engine (moa-pipeline.ts)
 * which executes a sequence of typed steps (reference, aggregate,
 * transform, validate, loop). The pipeline is defined in the preset
 * config or passed dynamically.
 */
import type { StreamEmitter } from './stream-json-emitter.js';
import type { PipelineStep, ResolvedMoaPreset } from './config.js';
import { type RepositoryMap } from './repository-map.js';
export interface ReferenceOutput {
    endpointName: string;
    model: string;
    content: string | null;
    error?: string;
    durationMs: number;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}
export interface MoaResult {
    content: string;
    referenceOutputs: ReferenceOutput[];
    degraded: boolean;
    usage: {
        references: Array<{
            endpointName: string;
            model: string;
            inputTokens: number;
            outputTokens: number;
        }>;
        aggregator: {
            inputTokens: number;
            outputTokens: number;
        };
    };
}
export interface MoaLoopParams {
    prompt: string;
    preset: ResolvedMoaPreset;
    cwd: string;
    maxTurns?: number;
    treeDepth?: number;
    repositoryMap?: RepositoryMap;
    onProgress?: (msg: string) => void;
    cache?: boolean;
    cacheTtlMs?: number;
    pipeline?: PipelineStep[];
    /** Protocol event sink passed to inner agent loops (default: NDJSON on stdout) */
    emitter?: StreamEmitter;
}
export declare function moaAgentLoop(params: MoaLoopParams): Promise<MoaResult>;
//# sourceMappingURL=moa-loop.d.ts.map