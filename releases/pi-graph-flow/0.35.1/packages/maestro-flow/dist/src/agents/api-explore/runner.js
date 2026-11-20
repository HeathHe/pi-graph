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
import { createClient, probeEndpoint } from './llm.js';
import { relative, resolve } from 'node:path';
import { createTraceEmitter, silentEmitter } from './stream-json-emitter.js';
import { TOOL_SCHEMAS } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import { agentLoop } from './agent-loop.js';
import { buildExplorePrompt } from './prompt-parser.js';
import { moaAgentLoop } from './moa-loop.js';
import { EndpointCircuitBreaker } from './circuit-breaker.js';
import { buildRepositoryMap, extractExplicitFilePaths, extractRepositoryMapFocusPaths, } from './repository-map.js';
/**
 * Half-open recovery sweep used only when no healthy endpoint remains.
 * Persisted trips keep the fast path cheap, but cannot strand explore forever.
 */
export async function recoverTrippedEndpoints(breaker, endpoints, probe = probeEndpoint, timeoutMs = 3_000) {
    const tripped = new Set(breaker.getTrippedEndpoints());
    const candidates = endpoints.filter(ep => tripped.has(ep.name));
    const results = await Promise.all(candidates.map(async (ep) => {
        try {
            return { name: ep.name, alive: await probe(ep.llmConfig, timeoutMs) };
        }
        catch {
            return { name: ep.name, alive: false };
        }
    }));
    const recovered = [];
    for (const { name, alive } of results) {
        if (!alive)
            continue;
        breaker.allowHalfOpenTrial(name);
        recovered.push(name);
    }
    return recovered;
}
async function runSingleJob(job, cwd, globalMaxTurns, repositoryMap, moaPreset) {
    const start = Date.now();
    const trace = [];
    try {
        if (moaPreset) {
            const moaResult = await moaAgentLoop({
                prompt: job.prompt,
                preset: moaPreset,
                cwd,
                maxTurns: globalMaxTurns,
                repositoryMap,
                emitter: silentEmitter,
            });
            return {
                id: job.id,
                prompt: job.prompt,
                endpointName: 'moa',
                model: `MOA(${moaPreset.aggregatorEndpoint.name})`,
                content: moaResult.content,
                durationMs: Date.now() - start,
            };
        }
        const { client, config } = createClient(job.llmConfig);
        const maxTurns = job.maxTurns ?? globalMaxTurns;
        const systemPrompt = buildSystemPrompt(cwd, repositoryMap, maxTurns);
        const prompt = buildExplorePrompt(job.prompt);
        const explicitFiles = new Set(extractExplicitFilePaths(job.prompt).map(path => relative(resolve(cwd), resolve(cwd, path)).replace(/\\/g, '/').toLowerCase()));
        const requiredInitialReads = (repositoryMap.directReadPaths ?? [])
            .filter(path => explicitFiles.has(path.toLowerCase()));
        const result = await agentLoop({
            prompt,
            systemPrompt,
            client,
            llmConfig: config,
            toolSchemas: TOOL_SCHEMAS,
            cwd,
            maxTurns,
            emitter: createTraceEmitter(trace),
            requiredInitialReads,
        });
        return {
            id: job.id,
            prompt: job.prompt,
            endpointName: job.endpointName,
            model: job.llmConfig.model,
            content: result.apiError ? null : result.content,
            error: result.apiError ? result.content : undefined,
            durationMs: Date.now() - start,
            usage: result.usage,
            trace: trace.length > 0 ? trace : undefined,
        };
    }
    catch (err) {
        return {
            id: job.id,
            prompt: job.prompt,
            endpointName: job.endpointName,
            model: job.llmConfig.model,
            content: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
            trace: trace.length > 0 ? trace : undefined,
        };
    }
}
/**
 * Drain a queue of jobs with a per-queue concurrency limit.
 * concurrency=1 means strict serial within this queue.
 */
