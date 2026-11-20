/**
 * MOA Pipeline Engine — executes a sequence of typed steps.
 *
 * Step types: reference, aggregate, transform, validate, loop.
 * Variables are interpolated via {{name}} syntax from PipelineContext.
 */
import type { StreamEmitter } from './stream-json-emitter.js';
import type { PipelineStep, ResolvedMoaPreset } from './config.js';
import type { ReferenceOutput } from './moa-loop.js';
export interface PipelineContext {
    query: string;
    references: string;
    lastOutput: string;
    iteration: number;
    namedOutputs: Record<string, string>;
    referenceOutputs: ReferenceOutput[];
    supervisorPass: boolean;
    supervisorFeedback: string;
    totalUsage: {
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
export interface PipelineParams {
    preset: ResolvedMoaPreset;
    systemPrompt: string;
    cwd: string;
    maxTurns?: number;
    cache?: boolean;
    cacheTtlMs?: number;
    onProgress?: (msg: string) => void;
    /** Protocol event sink passed to inner agent loops (default: NDJSON on stdout) */
    emitter?: StreamEmitter;
}
export declare function interpolate(template: string, ctx: PipelineContext): string;
export declare function executeSteps(steps: PipelineStep[], ctx: PipelineContext, params: PipelineParams, baseIndex?: number): Promise<void>;
export declare function createPipelineContext(query: string): PipelineContext;
//# sourceMappingURL=moa-pipeline.d.ts.map