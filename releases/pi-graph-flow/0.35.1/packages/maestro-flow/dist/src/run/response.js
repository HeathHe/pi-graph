import { runErrorCodeSchema, runErrorCodeV11Schema, runErrorCodeV12Schema, runResponseSchema, runResponseV10Schema, runResponseV11Schema, runResponseV12Schema, } from './protocol-schemas.js';
/** Prefer typed domain codes, then map legacy message-only errors deterministically. */
export function stableRunResponseErrorCode(error) {
    const typedCode = error?.code;
    const parsedCode = runErrorCodeSchema.safeParse(typedCode);
    if (parsedCode.success)
        return parsedCode.data;
    const message = error instanceof Error ? error.message : String(error);
    if (/Run not found/i.test(message))
        return 'RUN_NOT_FOUND';
    if (/session not found/i.test(message))
        return 'SESSION_NOT_FOUND';
    if (/ambiguous/i.test(message))
        return 'SESSION_AMBIGUOUS';
    if (/lease (?:conflict|is owned)|owner epoch|lease id/i.test(message))
        return 'LEASE_CONFLICT';
    if (/stale (?:identity|activity) revision/i.test(message))
        return 'FENCE_CONFLICT';
    if (/unresolved escalated decision|unresolved failed chain step|expected "paused"/i.test(message))
        return 'RESUME_REQUIRED';
    if (/running chain step/i.test(message))
        return 'RUNNING_STEP';
    if (/decision point not found|decision .* is (?:already|not escalated)/i.test(message))
        return 'DECISION_REQUIRED';
    if (/chain step not found/i.test(message))
        return 'PICK_NOT_FOUND';
    if (/only pending steps|chain step .* is not failed/i.test(message))
        return 'PICK_NOT_PENDING';
    if (/unsealed Runs|claimed requests|Session gates are not complete/i.test(message))
        return 'SESSION_SEAL_BLOCKED';
    if (/(unknown|invalid).*platform|platform.*(unknown|invalid)/i.test(message))
        return 'PLATFORM_INVALID';
    if (/platform.*(mismatch|conflict)/i.test(message))
        return 'PLATFORM_CONFLICT';
    if (/contract.*drift/i.test(message))
        return 'CONTRACT_DRIFT';
    if (/chain[- ]proposal/i.test(message))
        return 'CHAIN_PROPOSAL_INVALID';
    if (/immutable/i.test(message))
        return 'RUN_IMMUTABLE';
    if (/confirmation token not found|invalid confirmation token/i.test(message))
        return 'TOKEN_INVALID';
    if (/expired/i.test(message))
        return 'TOKEN_EXPIRED';
    if (/already consumed/i.test(message))
        return 'TOKEN_REPLAYED';
    if (/request mismatch|different action or request/i.test(message))
        return 'REQUEST_CONFLICT';
    if (/required|invalid|must be|cannot insert|at least one|only one block/i.test(message))
        return 'INVALID_ARGUMENT';
    return 'INTERNAL_ERROR';
}
/** V1.1 mapping recognizes execution/lease codes before falling back to legacy mappings. */
export function stableRunResponseErrorCodeV11(error) {
    const typedCode = error?.code;
    const parsedCode = runErrorCodeV11Schema.safeParse(typedCode);
    if (parsedCode.success)
        return parsedCode.data;
    const message = error instanceof Error ? error.message : String(error);
    if (/execution not found/i.test(message))
        return 'EXECUTION_NOT_FOUND';
    if (/execution .*sealed/i.test(message))
        return 'EXECUTION_SEALED';
    if (/execution .*paused/i.test(message))
        return 'EXECUTION_PAUSED';
    if (/stale execution revision|execution revision conflict/i.test(message))
        return 'EXECUTION_REVISION_CONFLICT';
    if (/handoff.*in progress/i.test(message))
        return 'LEASE_HANDOFF_IN_PROGRESS';
    if (/handoff token/i.test(message))
        return 'LEASE_HANDOFF_TOKEN_INVALID';
    if (/stale.*(?:recover|takeover)|recovery required/i.test(message))
        return 'LEASE_STALE_RECOVERY_REQUIRED';
    if (/lease.*busy|lease is owned/i.test(message))
        return 'LEASE_BUSY';
    if (/lease.*(?:epoch|token|fence)|owner epoch|lease id/i.test(message))
        return 'LEASE_FENCE_CONFLICT';
    if (/session.*archived/i.test(message))
        return 'SESSION_ARCHIVED';
    return stableRunResponseErrorCode(error);
}
/** V1.2 mapping recognizes entity-revision errors without importing Execution-era codes. */
export function stableRunResponseErrorCodeV12(error) {
    const typedCode = error?.code;
    const parsedCode = runErrorCodeV12Schema.safeParse(typedCode);
    if (parsedCode.success)
        return parsedCode.data;
    const message = error instanceof Error ? error.message : String(error);
    if (/run revision conflict|stale run revision/i.test(message))
        return 'RUN_REVISION_CONFLICT';
    if (/orchestration revision conflict|stale orchestration revision/i.test(message)) {
        return 'ORCHESTRATION_REVISION_CONFLICT';
    }
    if (/session\/3\.0|session schema unsupported/i.test(message))
        return 'SESSION_SCHEMA_UNSUPPORTED';
    if (/store (?:is )?busy|sessionstore locked/i.test(message))
        return 'STORE_BUSY';
    if (/participant.*required/i.test(message))
        return 'PARTICIPANT_REQUIRED';
    return stableRunResponseErrorCode(error);
}
export function createRunResponseSuccess(input) {
    if ('schema_version' in input && input.schema_version === 'run-response/1.2') {
        return runResponseV12Schema.parse({
            schema_version: 'run-response/1.2',
            operation: input.operation,
            ok: true,
            exit_code: 0,
            disposition: 'success',
            request_id: input.request_id ?? null,
            locator: input.locator ?? null,
            revision: input.revision ?? null,
            replay: input.replay ?? null,
            warnings: input.warnings ?? [],
            result: input.result,
            error: null,
        });
    }
    if ('schema_version' in input && input.schema_version === 'run-response/1.1') {
        return runResponseV11Schema.parse({
            schema_version: 'run-response/1.1',
            operation: input.operation,
            ok: true,
            exit_code: 0,
            disposition: 'success',
            request_id: input.request_id ?? null,
            locator: input.locator ?? null,
            fence: input.fence ?? null,
            result: input.result,
            next: input.next ?? null,
            continuation: input.continuation ?? null,
            replay: input.replay ?? null,
            warnings: input.warnings ?? [],
            error: null,
        });
    }
    return runResponseV10Schema.parse({
        schema_version: 'run-response/1.0',
        operation: input.operation,
        ok: true,
        exit_code: 0,
        request_id: input.request_id ?? null,
        locator: input.locator ?? null,
        result: input.result,
        next: input.next ?? null,
        continuation: input.continuation ?? null,
        error: null,
        replay: input.replay ?? null,
    });
}
export function createRunResponseError(input) {
    if ('schema_version' in input && input.schema_version === 'run-response/1.2') {
        const conflict = input.conflict;
        return runResponseV12Schema.parse({
            schema_version: 'run-response/1.2',
            operation: input.operation,
            ok: false,
            exit_code: input.exit_code,
            disposition: input.disposition,
            request_id: input.request_id ?? null,
            locator: input.locator ?? null,
            revision: input.revision ?? null,
            replay: input.replay ?? null,
            warnings: input.warnings ?? [],
            result: null,
            error: {
                code: input.code,
                message: input.message,
                retryable: input.retryable ?? false,
                details: input.details ?? {},
                target_type: conflict?.target_type ?? null,
                target_id: conflict?.target_id ?? null,
                expected_revision: conflict?.expected_revision ?? null,
                current_revision: conflict?.current_revision ?? null,
                changed_by: conflict?.changed_by ?? null,
                next_actions: conflict?.next_actions ?? input.next_actions ?? [],
            },
        });
    }
    if ('schema_version' in input && input.schema_version === 'run-response/1.1') {
        return runResponseV11Schema.parse({
            schema_version: 'run-response/1.1',
            operation: input.operation,
            ok: false,
            exit_code: input.exit_code,
            disposition: input.disposition,
            request_id: input.request_id ?? null,
            locator: input.locator ?? null,
            fence: input.fence ?? null,
            result: null,
            next: input.next ?? null,
            continuation: input.continuation ?? null,
            replay: input.replay ?? null,
            warnings: input.warnings ?? [],
            error: {
                code: input.code,
                message: input.message,
                retryable: input.retryable ?? false,
                details: input.details ?? {},
                recovery_command: input.recovery_command ?? null,
            },
        });
    }
    return runResponseV10Schema.parse({
        schema_version: 'run-response/1.0',
        operation: input.operation,
        ok: false,
        exit_code: input.exit_code,
        request_id: input.request_id ?? null,
        locator: input.locator ?? null,
        result: null,
        next: input.next ?? null,
        continuation: input.continuation ?? null,
        error: {
            code: input.code,
            message: input.message,
            details: input.details ?? {},
        },
        replay: input.replay ?? null,
    });
}
function redactLeaseIds(value) {
    if (Array.isArray(value))
        return value.map(redactLeaseIds);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'lease_id')
        .map(([key, item]) => [key, redactLeaseIds(item)]));
}
/** Remove raw lease tokens before logging, persistence, UI projection, or transcript capture. */
export function redactRunResponseLeaseTokens(response) {
    const validated = runResponseSchema.parse(response);
    return runResponseSchema.parse(redactLeaseIds(validated));
}
/** Validate before writing so machine mode never emits a partial envelope. */
export function emitRunResponse(response, options = {}) {
    const validated = runResponseSchema.parse(response);
    const output = options.redactLeaseTokens ? redactRunResponseLeaseTokens(validated) : validated;
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = output.exit_code;
}
export { runResponseSchema, runResponseV10Schema, runResponseV11Schema, runResponseV12Schema, } from './protocol-schemas.js';
//# sourceMappingURL=response.js.map