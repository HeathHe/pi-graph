import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
	bindGraphNodesWithRoutingV3,
	bindGraphSpecWithRoutingV3,
	observeJevRoutingShadowV3,
	readAcceptedProducerModelsV3,
	type RoutingAdmissionOptionsV3,
} from "../extensions/routing-admission.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import type { V3AgentLaunchPreflightInput } from "../src/v3/preflight.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

const DIGEST = "d".repeat(64);
const NO_EXTENSIONS = { runtimeExtensions: [], configuredExtensions: [], extensionArgs: [], disableAmbientExtensions: true };

function catalog(profile = "backend-standard"): Record<string, unknown> {
	return {
		schemaVersion: 1,
		capabilities: [{ capabilityId: "implement.backend", agent: "backend-developer", routingProfile: profile }],
	};
}

function policy(candidates: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		enforcement: "graph-admission",
		quarantinedProviderDomains: [],
		profiles: { "backend-standard": { candidates } },
		...extra,
	};
}

function graph(model?: string): Record<string, unknown> {
	return {
		schemaVersion: 3,
		graphId: "routing-test",
		goal: "Route one bounded implementation",
		nodes: [{ taskId: "work", capabilityId: "implement.backend", ...(model ? { model } : {}), task: "Inspect one bounded unit", sideEffect: "none" }],
	};
}

async function fixture(policyValue: Record<string, unknown>, catalogValue = catalog()) {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-routing-"));
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "routing-policy.json"), `${JSON.stringify(policyValue)}\n`);
	await writeFile(join(root, "subagent-capabilities.json"), `${JSON.stringify(catalogValue)}\n`);
	await writeFile(join(root, "models.json"), `${JSON.stringify({ providers: {} })}\n`);
	return root;
}

function fakePreflight(observed: V3AgentLaunchPreflightInput[], reject = new Set<string>()): NonNullable<RoutingAdmissionOptionsV3["preflightAgent"]> {
	return async (input) => {
		observed.push(structuredClone(input));
		if (input.model && reject.has(input.model)) return { ok: false, message: `model ${input.model} unavailable` };
		return {
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DIGEST,
			launchContractDigest: DIGEST,
			model: input.model,
			modelCandidates: input.model ? [input.model] : [],
			thinking: typeof input.thinking === "string" ? input.thinking : undefined,
			extensions: NO_EXTENSIONS,
			toolAllowlist: ["read"],
			explicitToolAllowlist: true,
		};
	};
}

