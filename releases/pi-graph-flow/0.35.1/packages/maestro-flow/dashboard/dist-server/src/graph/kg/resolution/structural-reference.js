// src/graph/kg/resolution/structural-reference.ts
// 结构事实契约：提取阶段只记录可重放的 syntax fact，解析阶段再物化 edge。
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, win32 } from 'node:path';
export const STRUCTURAL_REFERENCE_STATUSES = [
    'pending',
    'resolved',
    'ambiguous',
    'not_found',
];
export const STRUCTURAL_RELATION_HINTS = [
    'inherits-or-conforms',
    'extends',
    'implements',
    'decorates',
    'contains-owner',
];
export const STRUCTURAL_LOOKUP_SCOPES = [
    'file',
    'module',
    'project',
    'external',
    'project-and-external',
];
export const STRUCTURAL_TARGET_KIND_HINTS = [
    'module',
    'class',
    'struct',
    'interface',
    'trait',
    'protocol',
    'enum',
    'type_alias',
    'namespace',
];
export const STRUCTURAL_LANGUAGE_HINTS = [
    'typescript', 'javascript', 'tsx', 'jsx',
    'python', 'go', 'rust', 'java',
    'c', 'cpp', 'csharp', 'php', 'ruby',
    'swift', 'kotlin', 'dart',
    'svelte', 'vue', 'liquid',
    'pascal', 'scala', 'lua', 'luau', 'objc',
    'yaml', 'twig', 'xml', 'properties',
    'unknown',
];
const STRUCTURAL_REF_KEY_PATTERN = /^structref:v1:[0-9a-f]{64}$/;
const STATUS_SET = new Set(STRUCTURAL_REFERENCE_STATUSES);
const RELATION_SET = new Set(STRUCTURAL_RELATION_HINTS);
const LOOKUP_SCOPE_SET = new Set(STRUCTURAL_LOOKUP_SCOPES);
const TARGET_KIND_SET = new Set(STRUCTURAL_TARGET_KIND_HINTS);
const LANGUAGE_SET = new Set(STRUCTURAL_LANGUAGE_HINTS);
function toPosixPath(value) {
    // On POSIX, backslash is a legal filename byte and must remain part of identity.
    return process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
}
function isInside(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel));
}
/**
 * Resolves a local code path through realpath and rejects paths outside the
 * canonical project root. Logical external paths never touch the filesystem.
 */
export function canonicalizeCodeFilePath(projectRoot, filePath) {
    const externalInput = filePath.replace(/\\/g, '/');
    if (externalInput.startsWith('@external/')) {
        const segments = externalInput.split('/').slice(1);
        if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
            throw new Error(`external-code-path-noncanonical: ${filePath}`);
        }
        return externalInput;
    }
    const canonicalRoot = realpathSync(projectRoot);
    const candidate = isAbsolute(filePath) ? filePath : resolve(canonicalRoot, filePath);
    const canonicalFile = realpathSync(candidate);
    if (!isInside(canonicalRoot, canonicalFile)) {
        throw new Error(`code-path-outside-project: ${filePath}`);
    }
    return toPosixPath(canonicalFile);
}
/**
 * Produces an NFC comparison key only when that key maps to one exact identity
 * path in the current scan. Distinct filesystem spellings are never merged.
 */
