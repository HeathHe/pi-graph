export type GraphV3ErrorCode =
	| "INVALID_SCHEMA_VERSION"
	| "INVALID_GRAPH_SPEC"
	| "INVALID_FIELD"
	| "GOVERNANCE_FIELD_FORBIDDEN"
	| "UNSUPPORTED_SIDE_EFFECT"
	| "INVALID_TASK_ID"
	| "DUPLICATE_TASK_ID"
	| "UNKNOWN_DEPENDENCY"
	| "DEPENDENCY_CYCLE"
	| "INVALID_ARTIFACT"
	| "INVALID_SCOPE"
	| "SCOPE_CONFLICT"
	| "LOCAL_WRITE_REQUIREMENTS"
	| "INVALID_VALIDATION_COMMAND"
	| "INVALID_RETRY_POLICY"
	| "RUN_ALREADY_EXISTS"
	| "INITIALIZATION_FAILED"
	| "INVALID_AUTHORIZATION"
	| "INVALID_SNAPSHOT"
	| "RUN_NEEDS_ATTENTION";

export interface GraphV3ErrorOptions {
	taskId?: string;
	field?: string;
	details?: Record<string, unknown>;
	cause?: unknown;
}

export class GraphV3Error extends Error {
	readonly code: GraphV3ErrorCode;
	readonly taskId?: string;
	readonly field?: string;
	readonly details?: Record<string, unknown>;

	constructor(code: GraphV3ErrorCode, message: string, options: GraphV3ErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "GraphV3Error";
		this.code = code;
		this.taskId = options.taskId;
		this.field = options.field;
		this.details = options.details;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			...(this.taskId ? { taskId: this.taskId } : {}),
			...(this.field ? { field: this.field } : {}),
			...(this.details ? { details: this.details } : {}),
		};
	}
}

export function graphV3Error(code: GraphV3ErrorCode, message: string, options?: GraphV3ErrorOptions): never {
	throw new GraphV3Error(code, message, options);
}
