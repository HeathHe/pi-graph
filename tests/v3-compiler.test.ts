import assert from "node:assert/strict";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { GraphV3Error, type GraphV3ErrorCode } from "../src/v3/errors.ts";

function validThreeNodeSpec(): Record<string, unknown> {
	return {
		schemaVersion: 3,
		graphId: "demo-graph",
		goal: "Compile a deterministic three-node graph",
		maxConcurrency: 2,
		nodes: [
			{
				taskId: "collect",
				agent: "reader",
				task: "Collect local inputs",
				sideEffect: "local_read",
				readScope: [{ kind: "tree", path: "src" }],
			},
			{
				taskId: "build",
				agent: "backend-developer",
				task: "Build the output",
				dependsOn: ["collect"],
				inputArtifacts: ["demo-graph/collect/out"],
				sideEffect: "local_write",
				writeScope: [{ kind: "tree", path: "src/generated" }],
				validationCommands: ["npm test"],
				retryPolicy: { maxAttempts: 2, retryOn: ["validation"], backoffMs: 10 },
			},
			{
				taskId: "verify",
				agent: "reviewer",
				task: "Verify the output",
				dependsOn: ["build"],
				inputArtifacts: ["demo-graph/build/out"],
				sideEffect: "none",
			},
		],
	};
}

function expectGraphError(fn: () => unknown, code: GraphV3ErrorCode): GraphV3Error {
	let received: unknown;
	try {
		fn();
	} catch (error) {
		received = error;
	}
	assert.ok(received instanceof GraphV3Error, `expected GraphV3Error, received ${String(received)}`);
	assert.equal(received.code, code);
	return received;
}

test("V3 compiler normalizes a legal three-node graph with a stable digest", () => {
	const input = validThreeNodeSpec();
	const first = compileGraphSpecV3(input);
	const second = compileGraphSpecV3(structuredClone(input));
	assert.equal(first.graphDigest, second.graphDigest);
	assert.equal(first.sourceGraphSpecDigest, second.sourceGraphSpecDigest);
	assert.deepEqual(first.topologicalOrder, ["collect", "build", "verify"]);
	assert.deepEqual(first.nodes.map((node) => node.taskId), first.topologicalOrder);
	assert.equal(first.nodes[0]?.outputArtifact, "demo-graph/collect/out");
	assert.deepEqual(first.nodes[0]?.retryPolicy, { maxAttempts: 1, retryOn: [], backoffMs: 5_000 });
	assert.equal(JSON.stringify(first).includes("createdAt"), false);
	assert.equal(JSON.stringify(first).includes("deadline"), false);
});

test("V3 compiler detects cycles", () => {
	const input = validThreeNodeSpec();
	const nodes = input.nodes as Array<Record<string, unknown>>;
	nodes[0]!.dependsOn = ["verify"];
	expectGraphError(() => compileGraphSpecV3(input), "DEPENDENCY_CYCLE");
});

test("V3 compiler detects unknown dependencies", () => {
	const input = validThreeNodeSpec();
	const nodes = input.nodes as Array<Record<string, unknown>>;
	nodes[1]!.dependsOn = ["missing"];
	const error = expectGraphError(() => compileGraphSpecV3(input), "UNKNOWN_DEPENDENCY");
	assert.equal(error.taskId, "build");
});

test("V3 compiler detects duplicate task IDs", () => {
	const input = validThreeNodeSpec();
	const nodes = input.nodes as Array<Record<string, unknown>>;
	nodes[2]!.taskId = "build";
	expectGraphError(() => compileGraphSpecV3(input), "DUPLICATE_TASK_ID");
});

test("V3 compiler rejects unordered overlapping writes", () => {
	const input = validThreeNodeSpec();
	const nodes = input.nodes as Array<Record<string, unknown>>;
	nodes.push({
		taskId: "parallel-write",
		agent: "backend-developer",
		task: "Write a nested path without ordering",
		dependsOn: ["collect"],
		sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "src/generated/value.ts" }],
		validationCommands: ["npm test"],
	});
	const error = expectGraphError(() => compileGraphSpecV3(input), "SCOPE_CONFLICT");
	assert.deepEqual(error.details?.taskIds, ["build", "parallel-write"]);
});

test("V3 compiler allows overlapping writes when a dependency orders them", () => {
	const input = validThreeNodeSpec();
	const nodes = input.nodes as Array<Record<string, unknown>>;
	nodes.push({
		taskId: "ordered-write",
		agent: "backend-developer",
		task: "Write a nested path after build",
		dependsOn: ["build"],
		sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "src/generated/value.ts" }],
		validationCommands: ["npm test"],
	});
	const compiled = compileGraphSpecV3(input);
	assert.ok(compiled.topologicalOrder.indexOf("ordered-write") > compiled.topologicalOrder.indexOf("build"));
});