async function drainQueue(queue, concurrency, cwd, maxTurns, repositoryMap, totalJobs, jobIndexMap, callbacks, moaPreset, breaker, allEndpoints) {
    const results = [];
    let nextIdx = 0;
    async function runSlot() {
        while (nextIdx < queue.length) {
            const localIdx = nextIdx++;
            let job = queue[localIdx];
            const globalIdx = jobIndexMap.get(job.id) ?? localIdx;
            // Circuit breaker: if current endpoint is tripped, try fallback
            if (breaker?.isOpen(job.endpointName) && allEndpoints) {
                const fallback = breaker.selectFallback(job.endpointName, allEndpoints);
                if (fallback) {
                    callbacks.onProgress?.(`[${globalIdx + 1}/${totalJobs}] ${job.endpointName} tripped, fallback → ${fallback.name}:${fallback.llmConfig.model}`);
                    job = { ...job, endpointName: fallback.name, llmConfig: fallback.llmConfig };
                }
                else {
                    callbacks.onProgress?.(`[${globalIdx + 1}/${totalJobs}] ${job.endpointName} tripped, no fallback available — skipping`);
                    const skipped = {
                        id: job.id,
                        prompt: job.prompt,
                        endpointName: job.endpointName,
                        model: job.llmConfig.model,
                        content: null,
                        error: `Circuit breaker open for ${job.endpointName}, no fallback available`,
                        durationMs: 0,
                    };
                    results.push(skipped);
                    callbacks.onJobDone?.(skipped);
                    continue;
                }
            }
            callbacks.onJobStart?.(job);
            callbacks.onProgress?.(`[${globalIdx + 1}/${totalJobs}] ${job.endpointName}:${job.llmConfig.model} — starting`);
            let result = await runSingleJob(job, cwd, maxTurns, repositoryMap, moaPreset);
            // Record success/failure for circuit breaker
            if (breaker) {
                if (result.error) {
                    const tripped = breaker.recordFailure(job.endpointName);
                    if (tripped) {
                        callbacks.onProgress?.(`⚡ Circuit breaker tripped for ${job.endpointName} — subsequent jobs will use fallback`);
                    }
                }
                else {
                    breaker.recordSuccess(job.endpointName);
                }
            }
            // Immediate fallback retry: try all available endpoints until one succeeds
            if (result.error && allEndpoints && allEndpoints.length > 1) {
                const tried = new Set([job.endpointName]);
                const failures = [`${job.endpointName}: ${result.error}`];
                const candidates = breaker
                    ? breaker.getFallbackCandidates(job.endpointName, allEndpoints, tried)
                    : allEndpoints.filter(candidate => !tried.has(candidate.name));
                for (const candidate of candidates) {
                    tried.add(candidate.name);
                    callbacks.onProgress?.(`[${globalIdx + 1}/${totalJobs}] ${job.endpointName} failed, retrying → ${candidate.name}:${candidate.llmConfig.model}`);
                    const retryJob = {
                        ...job,
                        endpointName: candidate.name,
                        llmConfig: candidate.llmConfig,
                    };
                    const retryResult = await runSingleJob(retryJob, cwd, maxTurns, repositoryMap, moaPreset);
                    result = retryResult;
                    if (!retryResult.error) {
                        breaker?.recordSuccess(candidate.name);
                        breaker?.trip(job.endpointName);
                        break;
                    }
                    failures.push(`${candidate.name}: ${retryResult.error}`);
                    breaker?.recordFailure(candidate.name);
                }
                if (result.error && failures.length > 1) {
                    result = {
                        ...result,
                        error: `All fallback endpoints failed (${failures.join(' | ')})`,
                    };
                }
            }
            results.push(result);
            callbacks.onJobDone?.(result);
            const status = result.error
                ? `ERROR: ${result.error}`
                : `done (${(result.durationMs / 1000).toFixed(1)}s)`;
            callbacks.onProgress?.(`[${globalIdx + 1}/${totalJobs}] ${result.endpointName}:${result.model} — ${status}`);
        }
    }
    const slots = Math.min(concurrency, queue.length);
    await Promise.allSettled(Array.from({ length: slots }, () => runSlot()));
    return results;
}
/**
 * Run explore jobs: serial within same endpoint, parallel across endpoints.
 */
