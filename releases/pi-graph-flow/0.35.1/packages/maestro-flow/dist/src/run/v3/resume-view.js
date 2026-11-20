import { resumeMapV1Schema, } from '../protocol-schemas.js';
import { runV30ReadSchema, sessionStateV30ReadSchema, } from '../schemas.js';
import { sha256Digest, stableJsonUtf8 } from '../transition-receipts.js';
export const RESUME_MAP_MAX_UTF8_BYTES = 2048;
export class ResumeMapProjectionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResumeMapProjectionError';
    }
}
function compareText(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function uniqueSorted(values) {
    return [...new Set(values)].sort(compareText);
}
function forbiddenFieldName(key) {
    const normalized = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
    return normalized.includes('execution')
        || normalized.includes('generation')
        || normalized.includes('lease')
        || normalized.includes('operation');
}
/** Deep field-name guard used in addition to the strict ResumeMapV1 schema. */
export function assertResumeMapHasNoForbiddenFields(value) {
    const seen = new WeakSet();
    const visit = (item) => {
        if (item === null || typeof item !== 'object' || seen.has(item))
            return;
        seen.add(item);
        if (Array.isArray(item)) {
            for (const child of item)
                visit(child);
            return;
        }
        for (const [key, child] of Object.entries(item)) {
            if (forbiddenFieldName(key)) {
                throw new ResumeMapProjectionError(`ResumeMapV1 contains forbidden field name: ${key}`);
            }
            visit(child);
        }
    };
    visit(value);
}
export function computeResumeMapFingerprint(map) {
    return sha256Digest(stableJsonUtf8(map));
}
export function resumeMapUtf8Bytes(map) {
    return Buffer.byteLength(JSON.stringify(map), 'utf8');
}
function finalize(body) {
    const parsed = resumeMapV1Schema.parse({
        ...body,
        fingerprint: computeResumeMapFingerprint(body),
    });
    assertResumeMapHasNoForbiddenFields(parsed);
    return parsed;
}
export function verifyResumeMapFingerprint(value) {
    const parsed = resumeMapV1Schema.safeParse(value);
    if (!parsed.success)
        return false;
    try {
        assertResumeMapHasNoForbiddenFields(parsed.data);
    }
    catch {
        return false;
    }
    const { fingerprint, ...body } = parsed.data;
    return fingerprint === computeResumeMapFingerprint(body);
}
function canonicalRuns(session, runs) {
    const activeIds = new Set(session.active_run_ids);
    const selected = new Map();
    for (const candidate of runs.map(run => runV30ReadSchema.parse(run))) {
        if (!activeIds.has(candidate.run_id) || candidate.session_id !== session.session_id)
            continue;
        const current = selected.get(candidate.run_id);
        if (!current
            || candidate.revision > current.revision
            || (candidate.revision === current.revision
                && stableJsonUtf8(candidate) < stableJsonUtf8(current))) {
            selected.set(candidate.run_id, candidate);
        }
    }
    const missing = uniqueSorted(session.active_run_ids)
        .filter(runId => !selected.has(runId));
    if (missing.length > 0) {
        throw new ResumeMapProjectionError(`Active Run documents are missing or belong to another Session: ${missing.join(', ')}`);
    }
    return [...selected.values()]
        .map(run => ({
        runId: run.run_id,
        stepId: run.step_id,
        status: run.status,
        revision: run.revision,
    }))
        .sort((left, right) => compareText(left.runId, right.runId));
}
function canonicalPublications(values) {
    const selected = new Map();
    for (const value of values) {
        const candidate = value.resourceUri === undefined
            ? { publicationId: value.publicationId }
            : { publicationId: value.publicationId, resourceUri: value.resourceUri };
        const current = selected.get(candidate.publicationId);
        if (!current
            || (current.resourceUri === undefined && candidate.resourceUri !== undefined)
            || (current.resourceUri !== undefined && candidate.resourceUri !== undefined
                && compareText(candidate.resourceUri, current.resourceUri) < 0)) {
            selected.set(candidate.publicationId, candidate);
        }
    }
    return [...selected.values()]
        .sort((left, right) => compareText(left.publicationId, right.publicationId));
}
function actionMatchesAuthority(action, session, runs) {
    if (action.targetId === session.session_id) {
        // The retired identity_revision merged into orchestration_revision: the
        // Session authority revision is the single CAS target now.
        return action.expectedRevision === session.orchestration_revision;
    }
    const run = runs.find(candidate => candidate.runId === action.targetId);
    return run !== undefined && action.expectedRevision === run.revision;
}
function canonicalActions(values, session, runs) {
    const selected = new Map();
    for (const value of values) {
        if (!actionMatchesAuthority(value, session, runs))
            continue;
        const candidate = {
            action: value.action,
            targetId: value.targetId,
            expectedRevision: value.expectedRevision,
        };
        const key = `${candidate.targetId}\0${candidate.action}`;
        const current = selected.get(key);
        if (!current || candidate.expectedRevision > current.expectedRevision) {
            selected.set(key, candidate);
        }
    }
    return [...selected.values()].sort((left, right) => (compareText(left.targetId, right.targetId)
        || compareText(left.action, right.action)
        || left.expectedRevision - right.expectedRevision));
}
function tryFinalize(body) {
    const map = finalize(body);
    return resumeMapUtf8Bytes(map) <= RESUME_MAP_MAX_UTF8_BYTES ? map : null;
}
/**
 * Pure Session/Run projection. Stable IDs are runId, the string value for
 * blockers/decisions, publicationId, and (targetId, action) for actions.
 * Duplicate Run IDs select the highest revision (canonical JSON breaks
 * equal-revision ties); other arrays deduplicate by their stable ID, and action
 * duplicates select the highest authority-valid revision.
 */
export function projectResumeMapV1(input) {
    // Read-tolerant parse: the typed input is already canonical, but old
    // documents may still carry retired keys (identity_revision, gates_ref).
    const session = sessionStateV30ReadSchema.parse(input.session);
    const activeRuns = canonicalRuns(session, input.runs);
    const fullBody = {
        sessionId: session.session_id,
        sessionStatus: session.status,
        orchestrationRevision: session.orchestration_revision,
        activityRevision: session.activity_revision,
        activeRuns,
        blockingGates: uniqueSorted(input.blockingGates),
        openDecisions: uniqueSorted(input.openDecisions),
        pendingPublications: canonicalPublications(input.pendingPublications),
        nextActions: canonicalActions(input.nextActions, session, activeRuns),
    };
    const complete = tryFinalize(fullBody);
    if (complete === null) {
        throw new ResumeMapProjectionError(`ResumeMapV1 exceeds ${RESUME_MAP_MAX_UTF8_BYTES} UTF-8 bytes (projected ${resumeMapUtf8Bytes(finalize(fullBody))} bytes); the projection refuses to truncate authority data`);
    }
    return complete;
}
//# sourceMappingURL=resume-view.js.map