import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { compareReleaseLifecycleLock, LifecycleFsHelperError, readLifecycleFileBound, withVerifiedLifecycleFsHelper, } from '../utils/lifecycle-fs-helper.js';
const LIFECYCLE_WORKER_TIMEOUT_MS = 15_000;
const LIFECYCLE_LOCK_RELATIVE_PATH = '.workflow/knowhow/.lifecycle.lock';
export const LIFECYCLE_WORKER_ACTIVE_LIMIT = 4;
export const LIFECYCLE_WORKER_QUEUE_LIMIT = 32;
export class KnowhowLifecycleBridgeError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'KnowhowLifecycleBridgeError';
    }
}
function canonicalProjectRoot(projectRoot) {
    const path = realpathSync.native(resolve(projectRoot));
    return {
        path,
        key: process.platform === 'win32' ? path.toLowerCase() : path,
    };
}
export class LifecycleWorkerScheduler {
    active = 0;
    queue = [];
    activeMutationKeys = new Set();
    schedule(request, execute) {
        if (this.queue.length >= LIFECYCLE_WORKER_QUEUE_LIMIT) {
            return Promise.reject(new KnowhowLifecycleBridgeError('KNOWHOW_LIFECYCLE_BUSY', `Lifecycle Worker queue is full (${LIFECYCLE_WORKER_ACTIVE_LIMIT} active, `
                + `${LIFECYCLE_WORKER_QUEUE_LIMIT} queued)`));
        }
        let canonical;
        try {
            canonical = canonicalProjectRoot(request.projectRoot);
        }
        catch (error) {
            return Promise.reject(error);
        }
        const ownerGeneration = randomUUID();
        const workerRequest = {
            ...request,
            projectRoot: canonical.path,
            ownerGeneration,
        };
        const mutationKey = request.operation === 'history' ? null : canonical.key;
        return new Promise((resolvePromise, rejectPromise) => {
            this.queue.push({
                mutationKey,
                execute: () => execute(workerRequest, canonical.path),
                resolve: value => resolvePromise(value),
                reject: rejectPromise,
            });
            this.drain();
        });
    }
    drain() {
        while (this.active < LIFECYCLE_WORKER_ACTIVE_LIMIT) {
            const nextIndex = this.queue.findIndex(entry => entry.mutationKey === null
                || !this.activeMutationKeys.has(entry.mutationKey));
            if (nextIndex < 0)
                return;
            const [entry] = this.queue.splice(nextIndex, 1);
            this.active++;
            if (entry.mutationKey !== null) {
                this.activeMutationKeys.add(entry.mutationKey);
            }
            void Promise.resolve()
                .then(entry.execute)
                .then(value => this.finish(entry, { ok: true, value }), error => this.finish(entry, { ok: false, error }));
        }
    }
    finish(entry, outcome) {
        this.active--;
        if (entry.mutationKey !== null) {
            this.activeMutationKeys.delete(entry.mutationKey);
        }
        this.drain();
        if (outcome.ok)
            entry.resolve(outcome.value);
        else
            entry.reject(outcome.error);
    }
}
const lifecycleWorkerScheduler = new LifecycleWorkerScheduler();
function defaultLifecycleWorkerUrl() {
    const colocated = new URL('./knowhow-lifecycle-worker.js', import.meta.url);
    if (existsSync(fileURLToPath(colocated)))
        return colocated;
    const sourceWorker = new URL('./knowhow-lifecycle-worker.ts', import.meta.url);
    if (existsSync(fileURLToPath(sourceWorker)))
        return null;
    return new URL('../../dist/src/tools/knowhow-lifecycle-worker.js', import.meta.url);
}
async function runSourceLifecycleDirect(request) {
    const lifecycle = await import('./knowhow-lifecycle.js');
    switch (request.operation) {
        case 'supersede':
            return {
                operation: request.operation,
                result: lifecycle.supersedeKnowhowEntry(request.projectRoot, request.oldId, request.newId, {
                    ownerGeneration: request.ownerGeneration,
                    repositoryContext: request.repositoryContext,
                }),
            };
        case 'history':
            return {
                operation: request.operation,
                entries: lifecycle.getKnowhowEvolutionChain(request.projectRoot, request.id),
            };
        case 'recover':
            return {
                operation: request.operation,
                result: lifecycle.recoverKnowhowLifecycleIntent(request.projectRoot, {
                    ownerGeneration: request.ownerGeneration,
                    repositoryContext: request.repositoryContext,
                }),
            };
    }
}
function isMissingLifecycleFile(error) {
    return error instanceof LifecycleFsHelperError && error.code === 'MISSING';
}
function parseMatchingBoundLock(bytesBase64, generation, ownerGeneration) {
    let value;
    try {
        value = JSON.parse(Buffer.from(bytesBase64, 'base64').toString('utf8'));
    }
    catch {
        throw new Error('Lifecycle lock contains invalid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Lifecycle lock has an invalid owner envelope');
    }
    const owner = value;
    if (owner.ownerGeneration !== ownerGeneration)
        return null;
    if (Object.keys(owner).sort().join(',') !== 'ownerGeneration,pid,token'
        || !Number.isInteger(owner.pid)
        || owner.pid <= 0
        || typeof owner.token !== 'string'
        || owner.token.length === 0
        || (generation.ownerGeneration !== null
            && generation.ownerGeneration !== ownerGeneration)) {
        throw new Error('Lifecycle lock does not match its bound owner generation');
    }
    return {
        lockRelativePath: LIFECYCLE_LOCK_RELATIVE_PATH,
        token: owner.token,
        ownerGeneration,
        generation: {
            ...generation,
            ownerGeneration,
        },
    };
}
function releaseMatchingLifecycleLock(projectRoot, request) {
    if (request.operation === 'history')
        return;
    withVerifiedLifecycleFsHelper(() => {
        let read;
        try {
            read = readLifecycleFileBound(projectRoot, LIFECYCLE_LOCK_RELATIVE_PATH);
        }
        catch (error) {
            if (isMissingLifecycleFile(error))
                return;
            throw error;
        }
        const lock = parseMatchingBoundLock(read.bytesBase64, read.generation, request.ownerGeneration);
        if (!lock)
            return;
        const release = compareReleaseLifecycleLock(projectRoot, lock);
        if (release !== 'released' && release !== 'missing' && release !== 'replaced') {
            throw new Error(`Unexpected lifecycle lock cleanup result: ${release}`);
        }
    });
}
function cleanupFailure(errors) {
    const detail = errors
        .map(error => error instanceof Error ? error.message : String(error))
        .join('; ');
    return new KnowhowLifecycleBridgeError('KNOWHOW_LIFECYCLE_CLEANUP_FAILED', `Lifecycle Worker termination or bound lock cleanup failed: ${detail}`, { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) });
}
async function cleanupAfterWorker(worker, canonicalRoot, request) {
    const errors = [];
    if (worker) {
        try {
            await worker.terminate();
        }
        catch (error) {
            errors.push(error);
        }
    }
    try {
        releaseMatchingLifecycleLock(canonicalRoot, request);
    }
    catch (error) {
        errors.push(error);
    }
    if (errors.length > 0)
        throw cleanupFailure(errors);
}
async function runAdmittedWorker(request, canonicalRoot, options) {
    const workerUrl = options.workerUrl ?? defaultLifecycleWorkerUrl();
    const timeoutMs = options.timeoutMs ?? LIFECYCLE_WORKER_TIMEOUT_MS;
    if (!workerUrl)
        return runSourceLifecycleDirect(request);
    let worker;
    try {
        worker = new Worker(workerUrl, {
            execArgv: process.execArgv.filter(argument => !argument.startsWith('--input-type') && argument !== '--liftoff-only'),
        });
    }
    catch (error) {
        await cleanupAfterWorker(null, canonicalRoot, request);
        throw error;
    }
    return new Promise((resolvePromise, rejectPromise) => {
        let settling = false;
        let timer = null;
        const detach = () => {
            if (timer)
                clearTimeout(timer);
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
        };
        const settle = (outcome) => {
            if (settling)
                return;
            settling = true;
            detach();
            void cleanupAfterWorker(worker, canonicalRoot, request).then(() => {
                if (outcome.ok)
                    resolvePromise(outcome.result);
                else
                    rejectPromise(outcome.error);
            }, cleanupError => rejectPromise(cleanupError));
        };
        const fail = (error) => settle({ ok: false, error });
        const onMessage = (message) => {
            if (message?.type !== 'knowhow-lifecycle-result') {
                fail(new Error('Knowhow lifecycle worker returned an invalid message'));
                return;
            }
            if (!message.ok) {
                fail(new Error(message.error));
                return;
            }
            if (message.result.operation !== request.operation) {
                fail(new Error('Knowhow lifecycle worker returned a mismatched operation'));
                return;
            }
            settle({ ok: true, result: message.result });
        };
        const onError = (error) => {
            fail(new Error(`Knowhow lifecycle worker error: ${error.message}`));
        };
        const onExit = (code) => {
            fail(new Error(`Knowhow lifecycle worker exited with code ${code}`));
        };
        worker.once('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
        timer = setTimeout(() => {
            fail(new Error(`Knowhow lifecycle worker timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        try {
            worker.postMessage(request);
        }
        catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
export function runKnowhowLifecycleAsync(request, options = {}) {
    return lifecycleWorkerScheduler.schedule(request, (workerRequest, canonicalRoot) => runAdmittedWorker(workerRequest, canonicalRoot, options));
}
//# sourceMappingURL=knowhow-lifecycle-async.js.map