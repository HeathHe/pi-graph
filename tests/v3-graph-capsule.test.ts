import assert from "node:assert/strict";
import { mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraphV3Error } from "../src/v3/errors.ts";
import {
	applyV3GraphCapsuleInputs,
	bindV3GraphCapsule,
	compileV3GraphCapsule,
	loadAndCompileV3GraphCapsule,
	loadV3GraphCapsule,
	packV3GraphCapsule,
	resolveV3GraphCapsuleInputs,
	V3_GRAPH_CAPSULE_MAX_BYTES,
	V3GraphCapsuleError,
	validateV3GraphCapsule,
} from "../src/v3/graph-capsule.ts";

function capsule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		manifest: {
			name: "review-capsule",
			version: "1.2.3",
			description: "A parameterized, read-only V3 review graph.",
		},
		intent: "Review one target with bounded, compiler-checked behavior.",
		inputs: {
			target: { type: "string", required: true, description: "Workspace target." },
			attempts: { type: "number", required: false, default: 2 },
			strict: { type: "boolean", required: false, default: true },
		},
		requires: { readOnly: true, toolFilter: ["read", "grep"] },
		provenance: { created: "2026-08-24", author: "pi-graph tests", source: "tests" },
		source: {
			type: "graph-spec",
			spec: {
				schemaVersion: 3,
				graphId: "review-capsule",
				goal: "Review {{target}} (strict={{strict}})",
				maxConcurrency: "{{attempts}}",
				nodes: [{
					taskId: "review",
					agent: "code-reviewer",
					task: "Review {{target}}; strict={{strict}}; passes={{attempts}}.",
					readScope: [{ kind: "tree", path: "{{target}}" }],
					sideEffect: "local_read",
				}],
			},
		},
		...overrides,
	};
}

async function tempCapsulePath(name = "review.graph.json"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-v3-graph-capsule-"));
	return join(directory, name);
}

function expectCapsuleError(
	operation: () => unknown,
	code: V3GraphCapsuleError["code"],
): V3GraphCapsuleError {
	try {
		operation();
	} catch (error) {
		assert.ok(error instanceof V3GraphCapsuleError);
		assert.equal(error.code, code);
		return error;
	}
	assert.fail(`Expected V3GraphCapsuleError(${code})`);
}

test("V3 graph capsule validates and normalizes manifest, source, intent, inputs, requirements, and provenance", () => {
	const value = capsule() as Record<string, unknown>;
	(value.manifest as Record<string, unknown>).name = "  review-capsule  ";
	const normalized = validateV3GraphCapsule(value);
	assert.equal(normalized.manifest.name, "review-capsule");
	assert.equal(normalized.source.type, "graph-spec");
	assert.deepEqual(normalized.inputs.attempts, { type: "number", required: false, default: 2 });
	assert.deepEqual(normalized.requires, { readOnly: true, toolFilter: ["read", "grep"] });
	assert.deepEqual(normalized.provenance, { created: "2026-08-24", author: "pi-graph tests", source: "tests" });
	assert.notEqual(normalized.source.spec, (value.source as Record<string, unknown>).spec, "the normalized capsule must not retain caller-owned objects");
});

test("V3 graph capsule rejects unknown envelope fields and malformed/default-mismatched input declarations", () => {
	expectCapsuleError(() => validateV3GraphCapsule(capsule({ model: "governed" })), "INVALID_CAPSULE");
	expectCapsuleError(() => validateV3GraphCapsule(capsule({ inputs: { bad: { type: "date" } } })), "INVALID_CAPSULE");
	expectCapsuleError(() => validateV3GraphCapsule(capsule({ inputs: { count: { type: "number", default: "2" } } })), "INVALID_CAPSULE");
	expectCapsuleError(() => validateV3GraphCapsule(capsule({ inputs: { constructor: { type: "string" } } })), "INVALID_CAPSULE");
	expectCapsuleError(() => validateV3GraphCapsule(capsule({ requires: { readOnly: true, model: "x" } })), "INVALID_CAPSULE");
});

