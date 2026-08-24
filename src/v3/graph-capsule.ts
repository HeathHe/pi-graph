import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { compileGraphSpecV3 } from "./compiler.ts";
import { canonicalJson } from "./digests.ts";
import type { CompiledGraphV3, GraphSpecV3 } from "./types.ts";

export const V3_GRAPH_CAPSULE_SUFFIX = ".graph.json" as const;
export const V3_GRAPH_CAPSULE_MAX_BYTES = 1_048_576;

export type V3GraphCapsuleInputType = "string" | "number" | "boolean";
export type V3GraphCapsuleInputValue = string | number | boolean;
export type V3GraphCapsuleErrorCode =
	| "INVALID_CAPSULE"
	| "INVALID_CAPSULE_PATH"
	| "CAPSULE_READ_FAILED"
	| "CAPSULE_TOO_LARGE"
	| "CAPSULE_CHANGED"
	| "INVALID_CAPSULE_JSON"
	| "INVALID_CAPSULE_INPUT"
	| "INVALID_CAPSULE_PLACEHOLDER";

export interface V3GraphCapsuleManifest {
	name: string;
	version: string;
	description: string;
}

export interface V3GraphCapsuleInputDeclaration {
	type: V3GraphCapsuleInputType;
	required: boolean;
	default?: V3GraphCapsuleInputValue;
	description?: string;
}

export interface V3GraphCapsuleRequirements {
	readOnly: boolean;
	toolFilter: string[];
}

export interface V3GraphCapsuleProvenance {
	created: string;
	author?: string;
	source?: string;
}

export interface V3GraphCapsule {
	manifest: V3GraphCapsuleManifest;
	source: {
		type: "graph-spec";
		/** May contain typed {{input}} placeholders and is compiled only after resolution. */
		spec: Record<string, unknown>;
	};
	intent: string;
	inputs: Record<string, V3GraphCapsuleInputDeclaration>;
	requires: V3GraphCapsuleRequirements;
	provenance?: V3GraphCapsuleProvenance;
}

export type V3ResolvedGraphCapsuleInputs = Readonly<Record<string, V3GraphCapsuleInputValue>>;

export interface V3CompiledGraphCapsule {
	capsule: V3GraphCapsule;
	inputs: V3ResolvedGraphCapsuleInputs;
	spec: GraphSpecV3;
	compiled: CompiledGraphV3;
}

export interface V3GraphCapsuleLoadOptions {
	/** A caller may lower, but not raise, the core's one-MiB resource ceiling. */
	maxBytes?: number;
}

/** Injectable observation seam used to verify that path replacement is detected. */
export interface V3GraphCapsuleReadDependencies {
	afterOpen?: (path: string) => void | Promise<void>;
}

export class V3GraphCapsuleError extends Error {
	readonly code: V3GraphCapsuleErrorCode;
	readonly path?: string;
	readonly field?: string;

	constructor(
		code: V3GraphCapsuleErrorCode,
		message: string,
		options: { path?: string; field?: string; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "V3GraphCapsuleError";
		this.code = code;
		this.path = options.path;
		this.field = options.field;
	}
}

const CAPSULE_FIELDS = new Set(["manifest", "source", "intent", "inputs", "requires", "provenance"]);
const MANIFEST_FIELDS = new Set(["name", "version", "description"]);
const SOURCE_FIELDS = new Set(["type", "spec"]);
const INPUT_FIELDS = new Set(["type", "required", "default", "description"]);
const REQUIREMENT_FIELDS = new Set(["readOnly", "toolFilter"]);
const PROVENANCE_FIELDS = new Set(["created", "author", "source"]);
const INPUT_TYPES = new Set<V3GraphCapsuleInputType>(["string", "number", "boolean"]);
const INPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const FORBIDDEN_INPUT_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const PLACEHOLDER_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}\}/gu;
const MAX_JSON_DEPTH = 128;

