import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InvalidArgumentError } from 'commander';
import { createRunResponseError, createRunResponseSuccess, emitRunResponse, stableRunResponseErrorCodeV12 } from '../run/response.js';
import { sessionStateV30Schema } from '../run/schemas.js';
import { SessionStore } from '../run/store.js';
import { createRevisionConflictError, V3StructuredError } from '../run/v3/errors.js';
import { sessionContextErrorToV3Error } from '../run/v3/resolve-context.js';
import { resolveSessionContextFromStore } from '../run/v3/resolve-context-store.js';
import { canonicalPayloadHash, createRequestReceipt, createTransitionReceipt, replayRequestReceipt, transitionReceiptRef, } from '../run/v3/receipts.js';
import { transitionSession } from '../run/v3/session-machine.js';
export function collectV3(value, previous = []) {
    return [...previous, value];
}
export function parseV3Revision(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new InvalidArgumentError('revision must be a non-negative safe integer');
    }
    return parsed;
}
export function addV3ReadOptions(command) {
    return command
        .option('--session <id>', 'exact Session ID')
        .option('--json', 'emit run-response/1.2 JSON')
        .option('--workflow-root <path>', 'project root containing .workflow', process.cwd());
}
export function assertV3ParticipantIdentity(options) {
    if (options.participant !== options.actor) {
        throw new V3StructuredError('INVALID_ARGUMENT', '--participant must equal --actor for the session/3.0 participant identity contract');
    }
}
export function applyV3MutationIdentityDefaults(thisCommand) {
    const opts = thisCommand.opts();
    // An explicit --participant wins over $MAESTRO_ACTOR for --actor's default:
    // the participant/actor equality contract then still validates a caller
    // that mixed explicit identities.
    if (!opts.actor) {
        const envActor = process.env.MAESTRO_ACTOR?.trim();
        opts.actor = opts.participant ?? (envActor ? envActor : undefined);
    }
    if (!opts.participant)
        opts.participant = opts.actor;
    if (!opts.actor) {
        thisCommand.error("error: required option '--actor <id>' not specified (or set MAESTRO_ACTOR)", { code: 'commander.missingMandatoryOptionValue' });
    }
    const commandPath = [thisCommand.parent?.name(), thisCommand.name()]
        .filter((part) => Boolean(part))
        .join(' ');
    if (!opts.reason)
        opts.reason = `cli:${commandPath}`;
    if (!opts.requestId) {
        // Deterministic idempotency key: the same invocation retried verbatim
        // derives the same request ID and replays; any changed input (including
        // positional args like <run-id> or a different --summary) produces a
        // different key. Explicit --request-id is untouched.
        const fingerprint = JSON.stringify({
            command: commandPath,
            args: thisCommand.processedArgs,
            opts,
        });
        opts.requestId = `cli-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
    }
}
export function addV3MutationOptions(command, target) {
    // Identity/context flags carry safe defaults so a mutation needs only its
    // revision fence: --participant falls back to --actor, --actor to
    // $MAESTRO_ACTOR, --reason to "cli:<command>", --request-id to a hash of the
    // invocation (identical retries replay instead of duplicating), and
    // --session resolves through the standard unique-open/current-binding path
    // in resolveV3Options.
    const configured = command
        .option('--session <id>', 'Session ID (default: unique open Session or current binding)')
        .option('--json', 'emit run-response/1.2 JSON')
        .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
        .option('--participant <id>', 'participant performing the mutation (default: --actor)')
        .option('--actor <id>', 'authorized actor (default: $MAESTRO_ACTOR)')
        .option('--request-id <id>', 'idempotency request ID (default: derived from the invocation)')
        .option('--reason <text>', 'audit reason (default: cli:<command>)')
        .option('--evidence <ref>', 'evidence reference (repeatable)', collectV3, []);
    const revised = target === 'run'
        ? configured.requiredOption('--expected-run-revision <n>', 'expected Run revision', parseV3Revision)
        : configured.requiredOption('--expected-orchestration-revision <n>', 'expected Session orchestration revision', parseV3Revision);
    revised.hook('preAction', applyV3MutationIdentityDefaults);
    // Report every missing mandatory option in one error instead of forcing
    // callers to discover them one retry at a time.
    revised
        .missingMandatoryOptionValue = function (option) {
        const missing = this.options
            .filter(o => o.mandatory && this.getOptionValue(o.attributeName()) === undefined)
            .map(o => o.flags);
        this.error(`error: required option${missing.length > 1 ? 's' : ''} ${missing.map(f => `'${f}'`).join(', ')} not specified\n`
            + '  optional with defaults: --session, --participant (= --actor), '
            + '--actor ($MAESTRO_ACTOR), --request-id (derived), --reason (cli:<command>)');
    };
    return revised;
}
export function v3Store(options) {
    const store = new SessionStore(resolve(options.workflowRoot));
    const writer = store.sessionSchemaSelection().writer;
    if (writer !== 'session/3.0') {
        throw new V3StructuredError('SESSION_SCHEMA_UNSUPPORTED', 'command requires the session/3.0 writer', {
            details: { writer },
            next_actions: ['select-session/3.0-writer'],
        });
    }
    return store;
}
export function resolveV3Options(options) {
    if ('participant' in options && 'actor' in options
        && typeof options.participant === 'string' && typeof options.actor === 'string') {
        assertV3ParticipantIdentity({ participant: options.participant, actor: options.actor });
    }
    const store = v3Store(options);
    const result = resolveSessionContextFromStore(store, { explicit_session_id: options.session });
    if (!result.ok)
        throw sessionContextErrorToV3Error(result.error);
    const resolvedOptions = options;
    resolvedOptions.session = result.session_id;
    return { store, options: resolvedOptions };
}
export function mutationIdentity(options) {
    assertV3ParticipantIdentity(options);
    return {
        sessionId: options.session,
        actorId: options.actor,
        requestId: options.requestId,
        reason: options.reason,
        evidenceRefs: options.evidence,
    };
}
function responseRevision(receipt) {
    return {
        target_type: receipt.target_type,
        target_id: receipt.target_id,
        revision: receipt.revision_after,
    };
}
export function emitV3Success(input) {
    // `result` is schema-free (z.unknown()), so object results can carry a
    // grep-friendly one-line summary without touching the strict envelope.
    // Callers get session/run/revision/next without JSON-parsing the payload.
    let result = input.result;
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
        const record = result;
        const nextCommand = (() => {
            const readCommand = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
                && typeof value.command === 'string'
                ? value.command
                : null;
            const direct = readCommand(record.next);
            if (direct)
                return direct;
            return readCommand(record.continuation?.next);
        })();
        const summaryLine = [
            `${input.operation} ok`,
            input.sessionId ? `session=${input.sessionId}` : null,
            input.runId ? `run=${input.runId}` : null,
            input.mutation ? `rev=${input.mutation.transition.revision_after}` : null,
            input.requestId ? `req=${input.requestId}` : null,
            nextCommand ? `next="${nextCommand}"` : null,
        ].filter((part) => Boolean(part)).join(' · ');
        result = { summary_line: summaryLine, ...record };
    }
    emitRunResponse(createRunResponseSuccess({
        schema_version: 'run-response/1.2',
        operation: input.operation,
        request_id: input.requestId ?? null,
        locator: { session_id: input.sessionId, run_id: input.runId ?? null },
        revision: input.mutation ? responseRevision(input.mutation.transition) : null,
        replay: input.mutation
            ? { status: input.mutation.status, transition_id: input.mutation.transition.transition_id }
            : null,
        warnings: [],
        result,
    }));
}
export function emitV3Error(operation, error, options) {
    const structured = error instanceof V3StructuredError ? error : null;
    const code = structured?.code ?? stableRunResponseErrorCodeV12(error);
    const conflict = structured && structured.target_type && structured.target_id
        && structured.expected_revision !== null && structured.current_revision !== null && structured.changed_by
        ? {
            target_type: structured.target_type,
            target_id: structured.target_id,
            expected_revision: structured.expected_revision,
            current_revision: structured.current_revision,
            changed_by: structured.changed_by,
            next_actions: [...structured.next_actions],
        }
        : undefined;
    emitRunResponse(createRunResponseError({
        schema_version: 'run-response/1.2',
        operation,
        exit_code: 1,
        disposition: 'domain_error',
        code,
        message: error instanceof Error ? error.message : String(error),
        details: structured ? { ...structured.details } : {},
        retryable: structured?.retryable ?? code === 'STORE_BUSY',
        conflict,
        next_actions: structured ? [...structured.next_actions] : [],
        request_id: options.requestId ?? null,
        locator: { session_id: options.session ?? null, run_id: options.runId ?? null },
        revision: null,
        replay: null,
        warnings: [],
    }));
}
function retiredNextAction(replacement) {
    const words = replacement
        .replace(/^maestro\s+/, '')
        .replace(/\s*[[<].*$/s, '')
        .trim()
        .split(/\s+/);
    return `use-${words.join('-')}`;
}
/**
 * Retired v2 command names stay routable on the session/3.0 surface: the stub
 * prints a human hint on stderr AND emits a run-response/1.2
 * SESSION_SCHEMA_UNSUPPORTED envelope on stdout carrying the replacement,
 * matching the retired Execution command family.
 */
export function registerV3RetiredStub(parent, commandName, operation, replacement) {
    const commandPath = operation.replaceAll('-', ' ');
    parent.command(`${commandName} [args...]`, { hidden: true })
        .allowUnknownOption()
        .option('--session <id>', 'Session ID')
        .option('--request-id <id>', 'request ID')
        .option('--json', 'emit run-response/1.2 JSON')
        .option('--workflow-root <path>', 'project root containing .workflow', process.cwd())
        .action(function () {
        const options = this.opts();
        console.error(`Error: 'maestro ${commandPath}' is retired. Use '${replacement}' instead.`);
        emitV3Error(operation, new V3StructuredError('SESSION_SCHEMA_UNSUPPORTED', `maestro ${commandPath} is retired for session/3.0 workspaces`, {
            details: { deprecated_command: commandPath, replacement_command: replacement },
            next_actions: [retiredNextAction(replacement)],
        }), { session: options.session, requestId: options.requestId });
    });
}
export function mutateSessionStatusV3(store, options, toStatus, operation = toStatus === 'archived'
    ? 'session-archive'
    : 'session-unarchive') {
    const recordedAt = new Date().toISOString();
    const payload = {
        operation,
        expected_orchestration_revision: options.expectedOrchestrationRevision,
        to_status: toStatus,
        actor_id: options.actor,
        reason: options.reason,
        evidence_refs: [...options.evidence].sort(),
    };
    const payloadHash = canonicalPayloadHash(payload);
    return store.withV30Transaction(options.session, tx => {
        const replayed = replayRequestReceipt({
            tx,
            sessionId: options.session,
            requestId: options.requestId,
            participantId: options.actor,
            payloadHash,
        });
        if (replayed)
            return { status: 'replayed', transition: replayed };
        const session = tx.readSession();
        const expected = options.expectedOrchestrationRevision;
        if (expected === undefined)
            throw new V3StructuredError('INVALID_ARGUMENT', 'expected orchestration revision is required');
        if (session.orchestration_revision !== expected) {
            throw createRevisionConflictError({
                code: 'ORCHESTRATION_REVISION_CONFLICT',
                targetType: 'orchestration',
                targetId: session.session_id,
                expectedRevision: expected,
                currentRevision: session.orchestration_revision,
                changedBy: 'unknown',
            });
        }
        const transitioned = transitionSession(session, toStatus);
        const nextSession = {
            ...transitioned,
            orchestration_revision: session.orchestration_revision + 1,
            activity_revision: session.activity_revision + 1,
            updated_at: recordedAt,
            archived_at: toStatus === 'archived'
                ? recordedAt
                : operation === 'session-unarchive'
                    ? null
                    : session.archived_at,
        };
        const transition = createTransitionReceipt({
            transitionId: `tr_${randomUUID()}`,
            requestId: options.requestId,
            sessionId: options.session,
            activityRevision: nextSession.activity_revision,
            targetType: 'orchestration',
            targetId: options.session,
            revisionBefore: session.orchestration_revision,
            revisionAfter: nextSession.orchestration_revision,
            actorId: options.actor,
            participantId: options.actor,
            reason: options.reason,
            evidenceRefs: options.evidence,
            recordedAt,
            result: { status: nextSession.status, orchestration_revision: nextSession.orchestration_revision },
        });
        tx.writeSession(nextSession);
        tx.writeTransitionReceipt(transition);
        tx.writeRequestReceipt(createRequestReceipt({
            requestId: options.requestId,
            participantId: options.actor,
            payloadHash,
            transitionReceiptRef: transitionReceiptRef(transition.activity_revision, transition.transition_id),
        }));
        return { status: 'applied', transition };
    });
}
/**
 * Enumerate every canonical session/3.0 session.json under .workflow/sessions/.
 * Read-only: no lock acquisition, no recovery writes, no projection writes.
 * Non-v3 and unreadable entries are skipped so a listing never fails the batch.
 */
export function listV3Sessions(store) {
    if (!existsSync(store.sessionsRoot))
        return [];
    const sessions = [];
    for (const name of readdirSync(store.sessionsRoot).sort()) {
        const path = join(store.sessionsRoot, name, 'session.json');
        if (!existsSync(path))
            continue;
        try {
            const raw = JSON.parse(readFileSync(path, 'utf8'));
            if (typeof raw !== 'object' || raw === null)
                continue;
            if (raw.schema_version !== 'session/3.0')
                continue;
            sessions.push(sessionStateV30Schema.parse(raw));
        }
        catch {
            // skip corrupt or non-v3 session files
        }
    }
    return sessions;
}
/**
 * Enumerate every non-session/3.0 session.json under .workflow/sessions/ as a
 * batch migration candidate. Read-only: no lock acquisition, no writes.
 * Unreadable or path-mismatched entries are skipped so a batch migration never
 * fails on a corrupt sibling; every readable entry whose schema_version is not
 * session/3.0 is returned and its individual migration attempt may still fail
 * and be recorded per-session by the caller.
 */
export function listLegacyV3MigrationCandidates(store) {
    if (!existsSync(store.sessionsRoot))
        return [];
    const candidates = [];
    for (const name of readdirSync(store.sessionsRoot).sort()) {
        const path = join(store.sessionsRoot, name, 'session.json');
        if (!existsSync(path))
            continue;
        try {
            const raw = JSON.parse(readFileSync(path, 'utf8'));
            if (typeof raw !== 'object' || raw === null)
                continue;
            const schemaVersion = raw.schema_version;
            if (typeof schemaVersion !== 'string' || schemaVersion === 'session/3.0')
                continue;
            if (raw.session_id !== name)
                continue;
            candidates.push({ session_id: name, source_schema_version: schemaVersion });
        }
        catch {
            // skip corrupt or unreadable session files
        }
    }
    return candidates;
}
//# sourceMappingURL=v3-cli-shared.js.map