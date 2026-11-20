import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIFECYCLE_FS_HELPER_PROTOCOL, } from './lifecycle-fs-wire.js';
let activeVerifiedHelper = null;
const PLATFORM_TARGETS = Object.freeze({
    'win32-x64': 'x86_64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
});
export class LifecycleFsHelperError extends Error {
    code;
    nativeStatus;
    constructor(code, message, nativeStatus = null) {
        super(`lifecycle fs helper: ${message}`);
        this.name = 'LifecycleFsHelperError';
        this.code = code;
        this.nativeStatus = nativeStatus;
    }
}
function fail(message, code = 'UNSUPPORTED', nativeStatus = null) {
    throw new LifecycleFsHelperError(code, message, nativeStatus);
}
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function packageRoot() {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const sourceCandidate = resolve(moduleDirectory, '..', '..');
    if (existsSync(resolve(sourceCandidate, 'resources/lifecycle-fs/manifest.json'))) {
        return sourceCandidate;
    }
    return resolve(moduleDirectory, '..', '..', '..');
}
function parseJsonFile(path, label) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return fail(`${label} is missing or invalid JSON`, 'UNSUPPORTED');
    }
}
export function verifyLifecycleFsHelperBinary(options = {}) {
    const root = resolve(options.packageRoot ?? packageRoot());
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const target = PLATFORM_TARGETS[`${platform}-${arch}`];
    if (!target)
        fail(`unsupported platform/arch ${platform}/${arch}`);
    const manifest = parseJsonFile(resolve(root, 'resources/lifecycle-fs/manifest.json'), 'native manifest');
    const provenance = parseJsonFile(resolve(root, 'resources/lifecycle-fs/provenance.json'), 'native provenance');
    if (manifest.schema_version !== 'lifecycle-fs-native-manifest/1.0'
        || manifest.protocol !== LIFECYCLE_FS_HELPER_PROTOCOL
        || !Array.isArray(manifest.artifacts)
        || manifest.artifacts.length !== 5
        || provenance.schema_version !== 'lifecycle-fs-native-provenance/1.0'
        || provenance.workflow_id !== 247776234
        || !/^[0-9a-f]{40}$/.test(provenance.source_sha)
        || !/^native-[0-9a-f]{32}$/.test(provenance.dispatch_nonce)) {
        fail('manifest or provenance identity mismatch');
    }
    const artifact = manifest.artifacts.find(candidate => candidate.target === target);
    if (!artifact
        || artifact.platform !== platform
        || artifact.arch !== arch
        || artifact.protocol !== LIFECYCLE_FS_HELPER_PROTOCOL
        || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
        fail(`manifest mapping mismatch for ${platform}/${arch}`);
    }
    const path = resolve(root, artifact.path);
    let bytes;
    try {
        bytes = readFileSync(path);
    }
    catch {
        return fail(`binary is missing for ${target}`, 'UNSUPPORTED');
    }
    if (sha256(bytes) !== artifact.sha256) {
        fail(`binary SHA-256 mismatch for ${target}`);
    }
    return {
        path,
        target,
        sha256: artifact.sha256,
        protocol: artifact.protocol,
        sourceSha: provenance.source_sha,
        workflowRunId: provenance.database_id,
    };
}
export function withVerifiedLifecycleFsHelper(action) {
    if (activeVerifiedHelper)
        return action();
    const verified = verifyLifecycleFsHelperBinary();
    activeVerifiedHelper = verified;
    try {
        return action();
    }
    finally {
        activeVerifiedHelper = null;
    }
}
function runRequest(request, packageRootOverride) {
    const verified = activeVerifiedHelper
        ?? verifyLifecycleFsHelperBinary({ packageRoot: packageRootOverride });
    const result = spawnSync(verified.path, [], {
        encoding: 'utf8',
        windowsHide: true,
        input: `${JSON.stringify(request)}\n`,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        fail(result.error?.message ?? (result.stderr.trim() || `native helper exited ${result.status}`), 'NATIVE_ERROR');
    }
    let response;
    try {
        response = JSON.parse(result.stdout.trim());
    }
    catch {
        return fail('native helper returned invalid JSON', 'NATIVE_ERROR');
    }
    if (response.protocol !== LIFECYCLE_FS_HELPER_PROTOCOL
        || response.requestId !== request.requestId) {
        fail('native helper response identity mismatch', 'NATIVE_ERROR');
    }
    if (!response.ok) {
        fail(`${response.code}: ${response.message}`, response.code, response.nativeStatus);
    }
    return response.result;
}
function requestBase(projectRoot) {
    return {
        protocol: LIFECYCLE_FS_HELPER_PROTOCOL,
        requestId: randomUUID(),
        projectRoot: resolve(projectRoot),
    };
}
export function readLifecycleFileBound(projectRoot, relativePath) {
    return runRequest({
        ...requestBase(projectRoot),
        op: 'read',
        relativePath,
    });
}
export function replaceLifecycleFileBound(projectRoot, relativePath, bytes, expected, ownerGeneration) {
    return runRequest({
        ...requestBase(projectRoot),
        op: 'replace',
        relativePath,
        bytesBase64: bytes.toString('base64'),
        expected,
        ownerGeneration,
    });
}
export function acquireLifecycleLockBound(projectRoot, lockRelativePath, owner, staleAfterMs) {
    return runRequest({
        ...requestBase(projectRoot),
        op: 'acquire-lock',
        lockRelativePath,
        owner,
        staleAfterMs,
    });
}
export function quarantineLifecycleFileBound(projectRoot, relativePath, expectedSha256, requestId, ownerGeneration) {
    return runRequest({
        protocol: LIFECYCLE_FS_HELPER_PROTOCOL,
        requestId,
        projectRoot: resolve(projectRoot),
        op: 'quarantine-if-hash',
        relativePath,
        expectedSha256,
        requestIdToRestore: requestId,
        ownerGeneration,
    });
}
export function recoverLifecycleQuarantineBound(projectRoot, quarantine, decision) {
    try {
        return runRequest({
            ...requestBase(projectRoot),
            op: 'recover-quarantine',
            quarantine,
            decision,
        });
    }
    catch (error) {
        if (error instanceof LifecycleFsHelperError && error.code === 'HASH_MISMATCH') {
            return 'replaced';
        }
        throw error;
    }
}
export function compareReleaseLifecycleLock(projectRoot, lock) {
    try {
        return runRequest({
            ...requestBase(projectRoot),
            op: 'compare-release-lock',
            lock,
        });
    }
    catch (error) {
        if (error instanceof LifecycleFsHelperError && error.code === 'HASH_MISMATCH') {
            return 'replaced';
        }
        throw error;
    }
}
//# sourceMappingURL=lifecycle-fs-helper.js.map