function capsuleError(
	code: V3GraphCapsuleErrorCode,
	message: string,
	options?: { path?: string; field?: string; cause?: unknown },
): never {
	throw new V3GraphCapsuleError(code, `V3 graph capsule: ${message}`, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertAllowedFields(record: Record<string, unknown>, fields: ReadonlySet<string>, location: string): void {
	for (const field of Object.keys(record)) {
		if (!fields.has(field)) capsuleError("INVALID_CAPSULE", `field '${field}' is not allowed in ${location}.`, { field });
	}
}

function requiredString(
	record: Record<string, unknown>,
	field: string,
	location: string,
	maxLength: number,
): string {
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		capsuleError("INVALID_CAPSULE", `${location}.${field} must be a non-empty string.`, { field });
	}
	const normalized = value.trim();
	if (normalized.length > maxLength) {
		capsuleError("INVALID_CAPSULE", `${location}.${field} must be at most ${maxLength} characters.`, { field });
	}
	return normalized;
}

function optionalString(
	record: Record<string, unknown>,
	field: string,
	location: string,
	maxLength: number,
): string | undefined {
	return field in record ? requiredString(record, field, location, maxLength) : undefined;
}

function cloneJsonValue(value: unknown, path: string, seen = new Set<object>(), depth = 0): unknown {
	if (depth > MAX_JSON_DEPTH) capsuleError("INVALID_CAPSULE", `${path} exceeds the maximum JSON nesting depth.`, { field: path });
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) capsuleError("INVALID_CAPSULE", `${path} must not contain a non-finite number.`, { field: path });
		return value;
	}
	if (typeof value !== "object") capsuleError("INVALID_CAPSULE", `${path} must contain only JSON values.`, { field: path });
	if (seen.has(value)) capsuleError("INVALID_CAPSULE", `${path} contains a cyclic value.`, { field: path });
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`, seen, depth + 1));
		}
		if (!isRecord(value)) capsuleError("INVALID_CAPSULE", `${path} must contain only JSON objects.`, { field: path });
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
			key,
			cloneJsonValue(entry, `${path}.${key}`, seen, depth + 1),
		]));
	} finally {
		seen.delete(value);
	}
}

function valueHasType(value: unknown, type: V3GraphCapsuleInputType): value is V3GraphCapsuleInputValue {
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	return typeof value === type;
}

function normalizeInputDeclarations(value: unknown): Record<string, V3GraphCapsuleInputDeclaration> {
	if (value === undefined) return {};
	if (!isRecord(value)) capsuleError("INVALID_CAPSULE", "inputs must be an object.", { field: "inputs" });
	const output: Array<[string, V3GraphCapsuleInputDeclaration]> = [];
	for (const [name, rawDeclaration] of Object.entries(value)) {
		if (!INPUT_NAME_PATTERN.test(name) || FORBIDDEN_INPUT_NAMES.has(name)) {
			capsuleError("INVALID_CAPSULE", `input name '${name}' is invalid.`, { field: `inputs.${name}` });
		}
		if (!isRecord(rawDeclaration)) {
			capsuleError("INVALID_CAPSULE", `inputs.${name} must be an object.`, { field: `inputs.${name}` });
		}
		assertAllowedFields(rawDeclaration, INPUT_FIELDS, `inputs.${name}`);
		const type = rawDeclaration.type ?? "string";
		if (typeof type !== "string" || !INPUT_TYPES.has(type as V3GraphCapsuleInputType)) {
			capsuleError("INVALID_CAPSULE", `inputs.${name}.type must be 'string', 'number', or 'boolean'.`, { field: `inputs.${name}.type` });
		}
		const required = rawDeclaration.required ?? false;
		if (typeof required !== "boolean") {
			capsuleError("INVALID_CAPSULE", `inputs.${name}.required must be a boolean.`, { field: `inputs.${name}.required` });
		}
		const description = optionalString(rawDeclaration, "description", `inputs.${name}`, 2_000);
		const defaultValue = rawDeclaration.default;
		if ("default" in rawDeclaration && !valueHasType(defaultValue, type as V3GraphCapsuleInputType)) {
			capsuleError("INVALID_CAPSULE", `inputs.${name}.default must have type ${type}.`, { field: `inputs.${name}.default` });
		}
		output.push([name, {
			type: type as V3GraphCapsuleInputType,
			required,
			...(defaultValue === undefined ? {} : { default: defaultValue as V3GraphCapsuleInputValue }),
			...(description === undefined ? {} : { description }),
		}]);
	}
	return Object.fromEntries(output);
}

function normalizeRequirements(value: unknown): V3GraphCapsuleRequirements {
	if (value === undefined) return { readOnly: false, toolFilter: [] };
	if (!isRecord(value)) capsuleError("INVALID_CAPSULE", "requires must be an object.", { field: "requires" });
	assertAllowedFields(value, REQUIREMENT_FIELDS, "requires");
	const readOnly = value.readOnly ?? false;
	if (typeof readOnly !== "boolean") capsuleError("INVALID_CAPSULE", "requires.readOnly must be a boolean.", { field: "requires.readOnly" });
	const rawToolFilter = value.toolFilter ?? [];
	if (!Array.isArray(rawToolFilter)) capsuleError("INVALID_CAPSULE", "requires.toolFilter must be an array.", { field: "requires.toolFilter" });
	const toolFilter = rawToolFilter.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0 || entry.trim().length > 200) {
			capsuleError("INVALID_CAPSULE", `requires.toolFilter[${index}] must be a non-empty string of at most 200 characters.`, { field: "requires.toolFilter" });
		}
		return entry.trim();
	});
	if (new Set(toolFilter).size !== toolFilter.length) capsuleError("INVALID_CAPSULE", "requires.toolFilter must not contain duplicates.", { field: "requires.toolFilter" });
	return { readOnly, toolFilter };
}

function normalizeProvenance(value: unknown): V3GraphCapsuleProvenance | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) capsuleError("INVALID_CAPSULE", "provenance must be an object.", { field: "provenance" });
	assertAllowedFields(value, PROVENANCE_FIELDS, "provenance");
	const created = requiredString(value, "created", "provenance", 200);
	const author = optionalString(value, "author", "provenance", 2_000);
	const source = optionalString(value, "source", "provenance", 4_000);
	return {
		created,
		...(author === undefined ? {} : { author }),
		...(source === undefined ? {} : { source }),
	};
}

/**
 * Validate and normalize the capsule envelope. The embedded spec is deliberately
 * compiled only after inputs are resolved, so placeholders cannot bypass the
 * GraphSpec V3 compiler's unknown-field and governance-field rejection.
 */
export function validateV3GraphCapsule(value: unknown): V3GraphCapsule {
	if (!isRecord(value)) capsuleError("INVALID_CAPSULE", "root must be an object.");
	assertAllowedFields(value, CAPSULE_FIELDS, "the capsule root");

	if (!isRecord(value.manifest)) capsuleError("INVALID_CAPSULE", "manifest must be an object.", { field: "manifest" });
	assertAllowedFields(value.manifest, MANIFEST_FIELDS, "manifest");
	const manifest: V3GraphCapsuleManifest = {
		name: requiredString(value.manifest, "name", "manifest", 200),
		version: requiredString(value.manifest, "version", "manifest", 100),
		description: requiredString(value.manifest, "description", "manifest", 2_000),
	};

	if (!isRecord(value.source)) capsuleError("INVALID_CAPSULE", "source must be an object.", { field: "source" });
	assertAllowedFields(value.source, SOURCE_FIELDS, "source");
	if (value.source.type !== "graph-spec") capsuleError("INVALID_CAPSULE", "source.type must be 'graph-spec'.", { field: "source.type" });
	if (!isRecord(value.source.spec)) capsuleError("INVALID_CAPSULE", "source.spec must be an object.", { field: "source.spec" });
	const spec = cloneJsonValue(value.source.spec, "source.spec") as Record<string, unknown>;
	if (spec.schemaVersion !== 3) capsuleError("INVALID_CAPSULE", "source.spec must declare schemaVersion: 3.", { field: "source.spec.schemaVersion" });
	if (typeof spec.goal !== "string") capsuleError("INVALID_CAPSULE", "source.spec.goal must be a string.", { field: "source.spec.goal" });
	if (!Array.isArray(spec.nodes)) capsuleError("INVALID_CAPSULE", "source.spec.nodes must be an array.", { field: "source.spec.nodes" });

	const intent = requiredString(value, "intent", "capsule", 4_000);
	const inputs = normalizeInputDeclarations(value.inputs);
	const requires = normalizeRequirements(value.requires);
	const provenance = normalizeProvenance(value.provenance);
	return {
		manifest,
		source: { type: "graph-spec", spec },
		intent,
		inputs,
		requires,
		...(provenance === undefined ? {} : { provenance }),
	};
}

function normalizeOverrides(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value)) capsuleError("INVALID_CAPSULE_INPUT", "input overrides must be an object.");
	return value;
}

function resolveInputs(
	capsule: V3GraphCapsule,
	overridesValue: unknown,
): V3ResolvedGraphCapsuleInputs {
	const overrides = normalizeOverrides(overridesValue);
	for (const name of Object.keys(overrides)) {
		if (!(name in capsule.inputs)) capsuleError("INVALID_CAPSULE_INPUT", `unknown input '${name}'.`, { field: name });
	}
	const resolved: Array<[string, V3GraphCapsuleInputValue]> = [];
	for (const [name, declaration] of Object.entries(capsule.inputs)) {
		const supplied = Object.hasOwn(overrides, name);
		const hasDefault = Object.hasOwn(declaration, "default");
		if (!supplied && !hasDefault) {
			if (declaration.required) capsuleError("INVALID_CAPSULE_INPUT", `required input '${name}' was not provided.`, { field: name });
			continue;
		}
		const value = supplied ? overrides[name] : declaration.default;
		if (!valueHasType(value, declaration.type)) {
			const actual = typeof value === "number" && !Number.isFinite(value) ? "non-finite number" : typeof value;
			capsuleError("INVALID_CAPSULE_INPUT", `input '${name}' expects ${declaration.type}, received ${actual}.`, { field: name });
		}
		resolved.push([name, value]);
	}
	return Object.freeze(Object.fromEntries(resolved)) as V3ResolvedGraphCapsuleInputs;
}

/** Resolve strictly typed overrides and defaults, rejecting unknown or missing inputs. */
export function resolveV3GraphCapsuleInputs(
	capsuleValue: unknown,
	overrides: unknown = {},
): V3ResolvedGraphCapsuleInputs {
	return resolveInputs(validateV3GraphCapsule(capsuleValue), overrides);
}

function replaceStringPlaceholders(
	text: string,
	inputs: V3ResolvedGraphCapsuleInputs,
	path: string,
): V3GraphCapsuleInputValue {
	const exactMatch = /^\{\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}\}$/u.exec(text);
	if (exactMatch) {
		const name = exactMatch[1]!;
		if (!Object.hasOwn(inputs, name)) capsuleError("INVALID_CAPSULE_PLACEHOLDER", `${path} references unresolved input '${name}'.`, { field: path });
		return inputs[name]!;
	}

	const matches = [...text.matchAll(PLACEHOLDER_PATTERN)];
	const withoutRecognizedPlaceholders = text.replace(PLACEHOLDER_PATTERN, "");
	if (withoutRecognizedPlaceholders.includes("{{") || withoutRecognizedPlaceholders.includes("}}")) {
		capsuleError("INVALID_CAPSULE_PLACEHOLDER", `${path} contains a malformed placeholder.`, { field: path });
	}
	let output = text;
	for (const match of matches) {
		const name = match[1]!;
		if (!Object.hasOwn(inputs, name)) capsuleError("INVALID_CAPSULE_PLACEHOLDER", `${path} references unresolved input '${name}'.`, { field: path });
		output = output.replaceAll(match[0], String(inputs[name]!));
	}
	return output;
}

function applyPlaceholders(
	value: unknown,
	inputs: V3ResolvedGraphCapsuleInputs,
	path: string,
	depth = 0,
): unknown {
	if (depth > MAX_JSON_DEPTH) capsuleError("INVALID_CAPSULE_PLACEHOLDER", `${path} exceeds the maximum JSON nesting depth.`, { field: path });
	if (typeof value === "string") return replaceStringPlaceholders(value, inputs, path);
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((entry, index) => applyPlaceholders(entry, inputs, `${path}[${index}]`, depth + 1));
	if (!isRecord(value)) capsuleError("INVALID_CAPSULE", `${path} must contain only JSON values.`, { field: path });
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
		key,
		applyPlaceholders(entry, inputs, `${path}.${key}`, depth + 1),
	]));
}

/** Apply placeholders recursively to GraphSpec values without ever templating object keys. */
export function applyV3GraphCapsuleInputs(
	specValue: unknown,
	inputs: V3ResolvedGraphCapsuleInputs,
): Record<string, unknown> {
	if (!isRecord(specValue)) capsuleError("INVALID_CAPSULE", "source.spec must be an object.", { field: "source.spec" });
	return applyPlaceholders(cloneJsonValue(specValue, "source.spec"), inputs, "source.spec") as Record<string, unknown>;
}

/** Resolve a capsule and pass the final spec through the authoritative V3 compiler. */
export function compileV3GraphCapsule(capsuleValue: unknown, overrides: unknown = {}): V3CompiledGraphCapsule {
	const capsule = validateV3GraphCapsule(capsuleValue);
	const inputs = resolveInputs(capsule, overrides);
	const resolvedSpec = applyV3GraphCapsuleInputs(capsule.source.spec, inputs);
	// Requirements are execution authority, not descriptive metadata. Bind them
	// into the admitted GraphSpec so recovery recompiles the same tool ceiling.
	if (capsule.requires.readOnly) resolvedSpec.readOnly = true;
	if (capsule.requires.toolFilter.length > 0) resolvedSpec.toolFilter = [...capsule.requires.toolFilter];
	let compiled: CompiledGraphV3;
	try {
		compiled = compileGraphSpecV3(resolvedSpec);
	} catch (error) {
		if (capsule.requires.readOnly && error instanceof Error && error.message.includes("readOnly graph")) {
			capsuleError("INVALID_CAPSULE", "requires.readOnly conflicts with a local_write node in source.spec.", { field: "requires.readOnly", cause: error });
		}
		throw error;
	}
	return {
		capsule,
		inputs,
		spec: structuredClone(compiled.sourceGraphSpec),
		compiled,
	};
}

function validateCapsulePath(filePath: unknown): string {
	if (typeof filePath !== "string" || filePath.trim().length === 0 || filePath.includes("\0")) {
		capsuleError("INVALID_CAPSULE_PATH", "path must be a non-empty string without NUL bytes.");
	}
	const name = basename(filePath);
	if (!name.endsWith(V3_GRAPH_CAPSULE_SUFFIX) || name.length === V3_GRAPH_CAPSULE_SUFFIX.length) {
		capsuleError("INVALID_CAPSULE_PATH", `path must name a file ending in '${V3_GRAPH_CAPSULE_SUFFIX}'.`, { path: filePath });
	}
	return resolve(filePath);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameObservation(left: BigIntStats, right: BigIntStats): boolean {
	return sameIdentity(left, right)
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function loadLimit(options: V3GraphCapsuleLoadOptions): number {
	const maxBytes = options.maxBytes ?? V3_GRAPH_CAPSULE_MAX_BYTES;
	if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > V3_GRAPH_CAPSULE_MAX_BYTES) {
		capsuleError("INVALID_CAPSULE_PATH", `maxBytes must be an integer from 1 through ${V3_GRAPH_CAPSULE_MAX_BYTES}.`);
	}
	return maxBytes;
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, path: string): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, 64 * 1024));
	const chunks: Buffer[] = [];
	let total = 0;
	while (true) {
		const remaining = maxBytes + 1 - total;
		if (remaining <= 0) capsuleError("CAPSULE_TOO_LARGE", `file exceeds ${maxBytes} bytes.`, { path });
		const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
		if (bytesRead === 0) break;
		total += bytesRead;
		if (total > maxBytes) capsuleError("CAPSULE_TOO_LARGE", `file exceeds ${maxBytes} bytes.`, { path });
		chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
	}
	return Buffer.concat(chunks, total);
}

async function readStableCapsuleFile(
	filePath: unknown,
	options: V3GraphCapsuleLoadOptions,
	dependencies: V3GraphCapsuleReadDependencies,
): Promise<{ path: string; contents: string }> {
	const path = validateCapsulePath(filePath);
	const maxBytes = loadLimit(options);
	let pathBefore: BigIntStats;
	try {
		pathBefore = await lstat(path, { bigint: true });
	} catch (error) {
		capsuleError("CAPSULE_READ_FAILED", `cannot inspect '${path}': ${error instanceof Error ? error.message : String(error)}`, { path, cause: error });
	}
	if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
		capsuleError("CAPSULE_READ_FAILED", `'${path}' must be a regular non-symbolic-link file.`, { path });
	}
	if (pathBefore.size > BigInt(maxBytes)) capsuleError("CAPSULE_TOO_LARGE", `'${path}' exceeds ${maxBytes} bytes.`, { path });

	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || !sameIdentity(pathBefore, opened)) {
			capsuleError("CAPSULE_CHANGED", `'${path}' changed identity while being opened.`, { path });
		}
		if (opened.size > BigInt(maxBytes)) capsuleError("CAPSULE_TOO_LARGE", `'${path}' exceeds ${maxBytes} bytes.`, { path });
		await dependencies.afterOpen?.(path);
		const bytes = await readBounded(handle, maxBytes, path);
		const [finished, pathAfter] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(path, { bigint: true }),
		]);
		if (pathAfter.isSymbolicLink()
			|| !pathAfter.isFile()
			|| !sameObservation(opened, finished)
			|| !sameObservation(finished, pathAfter)) {
			capsuleError("CAPSULE_CHANGED", `'${path}' changed while being read.`, { path });
		}
		if (finished.size !== BigInt(bytes.length)) {
			capsuleError("CAPSULE_CHANGED", `'${path}' did not yield a stable complete read.`, { path });
		}
		let contents: string;
		try {
			contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			capsuleError("INVALID_CAPSULE_JSON", `'${path}' is not valid UTF-8.`, { path, cause: error });
		}
		return { path, contents };
	} catch (error) {
		if (error instanceof V3GraphCapsuleError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "EMLINK") capsuleError("CAPSULE_CHANGED", `'${path}' became a symbolic link while being opened.`, { path, cause: error });
		capsuleError("CAPSULE_READ_FAILED", `cannot safely read '${path}': ${error instanceof Error ? error.message : String(error)}`, { path, cause: error });
	} finally {
		await handle?.close().catch(() => undefined);
	}
	throw new Error("unreachable");
}

/** Safely load and validate a single explicit .graph.json capsule path. */
export async function loadV3GraphCapsule(
	filePath: string,
	options: V3GraphCapsuleLoadOptions = {},
	dependencies: V3GraphCapsuleReadDependencies = {},
): Promise<V3GraphCapsule> {
	const { path, contents } = await readStableCapsuleFile(filePath, options, dependencies);
	let value: unknown;
	try {
		value = JSON.parse(contents) as unknown;
	} catch (error) {
		capsuleError("INVALID_CAPSULE_JSON", `'${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { path, cause: error });
	}
	return validateV3GraphCapsule(value);
}

/** Load, resolve, and compiler-validate a capsule in one fail-closed operation. */
export async function loadAndCompileV3GraphCapsule(
	filePath: string,
	overrides: unknown = {},
	options: V3GraphCapsuleLoadOptions = {},
): Promise<V3CompiledGraphCapsule> {
	return compileV3GraphCapsule(await loadV3GraphCapsule(filePath, options), overrides);
}

/** Return deterministic JSON bytes suitable for writing to an explicit .graph.json path. */
export function packV3GraphCapsule(capsuleValue: unknown): string {
	return `${canonicalJson(validateV3GraphCapsule(capsuleValue))}\n`;
}