test("V3 compiler rejects unordered read-write overlap", () => {
	const input = validThreeNodeSpec();
	const nodes = input.nodes as Array<Record<string, unknown>>;
	nodes.push({
		taskId: "parallel-read",
		agent: "reader",
		task: "Read a concurrently written path",
		sideEffect: "local_read",
		readScope: [{ kind: "file", path: "src/generated/value.ts" }],
	});
	expectGraphError(() => compileGraphSpecV3(input), "SCOPE_CONFLICT");
});

test("V3 compiler requires write scope and validation commands for local_write", () => {
	for (const patch of [
		{ writeScope: [{ kind: "tree", path: "out" }] },
		{ validationCommands: ["npm test"] },
		{ childAcceptance: { criteria: ["looks correct"] }, writeScope: [{ kind: "tree", path: "out" }] },
	]) {
		const input = validThreeNodeSpec();
		(input.nodes as Array<Record<string, unknown>>)[1] = {
			taskId: "build",
			agent: "backend-developer",
			task: "Build",
			dependsOn: ["collect"],
			sideEffect: "local_write",
			...patch,
		};
		expectGraphError(() => compileGraphSpecV3(input), "LOCAL_WRITE_REQUIREMENTS");
	}
});

test("V3 compiler rejects unsafe validation commands", () => {
	const input = validThreeNodeSpec();
	const nodes = input.nodes as Array<Record<string, unknown>>;
	nodes[1]!.validationCommands = ["sh -c true"];
	expectGraphError(() => compileGraphSpecV3(input), "INVALID_VALIDATION_COMMAND");
});

test("V3 compiler rejects external side effects", () => {
	for (const sideEffect of ["external_read", "external_write"]) {
		const input = validThreeNodeSpec();
		(input.nodes as Array<Record<string, unknown>>)[0]!.sideEffect = sideEffect;
		const error = expectGraphError(() => compileGraphSpecV3(input), "UNSUPPORTED_SIDE_EFFECT");
		assert.equal(error.field, "sideEffect");
	}
});

test("V3 compiler rejects governance and model-routing fields structurally", () => {
	for (const field of [
		"model", "thinking", "routingProfile", "taskRisk", "producerRefs", "maxAuthorization", "resolvedModel", "contractPolicy", "context",
		"cwd", "toolBudget", "priority", "resourceClass", "allowDelete", "allowBash",
	]) {
		const input = validThreeNodeSpec();
		(input.nodes as Array<Record<string, unknown>>)[0]![field] = "forbidden";
		const error = expectGraphError(() => compileGraphSpecV3(input), "GOVERNANCE_FIELD_FORBIDDEN");
		assert.equal(error.field, field);
		assert.equal(error.taskId, "collect");
	}
	const planning = validThreeNodeSpec();
	planning.planning = { mode: "automatic" };
	expectGraphError(() => compileGraphSpecV3(planning), "GOVERNANCE_FIELD_FORBIDDEN");
});

test("V3 compiler permits only portable retry policy fields", () => {
	for (const field of ["maxProviderRetries", "providerBackoffMs", "modelDegradations"]) {
		const input = validThreeNodeSpec();
		const node = (input.nodes as Array<Record<string, unknown>>)[1]!;
		node.retryPolicy = { maxAttempts: 2, [field]: 1 };
		const error = expectGraphError(() => compileGraphSpecV3(input), "GOVERNANCE_FIELD_FORBIDDEN");
		assert.equal(error.field, field);
	}
	const invalidReason = validThreeNodeSpec();
	(invalidReason.nodes as Array<Record<string, unknown>>)[1]!.retryPolicy = { maxAttempts: 2, retryOn: ["provider"] };
	expectGraphError(() => compileGraphSpecV3(invalidReason), "INVALID_RETRY_POLICY");
});

test("V3 compiler leaves timeout absent when the source does not declare it", () => {
	const compiled = compileGraphSpecV3(validThreeNodeSpec());
	for (const node of compiled.nodes) {
		assert.equal(Object.hasOwn(node, "timeoutMs"), false);
		assert.equal(Object.hasOwn(node, "deadline"), false);
	}
	const input = validThreeNodeSpec();
	(input.nodes as Array<Record<string, unknown>>)[0]!.timeoutMs = 2_500;
	assert.equal(compileGraphSpecV3(input).nodes[0]?.timeoutMs, 2_500);
});

test("V3 compiler generates deterministic output artifacts and graph IDs", () => {
	const input = validThreeNodeSpec();
	delete input.graphId;
	for (const node of input.nodes as Array<Record<string, unknown>>) delete node.inputArtifacts;
	const first = compileGraphSpecV3(input);
	const second = compileGraphSpecV3(structuredClone(input));
	assert.equal(first.graphId, second.graphId);
	assert.match(first.graphId, /^graph-[a-f0-9]{16}$/u);
	assert.equal(first.nodes[0]?.outputArtifact, `${first.graphId}/collect/out`);
	assert.equal(first.nodes[0]?.outputArtifact, second.nodes[0]?.outputArtifact);
});