export async function runExploreJobs(opts) {
    const { jobs, cwd, maxTurns, concurrency, endpointConcurrency, treeDepth, moaPreset, circuitBreaker: cbConfig, allEndpoints, onProgress, onJobStart, onJobDone, } = opts;
    if (jobs.length === 0)
        return [];
    const focusPaths = extractRepositoryMapFocusPaths(jobs.map(job => job.prompt));
    const repositoryMap = buildRepositoryMap(cwd, { targetDepth: treeDepth, focusPaths });
    const mapFlags = [
        repositoryMap.fellBack ? 'depth reduced' : '',
        repositoryMap.truncated ? 'truncated' : '',
    ].filter(Boolean);
    onProgress?.(`Repository map: depth=${repositoryMap.depth}, ${(repositoryMap.sizeBytes / 1024).toFixed(1)}KB, focus=${repositoryMap.focusCount ?? 0}${mapFlags.length ? ` (${mapFlags.join(', ')})` : ''}`);
    // Circuit breaker: shared across all endpoint queues
    const breaker = allEndpoints && allEndpoints.length > 1
        ? new EndpointCircuitBreaker(cbConfig, {
            onTrip: (name, failures) => onProgress?.(`⚡ Circuit breaker: ${name} tripped after ${failures} consecutive failures`),
        })
        : undefined;
    // Pre-flight: probe endpoints not already tripped by persistent state
    if (breaker && allEndpoints && allEndpoints.length > 1) {
        const probeTimeoutMs = Math.max(250, cbConfig?.probeTimeoutMs ?? 3_000);
        const alreadyTripped = breaker.getTrippedEndpoints();
        for (const name of alreadyTripped) {
            onProgress?.(`Pre-flight: ${name} still tripped (from previous run) — skipping probe`);
        }
        const toProbe = allEndpoints.filter(ep => !alreadyTripped.includes(ep.name));
        if (toProbe.length > 0) {
            const probeResults = await Promise.all(toProbe.map(async (ep) => ({
                name: ep.name,
                alive: await probeEndpoint(ep.llmConfig, probeTimeoutMs),
            })));
            for (const { name, alive } of probeResults) {
                if (!alive) {
                    breaker.trip(name);
                    onProgress?.(`Pre-flight: ${name} unreachable — pre-tripped`);
                }
            }
        }
        let totalHealthy = allEndpoints.filter(ep => !breaker.isOpen(ep.name)).length;
        if (totalHealthy === 0 && alreadyTripped.length > 0) {
            onProgress?.(`Pre-flight: no healthy endpoints; recovery probing ${alreadyTripped.length} tripped endpoint(s)`);
            const recovered = await recoverTrippedEndpoints(breaker, allEndpoints.filter(ep => alreadyTripped.includes(ep.name)), probeEndpoint, probeTimeoutMs);
            for (const name of recovered) {
                onProgress?.(`Pre-flight: ${name} reachable — half-open trial enabled`);
            }
            totalHealthy = allEndpoints.filter(ep => !breaker.isOpen(ep.name)).length;
        }
        if (totalHealthy === 0) {
            onProgress?.('Pre-flight: all endpoints unreachable');
        }
    }
    // Group jobs by endpoint
    const queues = new Map();
    const jobIndexMap = new Map();
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        jobIndexMap.set(job.id, i);
        let q = queues.get(job.endpointName);
        if (!q) {
            q = [];
            queues.set(job.endpointName, q);
        }
        q.push(job);
    }
    // Per-queue job limit: CLI override > endpoint config > unlimited
    const queueLimits = new Map();
    for (const [name, queue] of queues) {
        const limit = endpointConcurrency ?? queue[0]?.concurrency;
        queueLimits.set(name, Number.isFinite(limit) && limit > 0 ? limit : Infinity);
    }
    const endpointNames = [...queues.keys()];
    const limitDesc = [...queueLimits.values()].every(v => v === Infinity)
        ? 'unlimited'
        : endpointNames.map(n => `${n}=${queueLimits.get(n) === Infinity ? '∞' : queueLimits.get(n)}`).join(', ');
    onProgress?.(`Scheduling: ${endpointNames.length} endpoint(s), ${limitDesc} job(s)/endpoint, ${concurrency} max parallel`);
    const allResults = [];
    // Run endpoint queues in parallel, capped by concurrency
    const queueEntries = [...queues.entries()];
    let nextQueue = 0;
    async function runEndpointSlot() {
        while (nextQueue < queueEntries.length) {
            const idx = nextQueue++;
            const [name, queue] = queueEntries[idx];
            const results = await drainQueue(queue, queueLimits.get(name) ?? Infinity, cwd, maxTurns, repositoryMap, jobs.length, jobIndexMap, { onProgress, onJobStart, onJobDone }, moaPreset, breaker, allEndpoints);
            allResults.push(...results);
        }
    }
    const endpointSlots = Math.min(concurrency, queueEntries.length);
    await Promise.allSettled(Array.from({ length: endpointSlots }, () => runEndpointSlot()));
    // Persist and log circuit breaker summary
    if (breaker) {
        breaker.persistState();
        const tripped = breaker.getTrippedEndpoints();
        if (tripped.length > 0) {
            onProgress?.(`Circuit breaker summary: ${tripped.join(', ')} currently tripped`);
        }
    }
    // Return in original job order
    const resultMap = new Map(allResults.map(r => [r.id, r]));
    return jobs.map(j => resultMap.get(j.id)).filter(Boolean);
}
/**
 * Build job list from prompt entries. Default: 1 prompt = 1 agent (first endpoint).
 * Per-prompt `endpoint` field overrides the global endpoint selection.
 */
