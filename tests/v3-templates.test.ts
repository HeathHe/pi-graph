import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { loadAndBindV3GraphCapsule } from "../src/v3/graph-capsule.ts";
import {
	bindBuiltinGraphTemplateCapsuleV3,
	bindBuiltinGraphTemplateV3,
	listBuiltinGraphTemplatesV3,
	resolveBuiltinGraphTemplateV3,
} from "../src/v3/templates.ts";

const CATALOG = {
	schemaVersion: 1,
	capabilities: [
		{ capabilityId: "discover.code", agent: "code-scout" },
		{ capabilityId: "review.code", agent: "code-reviewer" },
		{ capabilityId: "research.topic", agent: "researcher" },
		{ capabilityId: "review.research", agent: "research-reviewer" },
		{ capabilityId: "write.document", agent: "document-writer" },
		{ capabilityId: "edit.document", agent: "document-editor" },
	],
};
const NO_EXTENSIONS = {
	runtimeExtensions: [],
	configuredExtensions: [],
	extensionArgs: [],
	disableAmbientExtensions: true,
};
const BINDING_OPTIONS = {
	catalog: CATALOG,
	preflightAgent: async (input: { agent: string; model?: string }) => ({
		ok: true as const,
		name: input.agent,
		agentDefinitionDigest: "a".repeat(64),
		launchContractDigest: "b".repeat(64),
		modelCandidates: input.model ? [input.model] : [],
		extensions: NO_EXTENSIONS,
	}),
};

test("V3 built-in templates list the three dsh-compatible workflows", () => {
	const templates = listBuiltinGraphTemplatesV3();
	assert.deepEqual(templates.map((template) => template.name), [
		"research-report",
		"code-review",
		"doc-write",
	]);
	assert.deepEqual(templates.find((template) => template.name === "code-review")?.requires, {
		readOnly: true,
		toolFilter: ["read", "grep", "find"],
	});
	assert.deepEqual(templates.find((template) => template.name === "research-report")?.requires, {
		readOnly: true,
		toolFilter: ["read", "web_search", "fetch_content", "get_search_content"],
	});
});

test("built-in templates and user file capsules use the same capsule resolve/bind/compile path", async () => {
	const inputs = { target: "src/v3", requirements: "No governance in core" };
	const builtin = await bindBuiltinGraphTemplateCapsuleV3("code-review", inputs, BINDING_OPTIONS);
	const resourcePath = fileURLToPath(new URL("../templates/code-review.graph.json", import.meta.url));
	const fromFile = await loadAndBindV3GraphCapsule(resourcePath, inputs, { binding: BINDING_OPTIONS });

	assert.deepEqual(builtin.spec, fromFile.spec);
	assert.deepEqual(builtin.compiled, fromFile.compiled);
	assert.deepEqual(builtin.capsule.requires, fromFile.capsule.requires);
	assert.equal(builtin.capsule.requires.readOnly, true);
	assert.deepEqual(builtin.capsule.requires.toolFilter, ["read", "grep", "find"]);
	assert.equal(builtin.compiled.nodes.every((node) => node.sideEffect !== "local_write"), true);
});

test("every V3 built-in template capability-binds to a compiler-valid exact-Agent GraphSpecV3", async () => {
	const specs = await Promise.all([
		bindBuiltinGraphTemplateV3("research-report", { topic: "durable DAG execution" }, BINDING_OPTIONS),
		bindBuiltinGraphTemplateV3("code-review", { target: "src/v3", requirements: "No governance in core" }, BINDING_OPTIONS),
		bindBuiltinGraphTemplateV3("doc-write", { doc_path: "docs/generated report.md", subject: "V3 architecture" }, BINDING_OPTIONS),
	]);
	for (const spec of specs) {
		const compiled = compileGraphSpecV3(spec);
		assert.ok(compiled.nodes.every((node) => node.timeoutMs === undefined), "built-in templates must not silently impose a runtime deadline");
		assert.equal(compiled.nodes.length, 3);
		assert.deepEqual(compiled.topologicalOrder, spec.nodes.map((node) => node.taskId));
		assert.equal(spec.bindingPolicy, "strict");
		assert.equal(spec.nodes.every((node) => node.binding?.resolution === "capability-catalog"), true);
	}
	const write = specs[2]!.nodes.find((node) => node.taskId === "write")!;
	assert.equal(write.sideEffect, "local_write");
	assert.deepEqual(write.writeScope, [{ kind: "file", path: "docs/generated report.md" }]);
	assert.deepEqual(write.validationCommands, ['test -s "docs/generated report.md"']);
});

test("V3 built-in template loads and listings return deep copies", () => {
	const first = resolveBuiltinGraphTemplateV3("research-report", { topic: "first" });
	assert.equal(first.contractPolicy, "strict");
	assert.deepEqual(first.nodes.map((node) => node.capabilityId), ["research.topic", "review.research", "write.document"]);
	assert.equal(first.nodes.every((node) => node.agent === undefined), true);
	first.nodes[0]!.task = "mutated";
	const second = resolveBuiltinGraphTemplateV3("research-report", { topic: "first" });
	assert.notEqual(second.nodes[0]!.task, "mutated");

	const firstListing = listBuiltinGraphTemplatesV3();
	firstListing[0]!.inputs.topic!.description = "mutated";
	firstListing[0]!.requires.toolFilter.push("write");
	assert.notEqual(listBuiltinGraphTemplatesV3()[0]!.inputs.topic!.description, "mutated");
	assert.equal(listBuiltinGraphTemplatesV3()[0]!.requires.toolFilter.includes("write"), false);
});

test("V3 built-in templates validate names, required inputs, unknown inputs, and document paths", () => {
	assert.throws(() => resolveBuiltinGraphTemplateV3("unknown"), /Unknown built-in V3 graph template/u);
	assert.throws(() => resolveBuiltinGraphTemplateV3("research-report"), /requires input 'topic'/u);
	assert.throws(() => resolveBuiltinGraphTemplateV3("research-report", { topic: "DAG", typo: "value" }), /Unknown input 'typo'/u);
	assert.throws(() => resolveBuiltinGraphTemplateV3("doc-write", { doc_path: "/tmp/report.md", subject: "V3" }), /workspace-relative/u);
	assert.throws(() => resolveBuiltinGraphTemplateV3("doc-write", { doc_path: "../report.md", subject: "V3" }), /must not escape/u);
	assert.throws(() => resolveBuiltinGraphTemplateV3("doc-write", { doc_path: "docs/bad\"name.md", subject: "V3" }), /safe workspace-relative/u);
	assert.equal(
		resolveBuiltinGraphTemplateV3("doc-write", { doc_path: "./docs/./report.md", subject: "V3" }).nodes[1]!.writeScope?.[0]?.path,
		"docs/report.md",
	);
});