test("V3 compiler rejects artifacts not produced by an upstream node", () => {
	const missing = validThreeNodeSpec();
	(missing.nodes as Array<Record<string, unknown>>)[2]!.inputArtifacts = ["missing/out"];
	expectGraphError(() => compileGraphSpecV3(missing), "INVALID_ARTIFACT");

	const sibling = validThreeNodeSpec();
	const nodes = sibling.nodes as Array<Record<string, unknown>>;
	nodes.push({ taskId: "sibling", agent: "reader", task: "Sibling", sideEffect: "none", outputArtifact: "shared/out" });
	nodes[2]!.inputArtifacts = ["shared/out"];
	expectGraphError(() => compileGraphSpecV3(sibling), "INVALID_ARTIFACT");
});

test("V3 compiler rejects duplicate and escaping output artifacts", () => {
	const duplicate = validThreeNodeSpec();
	const duplicateNodes = duplicate.nodes as Array<Record<string, unknown>>;
	duplicateNodes[1]!.outputArtifact = "same/out";
	duplicateNodes[2]!.outputArtifact = "same/out";
	expectGraphError(() => compileGraphSpecV3(duplicate), "INVALID_ARTIFACT");

	const escaping = validThreeNodeSpec();
	(escaping.nodes as Array<Record<string, unknown>>)[0]!.outputArtifact = "../outside";
	expectGraphError(() => compileGraphSpecV3(escaping), "INVALID_ARTIFACT");
});

test("V3 compiler rejects invalid schema versions and unknown fields", () => {
	const wrongVersion = validThreeNodeSpec();
	wrongVersion.schemaVersion = 2;
	expectGraphError(() => compileGraphSpecV3(wrongVersion), "INVALID_SCHEMA_VERSION");

	const unknown = validThreeNodeSpec();
	unknown.unrecognized = true;
	expectGraphError(() => compileGraphSpecV3(unknown), "INVALID_FIELD");
});

test("V3 compiler rejects writeScope on none and local_read nodes", () => {
	for (const sideEffect of ["none", "local_read"]) {
		const input = validThreeNodeSpec();
		const node = (input.nodes as Array<Record<string, unknown>>)[0]!;
		node.sideEffect = sideEffect;
		node.writeScope = [{ kind: "file", path: "out/value.txt" }];
		const error = expectGraphError(() => compileGraphSpecV3(input), "INVALID_SCOPE");
		assert.equal(error.taskId, "collect");
		assert.equal(error.field, "writeScope");
	}
});

test("V3 compiler rejects protected control paths in scopes and artifacts", () => {
	const protectedPaths = [
		".git", "nested/.git/config", ".pi-graph/runs", ".pi/settings.json", ".pi/agents/worker", ".pi-agents/worker", ".pi-subagents/run",
	];
	for (const path of protectedPaths) {
		const readInput = validThreeNodeSpec();
		(readInput.nodes as Array<Record<string, unknown>>)[0]!.readScope = [{ kind: "tree", path }];
		expectGraphError(() => compileGraphSpecV3(readInput), "INVALID_SCOPE");

		const writeInput = validThreeNodeSpec();
		(writeInput.nodes as Array<Record<string, unknown>>)[1]!.writeScope = [{ kind: "tree", path }];
		expectGraphError(() => compileGraphSpecV3(writeInput), "INVALID_SCOPE");

		const artifactInput = validThreeNodeSpec();
		(artifactInput.nodes as Array<Record<string, unknown>>)[0]!.outputArtifact = path;
		expectGraphError(() => compileGraphSpecV3(artifactInput), "INVALID_ARTIFACT");
	}
	const normal = validThreeNodeSpec();
	(normal.nodes as Array<Record<string, unknown>>)[0]!.readScope = [{ kind: "tree", path: ".github/workflows" }];
	assert.equal(compileGraphSpecV3(normal).nodes[0]?.readScope[0]?.path, ".github/workflows");
});

test("V3 compiler rejects output artifact ancestor and descendant collisions", () => {
	const input = {
		schemaVersion: 3,
		graphId: "artifacts",
		goal: "Check artifact prefixes",
		nodes: [
			{ taskId: "left", agent: "reader", task: "Left", sideEffect: "none", outputArtifact: "foo" },
			{ taskId: "right", agent: "reader", task: "Right", sideEffect: "none", outputArtifact: "foo/bar" },
		],
	};
	expectGraphError(() => compileGraphSpecV3(input), "INVALID_ARTIFACT");
	(input.nodes[1] as Record<string, unknown>).outputArtifact = "foobar/result";
	assert.equal(compileGraphSpecV3(input).nodes.length, 2);
});

test("V3 compiler enforces the maxConcurrency hard ceiling", () => {
	const accepted = validThreeNodeSpec();
	accepted.maxConcurrency = 64;
	assert.equal(compileGraphSpecV3(accepted).maxConcurrency, 64);
	const rejected = validThreeNodeSpec();
	rejected.maxConcurrency = 65;
	expectGraphError(() => compileGraphSpecV3(rejected), "INVALID_GRAPH_SPEC");
});