test("V3 graph capsule resolves exact string/number/boolean inputs, defaults, and rejects unknown/missing/type errors", () => {
	assert.deepEqual(resolveV3GraphCapsuleInputs(capsule(), { target: "src/v3", attempts: 4, strict: false }), {
		target: "src/v3",
		attempts: 4,
		strict: false,
	});
	assert.deepEqual(resolveV3GraphCapsuleInputs(capsule(), { target: "src/v3" }), {
		target: "src/v3",
		attempts: 2,
		strict: true,
	});
	expectCapsuleError(() => resolveV3GraphCapsuleInputs(capsule(), {}), "INVALID_CAPSULE_INPUT");
	expectCapsuleError(() => resolveV3GraphCapsuleInputs(capsule(), { target: "src", typo: true }), "INVALID_CAPSULE_INPUT");
	expectCapsuleError(() => resolveV3GraphCapsuleInputs(capsule(), { target: "src", attempts: "4" }), "INVALID_CAPSULE_INPUT");
	expectCapsuleError(() => resolveV3GraphCapsuleInputs(capsule(), { target: "src", strict: "true" }), "INVALID_CAPSULE_INPUT");
});

test("V3 graph capsule applies placeholders recursively and preserves exact typed replacements", () => {
	const resolved = resolveV3GraphCapsuleInputs(capsule(), { target: "src/v3", attempts: 4, strict: false });
	const spec = applyV3GraphCapsuleInputs((capsule().source as Record<string, unknown>).spec, resolved);
	assert.equal(spec.goal, "Review src/v3 (strict=false)");
	assert.equal(spec.maxConcurrency, 4, "an exact placeholder must preserve its number type");
	const node = (spec.nodes as Array<Record<string, unknown>>)[0]!;
	assert.equal(node.task, "Review src/v3; strict=false; passes=4.");
	assert.deepEqual(node.readScope, [{ kind: "tree", path: "src/v3" }]);

	expectCapsuleError(() => applyV3GraphCapsuleInputs({ goal: "{{missing}}" }, resolved), "INVALID_CAPSULE_PLACEHOLDER");
	expectCapsuleError(() => applyV3GraphCapsuleInputs({ goal: "bad {{target" }, resolved), "INVALID_CAPSULE_PLACEHOLDER");
});

