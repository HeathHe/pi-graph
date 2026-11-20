import { type RunOperationV11, type RunOperationV12, type RunResponseDisposition, type RunResponseErrorCode, type RunResponseErrorCodeV11, type RunResponseErrorCodeV12, type RunResponseRead, type RunResponseV10, type RunResponseV11, type RunResponseV12 } from './protocol-schemas.js';
export interface RunResponseBaseInput {
    operation: RunResponseV10['operation'];
    request_id?: string | null;
    locator?: RunResponseV10['locator'];
    next?: RunResponseV10['next'];
    continuation?: RunResponseV10['continuation'];
    replay?: RunResponseV10['replay'];
}
export interface RunResponseV11BaseInput {
    schema_version: 'run-response/1.1';
    operation: RunOperationV11;
    request_id?: string | null;
    locator?: RunResponseV11['locator'];
    fence?: RunResponseV11['fence'];
    next?: RunResponseV11['next'];
    continuation?: RunResponseV11['continuation'];
    replay?: RunResponseV11['replay'];
    warnings?: RunResponseV11['warnings'];
}
export interface RunResponseV12BaseInput {
    schema_version: 'run-response/1.2';
    operation: RunOperationV12;
    request_id?: string | null;
    locator?: RunResponseV12['locator'];
    revision?: RunResponseV12['revision'];
    replay?: RunResponseV12['replay'];
    warnings?: RunResponseV12['warnings'];
}
/** Prefer typed domain codes, then map legacy message-only errors deterministically. */
export declare function stableRunResponseErrorCode(error: unknown): RunResponseErrorCode;
/** V1.1 mapping recognizes execution/lease codes before falling back to legacy mappings. */
export declare function stableRunResponseErrorCodeV11(error: unknown): RunResponseErrorCodeV11;
/** V1.2 mapping recognizes entity-revision errors without importing Execution-era codes. */
export declare function stableRunResponseErrorCodeV12(error: unknown): RunResponseErrorCodeV12;
export declare function createRunResponseSuccess(input: RunResponseBaseInput & {
    result: unknown;
}): RunResponseV10;
export declare function createRunResponseSuccess(input: RunResponseV11BaseInput & {
    result: unknown;
}): RunResponseV11;
export declare function createRunResponseSuccess(input: RunResponseV12BaseInput & {
    result: unknown;
}): RunResponseV12;
interface RunResponseErrorBaseInput {
    exit_code: 1 | 2 | 3;
    message: string;
    details?: Record<string, unknown>;
}
export interface RunResponseV12ConflictInput {
    target_type: NonNullable<RunResponseV12['error']>['target_type'];
    target_id: string;
    expected_revision: number;
    current_revision: number;
    changed_by: string;
    next_actions: string[];
}
export declare function createRunResponseError(input: RunResponseBaseInput & RunResponseErrorBaseInput & {
    code: RunResponseErrorCode;
}): RunResponseV10;
export declare function createRunResponseError(input: RunResponseV11BaseInput & RunResponseErrorBaseInput & {
    code: RunResponseErrorCodeV11;
    disposition: Exclude<RunResponseDisposition, 'success'>;
    retryable?: boolean;
    recovery_command?: string | null;
}): RunResponseV11;
export declare function createRunResponseError(input: RunResponseV12BaseInput & RunResponseErrorBaseInput & {
    code: RunResponseErrorCodeV12;
    disposition: Exclude<RunResponseDisposition, 'success'>;
    retryable?: boolean;
    conflict?: RunResponseV12ConflictInput;
    next_actions?: string[];
}): RunResponseV12;
/** Remove raw lease tokens before logging, persistence, UI projection, or transcript capture. */
export declare function redactRunResponseLeaseTokens<T extends RunResponseRead>(response: T): T;
/** Validate before writing so machine mode never emits a partial envelope. */
export declare function emitRunResponse(response: RunResponseRead, options?: {
    redactLeaseTokens?: boolean;
}): void;
export { runResponseSchema, runResponseV10Schema, runResponseV11Schema, runResponseV12Schema, type RunResponse, type RunResponseErrorCode, type RunResponseErrorCodeV11, type RunResponseRead, type RunResponseV10, type RunResponseV11, type RunResponseV12, } from './protocol-schemas.js';
//# sourceMappingURL=response.d.ts.map