export function buildJobsFromEntries(entries, globalEndpoints, allEndpoints) {
    const jobs = [];
    let counter = 0;
    const endpointMap = new Map();
    for (const ep of allEndpoints)
        endpointMap.set(ep.name, ep);
    for (const ep of globalEndpoints)
        endpointMap.set(ep.name, ep);
    for (const entry of entries) {
        let targets;
        if (entry.endpoint) {
            const names = entry.endpoint.split(',').map(s => s.trim()).filter(Boolean);
            targets = names
                .map(n => endpointMap.get(n))
                .filter((ep) => ep !== undefined);
            if (targets.length === 0)
                targets = [globalEndpoints[0]];
        }
        else {
            targets = [globalEndpoints[0]];
        }
        for (const ep of targets) {
            counter++;
            jobs.push({
                id: `explore-${counter}`,
                prompt: entry.prompt,
                endpointName: ep.name,
                llmConfig: ep.llmConfig,
                maxTurns: ep.maxTurns,
                concurrency: ep.concurrency,
            });
        }
    }
    return jobs;
}
/**
 * Build job list from prompts × endpoints cartesian product.
 * Used when --all flag fans one prompt to every endpoint.
 */
export function buildJobs(prompts, endpoints) {
    const jobs = [];
    let counter = 0;
    for (const prompt of prompts) {
        for (const ep of endpoints) {
            counter++;
            jobs.push({
                id: `explore-${counter}`,
                prompt,
                endpointName: ep.name,
                llmConfig: ep.llmConfig,
                maxTurns: ep.maxTurns,
                concurrency: ep.concurrency,
            });
        }
    }
    return jobs;
}
//# sourceMappingURL=runner.js.map