test("V3 graph capsule always ends in compileGraphSpecV3 and fails closed on governance or unknown fields", () => {
	const result = compileV3GraphCapsule(capsule(), { target: "src/v3", attempts: 3 });
	assert.equal(result.compiled.maxConcurrency, 3);
	assert.equal(result.compiled.nodes[0]?.task, "Review src/v3; strict=true; passes=3.");
	assert.equal(result.spec.goal, "Review src/v3 (strict=true)");
	assert.equal(result.spec.readOnly, true, "capsule readOnly is bound into durable GraphSpec authority");
	assert.deepEqual(result.spec.toolFilter, ["read", "grep"], "capsule toolFilter is bound into durable GraphSpec authority");
	assert.equal(result.compiled.nodes[0]?.readOnly, true);
	assert.deepEqual(result.compiled.nodes[0]?.toolFilter, ["grep", "read"]);
	assert.equal(Object.prototype.hasOwnProperty.call(result.spec, "requires"), false, "the capsule envelope itself is not injected");

	const governed = capsule();
	((governed.source as Record<string, unknown>).spec as Record<string, unknown>).routing = "auto";
	assert.throws(
		() => compileV3GraphCapsule(governed, { target: "src" }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "GOVERNANCE_FIELD_FORBIDDEN",
	);
	const unknown = capsule();
	((unknown.source as Record<string, unknown>).spec as Record<string, unknown>).mystery = true;
	assert.throws(
		() => compileV3GraphCapsule(unknown, { target: "src" }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_FIELD",
	);
});

test("capability-authored capsule resolves placeholders before async Binding/Admission", async () => {
	const value = capsule();
	const source = (value.source as Record<string, unknown>).spec as Record<string, unknown>;
	source.contractPolicy = "strict";
	const node = (source.nodes as Array<Record<string, unknown>>)[0]!;
	delete node.agent;
	node.capabilityId = "review.code";
	const bound = await bindV3GraphCapsule(value, { target: "src/v3", attempts: 3 }, {
		catalog: { schemaVersion: 1, capabilities: [{ capabilityId: "review.code", agent: "code-reviewer" }] },
		preflightAgent: async (input) => ({
			ok: true,
			name: input.agent,
			agentDefinitionDigest: "c".repeat(64),
			launchContractDigest: "d".repeat(64),
			modelCandidates: input.model ? [input.model] : [],
			extensions: {
				runtimeExtensions: [],
				configuredExtensions: [],
				extensionArgs: [],
				disableAmbientExtensions: true,
			},
		}),
	});
	assert.equal(bound.spec.bindingPolicy, "strict");
	assert.equal(bound.spec.nodes[0]?.agent, "code-reviewer");
	assert.equal(bound.spec.nodes[0]?.binding?.resolution, "capability-catalog");
	assert.equal(Object.hasOwn(bound.spec.nodes[0]!, "capabilityId"), false);
	assert.equal(bound.compiled.maxConcurrency, 3);
	assert.equal(bound.spec.readOnly, true);
	assert.deepEqual(bound.spec.toolFilter, ["read", "grep"]);
});

test("V3 graph capsule rejects readOnly requirements that contradict local writes", () => {
	const value = capsule();
	const source = (value.source as Record<string, unknown>).spec as Record<string, unknown>;
	source.nodes = [{
		taskId: "write",
		agent: "writer",
		task: "write {{target}}",
		writeScope: [{ kind: "file", path: "{{target}}" }],
		validationCommands: ["test -s {{target}}"],
		sideEffect: "local_write",
	}];
	expectCapsuleError(() => compileV3GraphCapsule(value, { target: "out.md" }), "INVALID_CAPSULE");
});

test("V3 graph capsule pack helper is deterministic and reloadable", async () => {
	const path = await tempCapsulePath();
	const first = packV3GraphCapsule(capsule());
	const second = packV3GraphCapsule(structuredClone(capsule()));
	assert.equal(first, second);
	assert.equal(first.endsWith("\n"), true);
	await writeFile(path, first);
	const loaded = await loadAndCompileV3GraphCapsule(path, { target: "src/v3" });
	assert.equal(loaded.capsule.manifest.name, "review-capsule");
	assert.equal(loaded.compiled.nodes.length, 1);
});

test("V3 graph capsule loader enforces explicit extension, regular-file identity, UTF-8, and size bounds", async () => {
	const wrongExtension = await tempCapsulePath("review.json");
	await writeFile(wrongExtension, packV3GraphCapsule(capsule()));
	await assert.rejects(loadV3GraphCapsule(wrongExtension), (error: unknown) => error instanceof V3GraphCapsuleError && error.code === "INVALID_CAPSULE_PATH");

	const target = await tempCapsulePath("target.graph.json");
	await writeFile(target, packV3GraphCapsule(capsule()));
	const link = join(await mkdtemp(join(tmpdir(), "pi-graph-v3-graph-capsule-link-")), "link.graph.json");
	await symlink(target, link);
	await assert.rejects(loadV3GraphCapsule(link), (error: unknown) => error instanceof V3GraphCapsuleError && error.code === "CAPSULE_READ_FAILED");

	const large = await tempCapsulePath("large.graph.json");
	await writeFile(large, "x".repeat(65));
	await assert.rejects(loadV3GraphCapsule(large, { maxBytes: 64 }), (error: unknown) => error instanceof V3GraphCapsuleError && error.code === "CAPSULE_TOO_LARGE");
	await assert.rejects(loadV3GraphCapsule(large, { maxBytes: V3_GRAPH_CAPSULE_MAX_BYTES + 1 }), (error: unknown) => error instanceof V3GraphCapsuleError && error.code === "INVALID_CAPSULE_PATH");

	const invalidUtf8 = await tempCapsulePath("invalid-utf8.graph.json");
	await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]));
	await assert.rejects(loadV3GraphCapsule(invalidUtf8), (error: unknown) => error instanceof V3GraphCapsuleError && error.code === "INVALID_CAPSULE_JSON");
});

test("V3 graph capsule loader detects path replacement during a stable descriptor read", async () => {
	const path = await tempCapsulePath("race.graph.json");
	await writeFile(path, packV3GraphCapsule(capsule()));
	const replacement = `${path}.replacement`;
	await writeFile(replacement, packV3GraphCapsule(capsule({ intent: "Replacement capsule." })));
	await assert.rejects(
		loadV3GraphCapsule(path, {}, { afterOpen: async () => rename(replacement, path) }),
		(error: unknown) => error instanceof V3GraphCapsuleError && error.code === "CAPSULE_CHANGED",
	);
});
