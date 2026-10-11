import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
	bindV3GraphCapsule,
	resolveV3GraphCapsule,
	type V3BoundGraphCapsule,
	type V3GraphCapsule,
	type V3GraphCapsuleRequirements,
	type V3ResolvedGraphCapsule,
	validateV3GraphCapsule,
} from "./graph-capsule.ts";
import type { V3BindingOptions } from "./binding.ts";
import type { GraphSpecAuthoringV3, GraphSpecV3 } from "./types.ts";

export type BuiltinGraphTemplateV3Name = "research-report" | "code-review" | "doc-write";

export interface BuiltinGraphTemplateInputV3 {
	type: "string";
	required: boolean;
	default?: string;
	description: string;
}

export interface BuiltinGraphTemplateSummaryV3 {
	name: BuiltinGraphTemplateV3Name;
	version: string;
	description: string;
	inputs: Record<string, BuiltinGraphTemplateInputV3>;
	/** Execution metadata retained from the same capsule envelope used for file capsules. */
	requires: V3GraphCapsuleRequirements;
}

export type BuiltinGraphTemplateInputsV3 = Readonly<Record<string, string | undefined>>;

interface BuiltinGraphTemplateResourceV3 {
	name: BuiltinGraphTemplateV3Name;
	url: URL;
}

const BUILTIN_TEMPLATE_RESOURCES: readonly BuiltinGraphTemplateResourceV3[] = [
	{ name: "research-report", url: new URL("../../templates/research-report.graph.json", import.meta.url) },
	{ name: "code-review", url: new URL("../../templates/code-review.graph.json", import.meta.url) },
	{ name: "doc-write", url: new URL("../../templates/doc-write.graph.json", import.meta.url) },
];

function resourceFor(name: string): BuiltinGraphTemplateResourceV3 {
	const resource = BUILTIN_TEMPLATE_RESOURCES.find((candidate) => candidate.name === name);
	if (!resource) {
		throw new Error(`Unknown built-in V3 graph template '${name}'. Available templates: ${BUILTIN_TEMPLATE_RESOURCES.map((entry) => entry.name).join(", ")}.`);
	}
	return resource;
}

function readBuiltinCapsule(resource: BuiltinGraphTemplateResourceV3): V3GraphCapsule {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(resource.url, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`Built-in V3 graph template '${resource.name}' could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	return validateV3GraphCapsule(value);
}

function normalizeDocumentPath(value: string): string {
	const slashed = value.replaceAll("\\", "/");
	if (/[\0-\x1f\x7f]/u.test(slashed) || slashed.includes('"') || slashed.startsWith("/") || /^[a-zA-Z]:\//u.test(slashed)) {
		throw new Error("Template input 'doc_path' must be a safe workspace-relative path.");
	}
	const segments = slashed.split("/");
	if (segments.includes("..")) throw new Error("Template input 'doc_path' must not escape the workspace.");
	const normalized = posix.normalize(slashed).replace(/^\.\//u, "").replace(/\/$/u, "");
	if (!normalized || normalized === ".") throw new Error("Template input 'doc_path' must identify a file inside the workspace.");
	return normalized;
}

function resolveTemplateOverrides(
	name: BuiltinGraphTemplateV3Name,
	capsule: V3GraphCapsule,
	provided: BuiltinGraphTemplateInputsV3,
): Record<string, string> {
	for (const key of Object.keys(provided)) {
		if (!(key in capsule.inputs)) throw new Error(`Unknown input '${key}' for built-in V3 template '${name}'.`);
	}
	const resolved: Record<string, string> = {};
	for (const [key, input] of Object.entries(capsule.inputs)) {
		if (input.type !== "string") throw new Error(`Built-in V3 template '${name}' declares unsupported non-string input '${key}'.`);
		const value = provided[key] ?? input.default;
		if (typeof value !== "string" || value.trim().length === 0) {
			if (input.required) throw new Error(`Built-in V3 template '${name}' requires input '${key}'.`);
			throw new Error(`Input '${key}' for built-in V3 template '${name}' must be a non-empty string.`);
		}
		resolved[key] = key === "doc_path" ? normalizeDocumentPath(value) : value;
	}
	return resolved;
}

function capsuleFor(name: BuiltinGraphTemplateV3Name | string): V3GraphCapsule {
	const resource = resourceFor(name);
	const capsule = readBuiltinCapsule(resource);
	if (capsule.manifest.name !== resource.name) {
		throw new Error(`Built-in V3 graph template resource '${resource.name}' declares manifest name '${capsule.manifest.name}'.`);
	}
	return capsule;
}

/** List immutable metadata parsed from every .graph.json resource shipped with V3. */
export function listBuiltinGraphTemplatesV3(): BuiltinGraphTemplateSummaryV3[] {
	return BUILTIN_TEMPLATE_RESOURCES.map(({ name }) => {
		const capsule = capsuleFor(name);
		return structuredClone({
			name,
			version: capsule.manifest.version,
			description: capsule.manifest.description,
			inputs: capsule.inputs as Record<string, BuiltinGraphTemplateInputV3>,
			requires: capsule.requires,
		});
	});
}

/**
 * Resolve a built-in .graph.json resource through the exact placeholder path used
 * by user capsules. Binding remains an explicit asynchronous admission step.
 */
export function resolveBuiltinGraphTemplateCapsuleV3(
	name: BuiltinGraphTemplateV3Name | string,
	inputs: BuiltinGraphTemplateInputsV3 = {},
): V3ResolvedGraphCapsule {
	const capsule = capsuleFor(name);
	return resolveV3GraphCapsule(capsule, resolveTemplateOverrides(name as BuiltinGraphTemplateV3Name, capsule, inputs));
}

/** Load fresh public authoring bytes; capability IDs have not been resolved yet. */
export function resolveBuiltinGraphTemplateV3(
	name: BuiltinGraphTemplateV3Name | string,
	inputs: BuiltinGraphTemplateInputsV3 = {},
): GraphSpecAuthoringV3 {
	return structuredClone(resolveBuiltinGraphTemplateCapsuleV3(name, inputs).spec);
}

/** Bind a built-in template to exact Pi Agents and compile its pure-core spec. */
export async function bindBuiltinGraphTemplateCapsuleV3(
	name: BuiltinGraphTemplateV3Name | string,
	inputs: BuiltinGraphTemplateInputsV3 = {},
	options: V3BindingOptions = {},
): Promise<V3BoundGraphCapsule> {
	const capsule = capsuleFor(name);
	return bindV3GraphCapsule(
		capsule,
		resolveTemplateOverrides(name as BuiltinGraphTemplateV3Name, capsule, inputs),
		options,
	);
}

/** Return the exact-Agent GraphSpec admitted from a capability-authored template. */
export async function bindBuiltinGraphTemplateV3(
	name: BuiltinGraphTemplateV3Name | string,
	inputs: BuiltinGraphTemplateInputsV3 = {},
	options: V3BindingOptions = {},
): Promise<GraphSpecV3> {
	return structuredClone((await bindBuiltinGraphTemplateCapsuleV3(name, inputs, options)).spec);
}