export function makePathComparisonKey(identityPath, scanIdentityPaths = [identityPath]) {
    return new ScanPathComparisonIndex(scanIdentityPaths).get(identityPath);
}
/** Scan-scoped NFC multimap used by extraction and resolution filtering. */
export class ScanPathComparisonIndex {
    identityPathsByKey = new Map();
    constructor(identityPaths = []) {
        for (const identityPath of identityPaths)
            this.add(identityPath);
    }
    add(identityPath) {
        const exactPath = toPosixPath(identityPath);
        const key = exactPath.normalize('NFC');
        const paths = this.identityPathsByKey.get(key) ?? new Set();
        paths.add(exactPath);
        this.identityPathsByKey.set(key, paths);
    }
    get(identityPath) {
        const exactPath = toPosixPath(identityPath);
        const key = exactPath.normalize('NFC');
        // Lookup spellings are filters, not observed filesystem identities. Only
        // paths registered by the scan can establish a real collision.
        const identityPaths = [...(this.identityPathsByKey.get(key) ?? [])]
            .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
        if (identityPaths.length > 1) {
            return {
                ok: false,
                error: 'unicode-path-collision',
                key,
                identityPath: exactPath,
                identityPaths,
            };
        }
        return { ok: true, key, identityPath: exactPath };
    }
}
export function makeStructuralReferenceKey(input) {
    const hashInput = [
        'v1',
        toPosixPath(input.normalizedOriginPath),
        input.anchorNodeId,
        input.relationHint,
        input.edgeOrientation,
        input.rawTargetName,
        `${input.line}:${input.column}`,
    ].join('\0');
    const digest = createHash('sha256').update(hashInput).digest('hex');
    return `structref:v1:${digest}`;
}
export function rebaseStructuralReferenceOrigin(reference, origin) {
    return {
        ...reference,
        origin,
        refKey: makeStructuralReferenceKey({
            normalizedOriginPath: origin.filePath,
            anchorNodeId: reference.anchorNodeId,
            relationHint: reference.relationHint,
            edgeOrientation: reference.edgeOrientation,
            rawTargetName: reference.rawTargetName,
            line: origin.line,
            column: origin.column,
        }),
    };
}
export function validateStructuralReference(value) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, errors: ['structural reference must be an object'] };
    }
    const ref = value;
    if (ref.kind !== 'type' && ref.kind !== 'owner') {
        errors.push(`unknown structural reference kind: ${String(ref.kind)}`);
    }
    if (typeof ref.refKey !== 'string' || !STRUCTURAL_REF_KEY_PATTERN.test(ref.refKey)) {
        errors.push('refKey must match structref:v1:<sha256-lowercase-hex>');
    }
    if (typeof ref.anchorNodeId !== 'string' || !ref.anchorNodeId.startsWith('code:')) {
        errors.push('anchorNodeId must use the code: namespace');
    }
    if (typeof ref.anchorQualifiedName !== 'string' || ref.anchorQualifiedName.trim() === '') {
        errors.push('anchorQualifiedName must not be empty');
    }
    if (typeof ref.rawTargetName !== 'string' || ref.rawTargetName.trim() === '') {
        errors.push('rawTargetName must not be empty');
    }
    if (typeof ref.sourceDeclarationKind !== 'string' || ref.sourceDeclarationKind.trim() === '') {
        errors.push('sourceDeclarationKind must not be empty');
    }
    if (typeof ref.lookupScope !== 'string' || !LOOKUP_SCOPE_SET.has(ref.lookupScope)) {
        errors.push(`unknown lookupScope: ${String(ref.lookupScope)}`);
    }
    if (typeof ref.relationHint !== 'string' || !RELATION_SET.has(ref.relationHint)) {
        errors.push(`unknown relationHint: ${String(ref.relationHint)}`);
    }
    if (ref.edgeOrientation !== 'anchor-to-target' && ref.edgeOrientation !== 'target-to-anchor') {
        errors.push(`unknown edgeOrientation: ${String(ref.edgeOrientation)}`);
    }
    if (ref.kind === 'type' && ref.edgeOrientation !== 'anchor-to-target') {
        errors.push('type relations require anchor-to-target orientation');
    }
    if (ref.kind === 'type' && ref.relationHint === 'contains-owner') {
        errors.push('type relations cannot use contains-owner');
    }
    if (ref.kind === 'owner' && ref.relationHint !== 'contains-owner') {
        errors.push('owner relations require contains-owner');
    }
    if (ref.kind === 'owner' && ref.edgeOrientation !== 'target-to-anchor') {
        errors.push('contains-owner requires target-to-anchor orientation');
    }
    validateStringArray(ref.targetKindHints, 'targetKindHints', TARGET_KIND_SET, errors);
    validateStringArray(ref.targetLanguageHints, 'targetLanguageHints', LANGUAGE_SET, errors);
    validateStringArray(ref.moduleHints, 'moduleHints', undefined, errors);
    validateStringArray(ref.targetFileHints, 'targetFileHints', undefined, errors);
    if (ref.compilationCondition !== undefined
        && (typeof ref.compilationCondition !== 'string' || ref.compilationCondition.trim() === '')) {
        errors.push('compilationCondition must be a non-empty string when present');
    }
    if (ref.evidenceProvenance !== 'tree-sitter') {
        errors.push('evidenceProvenance must be tree-sitter');
    }
    if (ref.status !== undefined && (typeof ref.status !== 'string' || !STATUS_SET.has(ref.status))) {
        errors.push(`unknown structural reference status: ${String(ref.status)}`);
    }
    const origin = ref.origin;
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
        errors.push('origin must be an object');
    }
    else {
        const row = origin;
        if (typeof row.filePath !== 'string' || row.filePath.trim() === '') {
            errors.push('origin.filePath must not be empty');
        }
        else if (!isCanonicalIdentityPath(row.filePath)) {
            errors.push('origin.filePath must be a canonical absolute or @external identity path');
        }
        if (typeof row.language !== 'string' || !LANGUAGE_SET.has(row.language)) {
            errors.push(`unknown origin.language: ${String(row.language)}`);
        }
        if (!Number.isInteger(row.line) || Number(row.line) < 1) {
            errors.push('origin.line must be a positive integer');
        }
        if (!Number.isInteger(row.column) || Number(row.column) < 1) {
            errors.push('origin.column must be a positive integer');
        }
        if (typeof row.filePath === 'string'
            && typeof ref.anchorNodeId === 'string'
            && !ref.anchorNodeId.startsWith(`code:${row.filePath}:`)) {
            errors.push('anchorNodeId identity path must match origin.filePath');
        }
        if (typeof ref.anchorNodeId === 'string'
            && typeof ref.relationHint === 'string'
            && RELATION_SET.has(ref.relationHint)
            && (ref.edgeOrientation === 'anchor-to-target' || ref.edgeOrientation === 'target-to-anchor')
            && typeof ref.rawTargetName === 'string'
            && typeof row.filePath === 'string'
            && Number.isInteger(row.line)
            && Number.isInteger(row.column)
            && typeof ref.refKey === 'string') {
            const expectedKey = makeStructuralReferenceKey({
                normalizedOriginPath: row.filePath,
                anchorNodeId: ref.anchorNodeId,
                relationHint: ref.relationHint,
                edgeOrientation: ref.edgeOrientation,
                rawTargetName: ref.rawTargetName,
                line: Number(row.line),
                column: Number(row.column),
            });
            if (ref.refKey !== expectedKey)
                errors.push('refKey does not match structural reference identity');
        }
    }
    return { ok: errors.length === 0, errors };
}
function isCanonicalIdentityPath(value) {
    if (value.startsWith('@external/')) {
        const segments = value.split('/').slice(1);
        return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
    }
    if (!isAbsolute(value))
        return false;
    const posixValue = toPosixPath(value);
    if (process.platform === 'win32' && value !== posixValue)
        return false;
    if (posixValue.endsWith('/'))
        return false;
    const normalized = process.platform === 'win32'
        ? win32.normalize(value).replace(/\\/g, '/')
        : posix.normalize(value);
    return normalized === posixValue;
}
export function assertStructuralReference(value) {
    const result = validateStructuralReference(value);
    if (!result.ok) {
        throw new Error(`Invalid StructuralReference: ${result.errors.join('; ')}`);
    }
}
export function validateStructuralReferenceStatus(status) {
    if (typeof status !== 'string' || !STATUS_SET.has(status)) {
        throw new Error(`Unknown structural reference status: ${String(status)}`);
    }
}
function validateStringArray(value, field, allowed, errors) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        errors.push(`${field} must be a string array`);
        return;
    }
    if (allowed) {
        for (const item of value) {
            if (!allowed.has(item))
                errors.push(`unknown ${field} value: ${item}`);
        }
    }
}
//# sourceMappingURL=structural-reference.js.map