test("extension routing admission selects the first candidate that passes original preflight", async () => {
	const root = await fixture(policy([
		{ model: "wisdomrouter/glm-5.3", thinking: "high", level: "L0" },
		{ model: "kimi-coding/k3", thinking: "high", level: "L1" },
	]));
	const observed: V3AgentLaunchPreflightInput[] = [];
	try {
		const bound = await bindGraphSpecWithRoutingV3(graph(), {
			agentDir: root,
			cwd: root,
			disableNetwork: true,
			preflightAgent: fakePreflight(observed, new Set(["wisdomrouter/glm-5.3"])),
		});
		assert.equal(bound.spec.nodes[0]?.launch?.requestedModel, "kimi-coding/k3");
		assert.equal(bound.routingAdmission.decisions[0]?.selectedModel, "kimi-coding/k3");
		assert.deepEqual(bound.routingAdmission.decisions[0]?.skipped, [{ model: "wisdomrouter/glm-5.3", reason: "model wisdomrouter/glm-5.3 unavailable" }]);
		assert.equal(bound.routingAdmission.jevShadow.status, "disabled");
		assert.deepEqual(observed.map((entry) => entry.model), ["wisdomrouter/glm-5.3", "kimi-coding/k3", "kimi-coding/k3"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("explicit model outside the routing profile fails closed", async () => {
	const root = await fixture(policy([{ model: "wisdomrouter/glm-5.3", thinking: "high", level: "L0" }]));
	try {
		await assert.rejects(
			() => bindGraphSpecWithRoutingV3(graph("xai/grok-4.7"), { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: fakePreflight([]) }),
			(error: unknown) => error instanceof GraphV3Error && /outside routing profile/u.test(error.message),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("routing policy changes replace a model without changing the capability or GraphSpec", async () => {
	const root = await fixture(policy([{ model: "wisdomrouter/glm-5.3", thinking: "high", level: "L0" }]));
	try {
		const options = { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: fakePreflight([]) };
		const first = await bindGraphSpecWithRoutingV3(graph(), options);
		await writeFile(join(root, "routing-policy.json"), `${JSON.stringify(policy([{ model: "kimi-coding/k3", thinking: "high", level: "L0" }]))}\n`);
		const second = await bindGraphSpecWithRoutingV3(graph(), options);
		assert.equal(first.routingAdmission.decisions[0]?.selectedModel, "wisdomrouter/glm-5.3");
		assert.equal(second.routingAdmission.decisions[0]?.selectedModel, "kimi-coding/k3");
		assert.deepEqual(first.routingAdmission.decisions[0]?.capabilityIds, second.routingAdmission.decisions[0]?.capabilityIds);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("one admission reuses one captured catalog and policy snapshot for routing and Binding", async () => {
	const initialPolicy = policy([{ model: "wisdomrouter/glm-5.3", thinking: "high", level: "L0" }]);
	const root = await fixture(initialPolicy);
	let mutated = false;
	const observed: V3AgentLaunchPreflightInput[] = [];
	const preflight: NonNullable<RoutingAdmissionOptionsV3["preflightAgent"]> = async (input) => {
		observed.push(structuredClone(input));
		if (!mutated) {
			mutated = true;
			await writeFile(join(root, "routing-policy.json"), `${JSON.stringify(policy([{ model: "kimi-coding/k3", thinking: "high", level: "L0" }]))}\n`);
			await writeFile(join(root, "subagent-capabilities.json"), `${JSON.stringify({
				schemaVersion: 1,
				capabilities: [{ capabilityId: "implement.backend", agent: "replacement-agent", routingProfile: "backend-standard" }],
			})}\n`);
		}
		return {
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DIGEST,
			launchContractDigest: DIGEST,
			model: input.model,
			modelCandidates: input.model ? [input.model] : [],
			thinking: typeof input.thinking === "string" ? input.thinking : undefined,
			extensions: NO_EXTENSIONS,
			toolAllowlist: ["read"],
			explicitToolAllowlist: true,
		};
	};
	try {
		const options = { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: preflight };
		const current = await bindGraphSpecWithRoutingV3(graph(), options);
		assert.equal(current.routingAdmission.decisions[0]?.agent, "backend-developer");
		assert.equal(current.spec.nodes[0]?.agent, "backend-developer");
		assert.equal(current.routingAdmission.decisions[0]?.selectedModel, "wisdomrouter/glm-5.3");
		assert.equal(current.routingAdmission.catalogDigest, current.catalog?.digest);
		assert.equal(current.routingAdmission.catalogDigest, current.spec.nodes[0]?.binding?.catalogDigest);

		const next = await bindGraphSpecWithRoutingV3(graph(), options);
		assert.equal(next.routingAdmission.decisions[0]?.agent, "replacement-agent");
		assert.equal(next.spec.nodes[0]?.agent, "replacement-agent");
		assert.equal(next.routingAdmission.decisions[0]?.selectedModel, "kimi-coding/k3");
		assert.notEqual(current.routingAdmission.catalogDigest, next.routingAdmission.catalogDigest);
		assert.deepEqual(observed.map((entry) => entry.agent), ["backend-developer", "backend-developer", "replacement-agent", "replacement-agent"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("explicit catalog is the sole captured source for both routing and Binding", async () => {
	const root = await fixture(policy([{ model: "wisdomrouter/glm-5.3", level: "L0" }]), {
		schemaVersion: 1,
		capabilities: [{ capabilityId: "implement.backend", agent: "file-agent", routingProfile: "backend-standard" }],
	});
	try {
		const injected = {
			schemaVersion: 1,
			capabilities: [{ capabilityId: "implement.backend", agent: "injected-agent", routingProfile: "backend-standard" }],
		};
		const bound = await bindGraphSpecWithRoutingV3(graph(), {
			agentDir: root,
			cwd: root,
			catalog: injected,
			disableNetwork: true,
			preflightAgent: fakePreflight([]),
		});
		assert.equal(bound.routingAdmission.decisions[0]?.agent, "injected-agent");
		assert.equal(bound.spec.nodes[0]?.agent, "injected-agent");
		assert.equal(bound.routingAdmission.catalogDigest, bound.catalog?.digest);
		assert.equal(bound.routingAdmission.catalogDigest, bound.spec.nodes[0]?.binding?.catalogDigest);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("start and append bindings share the same routing admission", async () => {
	const root = await fixture(policy([{ model: "kimi-coding/k3", thinking: "high", level: "L0" }]));
	try {
		const options = { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: fakePreflight([]) };
		const start = await bindGraphSpecWithRoutingV3(graph(), options);
		const append = await bindGraphNodesWithRoutingV3((graph() as { nodes: unknown[] }).nodes, options);
		assert.equal(start.routingAdmission.decisions[0]?.selectedModel, "kimi-coding/k3");
		assert.equal(append.routingAdmission.decisions[0]?.selectedModel, "kimi-coding/k3");
		assert.equal(append.nodes[0]?.launch?.requestedModel, "kimi-coding/k3");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cross-family routing uses a same-batch fixed Agent producer's preflight-resolved model", async () => {
	const reviewPolicy = {
		schemaVersion: 1,
		enforcement: "graph-admission",
		quarantinedProviderDomains: [],
		profiles: {
			review: {
				candidates: [
					{ model: "kimi-coding/k3", thinking: "high", level: "L0" },
					{ model: "wisdomrouter/glm-5.3", thinking: "high", level: "L1" },
				],
				constraints: { requireCrossFamilyFromProducers: true, producerSource: "accepted_manifests" },
			},
		},
	};
	const root = await fixture(reviewPolicy, {
		schemaVersion: 1,
		capabilities: [{ capabilityId: "review.code", agent: "reviewer", routingProfile: "review" }],
	});
	const observed: V3AgentLaunchPreflightInput[] = [];
	const preflight: NonNullable<RoutingAdmissionOptionsV3["preflightAgent"]> = async (input) => {
		observed.push(structuredClone(input));
		const model = input.agent === "producer" ? "kimi-coding/k3" : input.model;
		return {
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DIGEST,
			launchContractDigest: DIGEST,
			...(model ? { model } : {}),
			modelCandidates: model ? [model] : [],
			extensions: NO_EXTENSIONS,
			toolAllowlist: ["read"],
			explicitToolAllowlist: true,
		};
	};
	try {
		const bound = await bindGraphSpecWithRoutingV3({
			schemaVersion: 3,
			graphId: "same-batch-producer",
			goal: "Review producer output",
			nodes: [
				{ taskId: "produce", agent: "producer", task: "Produce", sideEffect: "none" },
				{ taskId: "review", capabilityId: "review.code", task: "Review", dependsOn: ["produce"], sideEffect: "none" },
			],
		}, { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: preflight });
		assert.equal(bound.routingAdmission.decisions[0]?.selectedModel, "wisdomrouter/glm-5.3");
		assert.deepEqual(bound.routingAdmission.decisions[0]?.skipped, [{ model: "kimi-coding/k3", reason: "producer_family_conflict" }]);
		assert.equal(observed.some((entry) => entry.agent === "reviewer" && entry.model === "kimi-coding/k3"), false, "conflicting candidate must be rejected before its preflight");
		const producer = bound.spec.nodes.find((node) => node.taskId === "produce");
		assert.equal(producer?.binding?.resolvedAgent, "producer");
		assert.equal(producer?.binding?.agentDefinitionDigest, DIGEST);
		assert.equal(producer?.launch?.requestedModel, "kimi-coding/k3");
		assert.equal(producer?.launch?.resolvedModel, "kimi-coding/k3");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("same-batch fixed producer rejects identity drift between routing and final Binding", async () => {
	const reviewPolicy = {
		schemaVersion: 1,
		enforcement: "graph-admission",
		quarantinedProviderDomains: [],
		profiles: {
			review: {
				candidates: [
					{ model: "kimi-coding/k3", thinking: "high", level: "L0" },
					{ model: "wisdomrouter/glm-5.3", thinking: "high", level: "L1" },
				],
				constraints: { requireCrossFamilyFromProducers: true, producerSource: "accepted_manifests" },
			},
		},
	};
	const root = await fixture(reviewPolicy, {
		schemaVersion: 1,
		capabilities: [{ capabilityId: "review.code", agent: "reviewer", routingProfile: "review" }],
	});
	let producerPreflightCount = 0;
	const preflight: NonNullable<RoutingAdmissionOptionsV3["preflightAgent"]> = async (input) => {
		const model = input.agent === "producer"
			? (++producerPreflightCount === 1 ? "kimi-coding/k3" : "wisdomrouter/glm-5.3")
			: input.model;
		return {
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DIGEST,
			launchContractDigest: DIGEST,
			...(model ? { model } : {}),
			modelCandidates: model ? [model] : [],
			extensions: NO_EXTENSIONS,
			toolAllowlist: ["read"],
			explicitToolAllowlist: true,
		};
	};
	try {
		await assert.rejects(
			() => bindGraphSpecWithRoutingV3({
				schemaVersion: 3,
				graphId: "same-batch-producer-drift",
				goal: "Reject producer identity drift",
				nodes: [
					{ taskId: "produce", agent: "producer", task: "Produce", sideEffect: "none" },
					{ taskId: "review", capabilityId: "review.code", task: "Review", dependsOn: ["produce"], sideEffect: "none" },
				],
			}, { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: preflight }),
			(error: unknown) => error instanceof GraphV3Error && /diverged for fixed producer/u.test(error.message),
		);
		assert.equal(producerPreflightCount, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cross-family routing never substitutes a routed producer's selected model for its resolved identity", async () => {
	const root = await fixture({
		schemaVersion: 1,
		enforcement: "graph-admission",
		quarantinedProviderDomains: [],
		profiles: {
			produce: { candidates: [{ model: "kimi-coding/k3", level: "L0" }] },
			review: {
				candidates: [{ model: "xai/grok-4.7", level: "L0" }, { model: "wisdomrouter/glm-5.3", level: "L1" }],
				constraints: { requireCrossFamilyFromProducers: true, producerSource: "accepted_manifests" },
			},
		},
	}, {
		schemaVersion: 1,
		capabilities: [
			{ capabilityId: "produce.code", agent: "producer", routingProfile: "produce" },
			{ capabilityId: "review.code", agent: "reviewer", routingProfile: "review" },
		],
	});
	const preflight: NonNullable<RoutingAdmissionOptionsV3["preflightAgent"]> = async (input) => {
		const model = input.agent === "producer" ? "xai/grok-4.7" : input.model;
		return {
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DIGEST,
			launchContractDigest: DIGEST,
			...(model ? { model } : {}),
			modelCandidates: model ? [model] : [],
			extensions: NO_EXTENSIONS,
			toolAllowlist: ["read"],
			explicitToolAllowlist: true,
		};
	};
	try {
		const bound = await bindGraphSpecWithRoutingV3({
			schemaVersion: 3,
			graphId: "resolved-producer-identity",
			goal: "Review routed producer output",
			nodes: [
				{ taskId: "produce", capabilityId: "produce.code", task: "Produce", sideEffect: "none" },
				{ taskId: "review", capabilityId: "review.code", task: "Review", dependsOn: ["produce"], sideEffect: "none" },
			],
		}, { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: preflight });
		const producer = bound.routingAdmission.decisions.find((entry) => entry.taskId === "produce");
		const reviewer = bound.routingAdmission.decisions.find((entry) => entry.taskId === "review");
		assert.equal(producer?.selectedModel, "kimi-coding/k3");
		assert.equal(producer?.resolvedModel, "xai/grok-4.7");
		assert.equal(reviewer?.selectedModel, "wisdomrouter/glm-5.3");
		assert.deepEqual(reviewer?.skipped, [{ model: "xai/grok-4.7", reason: "producer_family_conflict" }]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cross-family append uses trusted existing producer evidence and fails closed when it is absent", async () => {
	const reviewPolicy = {
		schemaVersion: 1,
		enforcement: "graph-admission",
		quarantinedProviderDomains: [],
		profiles: {
			review: {
				candidates: [
					{ model: "kimi-coding/k3", level: "L0" },
					{ model: "wisdomrouter/glm-5.3", level: "L1" },
				],
				constraints: { requireCrossFamilyFromProducers: true, producerSource: "accepted_manifests" },
			},
		},
	};
	const root = await fixture(reviewPolicy, {
		schemaVersion: 1,
		capabilities: [{ capabilityId: "review.code", agent: "reviewer", routingProfile: "review" }],
	});
	const nodes = [{ taskId: "review", capabilityId: "review.code", task: "Review accepted producer", dependsOn: ["accepted-producer"], sideEffect: "none" }];
	try {
		const admitted = await bindGraphNodesWithRoutingV3(nodes, {
			agentDir: root,
			cwd: root,
			disableNetwork: true,
			preflightAgent: fakePreflight([]),
			trustedProducerModels: { "accepted-producer": { model: "kimi-coding/k3", source: "accepted-frozen-resolved", attempt: 1 } },
		});
		assert.equal(admitted.routingAdmission.decisions[0]?.selectedModel, "wisdomrouter/glm-5.3");
		assert.deepEqual(admitted.routingAdmission.decisions[0]?.skipped, [{ model: "kimi-coding/k3", reason: "producer_family_conflict" }]);
		await assert.rejects(
			() => bindGraphNodesWithRoutingV3(nodes, { agentDir: root, cwd: root, disableNetwork: true, preflightAgent: fakePreflight([]) }),
			(error: unknown) => error instanceof GraphV3Error && /lacks trusted producer model identity/u.test(error.message),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("accepted existing producer identity comes from verified Attempt plus frozen resolved evidence", async () => {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "pi-graph-routing-accepted-")));
	const sourceDir = join(sandbox, "source");
	const runsDir = join(sandbox, "runs");
	await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(runsDir, { recursive: true })]);
	const launchBase = { schemaVersion: 1 as const, requestedModel: "kimi-coding/k3", resolvedModel: "kimi-coding/k3" };
	const mock = new MockSubagents();
	mock.behaviors.set("ACCEPTED_PRODUCER", (input) => completeChild({ ...input, output: "accepted" }));
	mock.start();
	try {
		const spec: GraphSpecV3 = {
			schemaVersion: 3,
			graphId: "accepted-producer-evidence",
			goal: "Create accepted producer evidence",
			nodes: [{
				taskId: "producer",
				agent: "producer",
				task: "ACCEPTED_PRODUCER",
				sideEffect: "none",
				launch: { ...launchBase, hintDigest: canonicalDigest(launchBase) },
			}],
		};
		const host = new V3GraphHost({ rpc: new SubagentRpcClient(mock), runsDir, sessionId: "routing-test", supervisorEpoch: "routing-epoch", preflightAgent: async () => undefined });
		const started = await host.start(spec, sourceDir);
		const terminal = await host.waitForCompletion(started.graphId);
		assert.equal(terminal.status, "complete");
		const evidence = await readAcceptedProducerModelsV3({
			runDir: started.runDir,
			graph: started.graph,
			runInstanceId: terminal.runInstanceId,
			taskIds: ["producer"],
		});
		assert.deepEqual(evidence.producer, { model: "kimi-coding/k3", source: "accepted-frozen-resolved", attempt: 1 });
	} finally {
		await mock.dispose();
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("Jev shadow always requests jev-latest, validates the closed choice set, and records the actual model", async () => {
	let requestBody: Record<string, unknown> | undefined;
	const observation = await observeJevRoutingShadowV3({
		enabled: true,
		endpoint: "https://wisdomrouter.relayflare.com/v1/systemone",
		model: "jev-latest",
		timeoutMs: 1_000,
		credential: { provider: "wisdomrouter", env: "TEST_WISDOM_KEY" },
		choices: ["fast", "deep", "research", "review", "human"],
	}, {
		goal: "Classify only",
		nodes: (graph() as { nodes: any[] }).nodes,
		decisions: [],
	}, {
		environment: { TEST_WISDOM_KEY: "test-secret" },
		fetchFn: async (_input, init) => {
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(JSON.stringify({ model: "jev-1.14.0", answers: { route: { type: "choice", choice: "deep", confidence: 0.82 } }, usage: { input_tokens: 12, output_tokens: 4 } }), { status: 200 });
		},
	}, "/does/not/matter.json");
	assert.equal(requestBody?.model, "jev-latest");
	assert.deepEqual(observation, { status: "observed", requestedModel: "jev-latest", actualModel: "jev-1.14.0", choice: "deep", confidence: 0.82 });
});

test("Jev shadow is observational: invalid choices return an error record instead of a route", async () => {
	const observation = await observeJevRoutingShadowV3({
		enabled: true,
		endpoint: "https://wisdomrouter.relayflare.com/v1/systemone",
		model: "jev-latest",
		timeoutMs: 1_000,
		credential: { provider: "wisdomrouter", env: "TEST_WISDOM_KEY" },
		choices: ["fast", "deep", "research", "review", "human"],
	}, { goal: "Classify", nodes: [], decisions: [] }, {
		environment: { TEST_WISDOM_KEY: "test-secret" },
		fetchFn: async () => new Response(JSON.stringify({ model: "jev-1.14.0", answers: { route: { type: "choice", choice: "concrete-model" } } }), { status: 200 }),
	}, "/does/not/matter.json");
	assert.deepEqual(observation, { status: "error", reason: "choice_outside_closed_set" });
});

const JEV_TEST_CONFIG = {
	enabled: true,
	endpoint: "https://example.invalid/v1/systemone",
	model: "jev-latest" as const,
	timeoutMs: 1_000,
	credential: { provider: "test-provider", env: "TEST_JEV_KEY" },
	choices: ["fast", "deep", "research", "review", "human"] as Array<"fast" | "deep" | "research" | "review" | "human">,
};
const JEV_TEST_RESPONSE = { model: "jev-test", answers: { route: { type: "choice", choice: "fast" } } };

test("Jev sends only host-resolved credentials for command, env-reference and literal provider config", async () => {
	const jiti = createJiti(import.meta.url);
	const { bindingOptionsFromContextV3 } = await jiti.import("../extensions/pi-graph.ts") as any;
	const root = await mkdtemp(join(tmpdir(), "pi-graph-jev-host-"));
	try {
		for (const raw of ["!fake-read-only-key-command", "FAKE_PROVIDER_KEY_ENV", "fake-literal-provider-key"]) {
			const modelsPath = join(root, "models.json");
			await writeFile(modelsPath, JSON.stringify({ providers: { "test-provider": { apiKey: raw } } }));
			const calls: string[] = [];
			const registry = {
				getAvailable: () => [],
				getRegisteredProviderIds: () => [],
				async getApiKeyForProvider(provider: string) {
					assert.equal(this, registry, "the callback must retain its host receiver");
					calls.push(provider);
					return "host-resolved-test-token";
				},
			};
			const options = bindingOptionsFromContextV3({ cwd: root, modelRegistry: registry }, false);
			let sentAuthorization: string | null = null;
			const observation = await observeJevRoutingShadowV3(JEV_TEST_CONFIG, { goal: "A plain test", nodes: [], decisions: [] }, {
				...options,
				environment: {},
				fetchFn: async (_input, init) => {
					sentAuthorization = new Headers(init?.headers).get("authorization");
					return new Response(JSON.stringify(JEV_TEST_RESPONSE), { status: 200 });
				},
			}, modelsPath);
			assert.deepEqual(calls, ["test-provider"]);
			assert.equal(sentAuthorization, "Bearer host-resolved-test-token");
			assert.notEqual(sentAuthorization, `Bearer ${raw}`, "raw provider references must never be sent");
			assert.equal(observation.status, "observed");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Jev environment credential takes priority without calling the host resolver", async () => {
	const observation = await observeJevRoutingShadowV3(JEV_TEST_CONFIG, { goal: "A plain test", nodes: [], decisions: [] }, {
		environment: { TEST_JEV_KEY: " env-test-token " },
		getApiKeyForProvider: async () => { assert.fail("environment credential must bypass the resolver"); },
		fetchFn: async (_input, init) => {
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer env-test-token");
			return new Response(JSON.stringify(JEV_TEST_RESPONSE), { status: 200 });
		},
	}, "/unused/models.json");
	assert.equal(observation.status, "observed");
});

test("Jev never falls back to raw config when no resolver is available", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-jev-no-resolver-"));
	try {
		const modelsPath = join(root, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { "test-provider": { apiKey: "!fake-key-command-must-not-execute" } } }));
		const observation = await observeJevRoutingShadowV3(JEV_TEST_CONFIG, { goal: "A plain test", nodes: [], decisions: [] }, {
			environment: {},
			fetchFn: async () => { assert.fail("raw config is not a usable credential"); },
		}, modelsPath);
		assert.deepEqual(observation, { status: "disabled", reason: "credential_unavailable" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing credentials and host resolver errors do not block Graph admission or expose secrets", async () => {
	const root = await fixture(policy([{ model: "kimi-coding/k3", thinking: "high", level: "L1" }], { jevShadow: JEV_TEST_CONFIG }));
	try {
		for (const resolver of [async () => undefined, async () => { throw new Error("SENSITIVE_RESOLVER_DETAIL fake-token"); }]) {
			const bound = await bindGraphSpecWithRoutingV3(graph(), {
				cwd: root,
				agentDir: root,
				environment: {},
				getApiKeyForProvider: resolver,
				preflightAgent: fakePreflight([]),
				fetchFn: async () => { assert.fail("unavailable credentials must skip the network"); },
			});
			assert.equal(bound.routingAdmission.decisions[0]?.selectedModel, "kimi-coding/k3");
			assert.deepEqual(bound.routingAdmission.jevShadow, { status: "disabled", reason: "credential_unavailable" });
			assert.doesNotMatch(JSON.stringify(bound.routingAdmission), /SENSITIVE_RESOLVER_DETAIL|fake-token/);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


test("routing profile unknown diagnostics do not probe a second candidate",async()=>{
 const root=await fixture(policy([{model:"wisdomrouter/glm-5.3",thinking:"high",level:"L0"},{model:"kimi-coding/k3",thinking:"high",level:"L1"}]));
 const observed:string[]=[];
 try {await assert.rejects(bindGraphSpecWithRoutingV3(graph(),{agentDir:root,cwd:root,disableNetwork:true,preflightAgent:async input=>{observed.push(input.model??"");return {ok:false,message:"parse response 429 bytes"};}}),/without eligible provider evidence/);assert.deepEqual(observed,["wisdomrouter/glm-5.3"]);}finally{await rm(root,{recursive:true,force:true});}
});
