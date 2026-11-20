/**
 * Mixture-of-Agents (MOA) core — pipeline-based execution.
 *
 * moaAgentLoop delegates to the pipeline engine (moa-pipeline.ts)
 * which executes a sequence of typed steps (reference, aggregate,
 * transform, validate, loop). The pipeline is defined in the preset
 * config or passed dynamically.
 */
import { buildSystemPrompt } from './system-prompt.js';
import { executeSteps, createPipelineContext } from './moa-pipeline.js';
import { DEFAULT_EXPLORE_MAX_TURNS } from './config.js';
import { buildRepositoryMap, extractRepositoryMapFocusPaths, } from './repository-map.js';
export async function moaAgentLoop(params) {
    const repositoryMap = params.repositoryMap
        ?? buildRepositoryMap(params.cwd, {
            targetDepth: params.treeDepth,
            focusPaths: extractRepositoryMapFocusPaths([params.prompt]),
        });
    const systemPrompt = buildSystemPrompt(params.cwd, repositoryMap, params.maxTurns ?? DEFAULT_EXPLORE_MAX_TURNS);
    const steps = params.pipeline ?? params.preset.steps;
    const ctx = createPipelineContext(params.prompt);
    await executeSteps(steps, ctx, {
        preset: params.preset,
        systemPrompt,
        cwd: params.cwd,
        maxTurns: params.maxTurns,
        cache: params.cache,
        cacheTtlMs: params.cacheTtlMs,
        onProgress: params.onProgress,
        emitter: params.emitter,
    });
    const degraded = ctx.referenceOutputs.length > 0 && ctx.referenceOutputs.every(r => r.error || !r.content);
    return {
        content: ctx.lastOutput,
        referenceOutputs: ctx.referenceOutputs,
        degraded,
        usage: ctx.totalUsage,
    };
}
//# sourceMappingURL=moa-loop.js.map