import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorizationV4For, validateAuthorizationV4 } from "../src/v3/authorization.ts";
import {
	bindGraphNodesV3,
	bindGraphSpecV3,
	readV3CapabilityCatalog,
	validateV3CapabilityCatalog,
	type V3BindingOptions,
} from "../src/v3/binding.ts";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { parseV3GraphConfig } from "../src/v3/config.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import { v3PreflightAgentLaunch, v3NativeToolCeiling } from "../src/v3/preflight.ts";
import type { V3AgentLaunchPreflightInput } from "../src/v3/preflight.ts";

const DEFINITION_DIGEST = "d".repeat(64);
const LAUNCH_DIGEST = "e".repeat(64);
const NO_EXTENSIONS = {
	runtimeExtensions: [],
	configuredExtensions: [],
	extensionArgs: [],
	disableAmbientExtensions: true,
};

function catalog(capabilities: unknown[] = [
	{ capabilityId: "discover.code", agent: "code-scout", routingProfile: "code-discovery" },
	{ capabilityId: "review.code", agent: "reviewer", modelPolicy: { mode: "fixed", model: "provider/reviewer:high" } },
	{ capabilityId: "review.spec", agent: "reviewer", modelPolicy: { mode: "cross-family-from-producer" } },
]): Record<string, unknown> {
	return { schemaVersion: 1, description: "test catalog", capabilities };
}

function spec(node: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 3,
		graphId: "binding-test",
		goal: "Bind public capability authoring before execution",
		nodes: [{ taskId: "work", task: "Do bounded work", sideEffect: "none", ...node }],
		...extra,
	};
}

function fakePreflight(observed: V3AgentLaunchPreflightInput[] = []): NonNullable<V3BindingOptions["preflightAgent"]> {
	return async (input) => {
		observed.push(structuredClone(input));
		return {
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DEFINITION_DIGEST,
			launchContractDigest: LAUNCH_DIGEST,
			modelCandidates: input.model ? [input.model] : [],
			extensions: NO_EXTENSIONS,
			...(input.model ? { model: input.model } : {}),
			...(typeof input.thinking === "string" ? { thinking: input.thinking } : {}),
		};
	};
}

async function expectBindingError(operation: () => Promise<unknown>): Promise<GraphV3Error> {
	let received: unknown;
	try {
		await operation();
	} catch (error) {
		received = error;
	}
	assert.ok(received instanceof GraphV3Error, `expected GraphV3Error, received ${String(received)}`);
	assert.equal(received.code, "CAPABILITY_BINDING_FAILED");
	return received;
}

test("Binding resolves strict capability authoring to exact Agent and freezes catalog/launch evidence", async () => {
	const observed: V3AgentLaunchPreflightInput[] = [];
	const result = await bindGraphSpecV3(spec({
		capabilityId: "review.code",
		thinking: "high",
		turnBudget: { maxTurns: 8, graceTurns: 2 },
		toolBudget: { soft: 8, hard: 12, block: ["grep", "read"] },
		maxTokens: 20_000,
	}, { contractPolicy: "strict" }), {
		cwd: process.cwd(),
		catalog: catalog(),
		preflightAgent: fakePreflight(observed),
	});

	assert.equal(result.spec.bindingPolicy, "strict");
	assert.equal(Object.hasOwn(result.spec, "contractPolicy"), false);
	const node = result.spec.nodes[0]!;
	assert.equal(node.agent, "reviewer");
	assert.equal(Object.hasOwn(node, "capabilityId"), false);
	assert.equal(Object.hasOwn(node, "requires"), false);
	assert.deepEqual(node.binding?.capabilityIds, ["review.code"]);
	assert.equal(node.binding?.resolution, "capability-catalog");
	assert.equal(node.binding?.capabilityEntries?.[0]?.agent, "reviewer");
	assert.equal(node.binding?.agentDefinitionDigest, DEFINITION_DIGEST);
	assert.equal(node.binding?.admissionLaunchContractDigest, LAUNCH_DIGEST);
	assert.equal(node.launch?.requestedModel, undefined);
	assert.equal(node.launch?.resolvedModel, "provider/reviewer:high");
	assert.equal(node.launch?.maxTokens, 20_000);
	assert.equal(node.launch?.usageBudget, undefined, "maxTokens is not a reported-usage launch budget");
	assert.equal(observed[0]?.model, "provider/reviewer:high");
	assert.equal(observed[0]?.agentScope, "both");
	assert.deepEqual(observed[0]?.turnBudget, { maxTurns: 8, graceTurns: 2 });
	assert.equal(result.compiled.graphDigest, compileGraphSpecV3(result.spec).graphDigest);
});

test("explicit generalist backstop binds in strict mode without absorbing unknown capabilities", async () => {
	const backstopCatalog = catalog([{ capabilityId: "execute.generalist", agent: "generalist", routingProfile: "explicit-parent-backstop-only" }]);
	const bound = await bindGraphSpecV3(spec({ capabilityId: "execute.generalist" }, { contractPolicy: "strict" }), {
		catalog: backstopCatalog,
		preflightAgent: fakePreflight(),
	});
	assert.equal(bound.spec.nodes[0]?.agent, "generalist");
	assert.deepEqual(bound.spec.nodes[0]?.binding?.capabilityIds, ["execute.generalist"]);
	await expectBindingError(() => bindGraphSpecV3(spec({ capabilityId: "execute.unknown" }, { contractPolicy: "strict" }), {
		catalog: backstopCatalog,
		preflightAgent: fakePreflight(),
	}));
});

test("strict model scope denies unauthorized GPT and admits explicit role authorization", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-graph-no-gpt-project-"));
	try {
		await mkdir(join(project, ".pi", "agents"), { recursive: true });
		await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({
			subagents: {
				defaultModel: "wisdomrouter/gpt-6-sol",
				modelScope: { enforce: true, strict: true, allow: ["wisdomrouter/glm-5.3"] },
			},
		}));
		for (const [agent, model] of [["gpt-probe", "wisdomrouter/gpt-6-sol"], ["plain-probe", ""], ["glm-probe", "wisdomrouter/glm-5.3"]]) {
			await writeFile(join(project, ".pi", "agents", `${agent}.md`), `---\nname: ${agent}\ndescription: Model scope probe\n${model ? `model: ${model}\n` : ""}tools: read\n---\nProbe.\n`);
		}
		const base = {
			task: "Inspect one file",
			cwd: project,
			parentModel: { provider: "wisdomrouter", id: "gpt-6-astra" },
			availableModels: [
				{ provider: "wisdomrouter", id: "gpt-6-sol", fullId: "wisdomrouter/gpt-6-sol" },
				{ provider: "wisdomrouter", id: "glm-5.3", fullId: "wisdomrouter/glm-5.3" },
			],
		};
		for (const [agent, model] of [["gpt-probe", undefined], ["plain-probe", undefined], ["glm-probe", "wisdomrouter/gpt-6-sol"]] as const) {
			const result = await v3PreflightAgentLaunch({ ...base, agent, ...(model ? { model } : {}) });
			assert.equal(result.ok, false, `${agent} must not launch a GPT Graph child`);
			if (!result.ok) assert.match(result.message, /outside the configured Agent model scope/u);
		}
		const allowed = await v3PreflightAgentLaunch({ ...base, agent: "glm-probe" });
		assert.equal(allowed.ok, true, "non-GPT Graph child must remain available");
		await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({subagents:{defaultModel:"wisdomrouter/gpt-6-sol",modelScope:{enforce:true,strict:true,allow:["wisdomrouter/gpt-6-sol","wisdomrouter/glm-5.3"],agents:{"gpt-probe":{allow:["wisdomrouter/gpt-6-sol"]},"plain-probe":{allow:["wisdomrouter/glm-5.3"]},"glm-probe":{allow:["wisdomrouter/glm-5.3"]}}}}}));
		const authorized=await v3PreflightAgentLaunch({...base,agent:"gpt-probe"});
		assert.equal(authorized.ok,true,"explicit role scope authorizes the registered GPT model");
		if(authorized.ok)assert.equal(authorized.model,"wisdomrouter/gpt-6-sol");
		for(const agent of ["plain-probe","glm-probe"]){const denied=await v3PreflightAgentLaunch({...base,agent,model:"wisdomrouter/gpt-6-sol"});assert.equal(denied.ok,false);if(!denied.ok)assert.match(denied.message,/outside the configured Agent model scope/u);}

	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("Graph rejects toolFilter names absent from the selected Agent's real Pi tool plan", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-graph-tool-filter-"));
	try {
		await mkdir(join(project, ".pi", "agents"), { recursive: true });
		await writeFile(join(project, ".pi", "agents", "backend-probe.md"),
			"---\nname: backend-probe\ndescription: Tool filter probe\nmodel: wisdomrouter/glm-5.3\ntools: read, grep, find, ls, bash, edit, write, contact_supervisor\nextensions:\n---\nProbe.\n");
		await writeFile(join(project, ".pi", "agents", "review-probe.md"),
			"---\nname: review-probe\ndescription: Read only tool probe\nmodel: wisdomrouter/glm-5.3\ntools: read, grep, find, ls, contact_supervisor\nextensions:\n---\nProbe.\n");
		const options = {
			cwd: project,
			parentModel: { provider: "wisdomrouter", id: "glm-5.3" },
			availableModels: [{ provider: "wisdomrouter", id: "glm-5.3", fullId: "wisdomrouter/glm-5.3" }],
		};
		const rejected = await expectBindingError(() => bindGraphSpecV3(spec({ agent: "backend-probe" }, {
			toolFilter: ["read", "write", "edit", "ffgrep", "fffind"],
		}), options));
		assert.equal(rejected.field, "toolFilter");
		assert.match(rejected.message, /ffgrep, fffind/u);
		assert.match(rejected.message, /bash, edit, find, grep, ls, read, write/u);
		const admitted = await bindGraphSpecV3(spec({ agent: "backend-probe" }, {
			toolFilter: ["read", "grep", "find", "ls", "edit", "write"],
		}), options);
		assert.deepEqual(admitted.spec.toolFilter, ["read", "grep", "find", "ls", "edit", "write"]);
		const mixed = await bindGraphSpecV3(spec({ agent: "backend-probe" }, {
			toolFilter: ["read", "grep", "edit", "write"],
			nodes: [
				{ taskId: "write", agent: "backend-probe", task: "Write", sideEffect: "none" },
				{ taskId: "review", agent: "review-probe", task: "Review", sideEffect: "none", dependsOn: ["write"] },
			],
		}), options);
		assert.equal(mixed.spec.nodes.length, 2, "a read-only reviewer does not need the writer's edit/write tools");
		const bashRejected = await expectBindingError(() => bindGraphSpecV3(spec({ agent: "backend-probe" }, {
			toolFilter: ["read", "bash"],
		}), options));
		assert.match(bashRejected.message, /Graph Guard disables bash.*validationCommands/u);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("Binding keeps provider maxTokens independent from reported usageBudget", async () => {
	const result = await bindGraphSpecV3(spec({
		agent: "reviewer",
		model: "provider/reviewer",
		maxTokens: 4_096,
		usageBudget: { tokens: { soft: 20_000, hard: 30_000 }, costUsd: { hard: 2 } },
	}), { preflightAgent: fakePreflight() });
	assert.equal(result.spec.nodes[0]?.launch?.maxTokens, 4_096);
	assert.deepEqual(result.spec.nodes[0]?.launch?.usageBudget, {
		tokens: { soft: 20_000, hard: 30_000 },
		costUsd: { hard: 2 },
	});
	await expectBindingError(() => bindGraphSpecV3(spec({ agent: "reviewer", maxTokens: 15 }), { preflightAgent: fakePreflight() }));
});

test("Binding resolves thinking false as an explicit :off model and forwards the Pi host snapshot", async () => {
	const observed: V3AgentLaunchPreflightInput[] = [];
	const result = await bindGraphSpecV3(spec({ agent: "reviewer", model: "reviewer", thinking: false }), {
		parentModel: { provider: "provider", id: "parent" },
		preferredProvider: "provider",
		availableModels: [{ provider: "provider", id: "reviewer", fullId: "provider/reviewer", reasoning: true }],
		preflightAgent: async (input) => {
			observed.push(structuredClone(input));
			return {
				ok: true,
				name: input.agent,
				agentDefinitionDigest: DEFINITION_DIGEST,
				launchContractDigest: LAUNCH_DIGEST,
				model: "provider/reviewer:off",
				modelCandidates: ["provider/reviewer:off"],
				thinking: "off",
				extensions: NO_EXTENSIONS,
			};
		},
	});
	assert.equal(observed[0]?.thinking, "off");
	assert.deepEqual(observed[0]?.parentModel, { provider: "provider", id: "parent" });
	assert.equal(observed[0]?.preferredProvider, "provider");
	assert.equal(observed[0]?.availableModels?.[0]?.fullId, "provider/reviewer");
	assert.equal(result.spec.nodes[0]?.launch?.resolvedModel, "provider/reviewer:off");
	assert.equal(result.spec.nodes[0]?.launch?.thinking, "off");
});

test("Binding rejects an extension Provider even for a legacy exact-Agent node", async () => {
	let calls = 0;
	const error = await expectBindingError(() => bindGraphSpecV3(spec({ agent: "reviewer" }), {
		extensionRegisteredProviderIds: ["ambient-provider"],
		preflightAgent: async (input) => {
			calls += 1;
			return {
				ok: true,
				name: input.agent,
				agentDefinitionDigest: DEFINITION_DIGEST,
				launchContractDigest: LAUNCH_DIGEST,
				model: "ambient-provider/inherited-model",
				modelCandidates: ["ambient-provider/inherited-model"],
				extensions: { ...NO_EXTENSIONS, disableAmbientExtensions: false },
			};
		},
	}));
	assert.equal(calls, 1, "legacy exact-Agent nodes must still execute public launch preflight");
	assert.equal(error.field, "model");
	assert.match(error.message, /cannot admit extension Providers/u);
	assert.deepEqual(error.details?.providers, ["ambient-provider"]);
});

test("Binding checks every fallback model candidate for extension Providers", async () => {
	const error = await expectBindingError(() => bindGraphSpecV3(spec({ agent: "reviewer", model: "builtin/primary" }), {
		extensionRegisteredProviderIds: ["fallback-provider"],
		preflightAgent: async (input) => ({
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DEFINITION_DIGEST,
			launchContractDigest: LAUNCH_DIGEST,
			model: "builtin/primary",
			modelCandidates: ["builtin/primary", "fallback-provider/secondary"],
			extensions: NO_EXTENSIONS,
		}),
	}));
	assert.deepEqual(error.details?.providers, ["fallback-provider"]);
});

test("Binding rejects an extension Provider even when the Agent explicitly configures its extension", async () => {
	const error = await expectBindingError(() => bindGraphSpecV3(spec({ agent: "reviewer", model: "custom-provider/model" }), {
		extensionRegisteredProviderIds: ["custom-provider"],
		preflightAgent: async (input) => ({
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DEFINITION_DIGEST,
			launchContractDigest: LAUNCH_DIGEST,
			model: "custom-provider/model",
			modelCandidates: ["custom-provider/model"],
			extensions: {
				runtimeExtensions: [],
				configuredExtensions: ["/configured/provider.ts"],
				extensionArgs: ["/configured/provider.ts"],
				disableAmbientExtensions: true,
			},
		}),
	}));
	assert.equal(error.field, "model");
	assert.deepEqual(error.details?.providers, ["custom-provider"]);
});

test("Binding allows models.json Providers that are not registered by an extension", async () => {
	const result = await bindGraphSpecV3(spec({ agent: "reviewer", model: "ark/kimi-coding" }), {
		extensionRegisteredProviderIds: ["unrelated-extension-provider"],
		preflightAgent: async (input) => ({
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DEFINITION_DIGEST,
			launchContractDigest: LAUNCH_DIGEST,
			model: "ark/kimi-coding",
			modelCandidates: ["ark/kimi-coding"],
			extensions: NO_EXTENSIONS,
		}),
	});
	assert.equal(result.spec.nodes[0]?.launch?.resolvedModel, "ark/kimi-coding");
	assert.equal(Object.hasOwn(result.spec.nodes[0]?.binding ?? {}, "extensionProviderIds"), false);
	assert.equal(Object.hasOwn(result.spec.nodes[0]?.binding ?? {}, "configuredExtensions"), false);
});

test("Binding preserves configured custom-tool extensions for models.json Providers, including maxTokens", async () => {
	const result = await bindGraphSpecV3(spec({
		agent: "reviewer",
		model: "local-model/worker",
		maxTokens: 4_096,
	}), {
		extensionRegisteredProviderIds: ["unrelated-extension-provider"],
		preflightAgent: async (input) => ({
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DEFINITION_DIGEST,
			launchContractDigest: LAUNCH_DIGEST,
			model: "local-model/worker",
			modelCandidates: ["local-model/worker"],
			extensions: {
				runtimeExtensions: [],
				configuredExtensions: ["/configured/read-only-tool.ts"],
				extensionArgs: ["/configured/read-only-tool.ts"],
				disableAmbientExtensions: true,
			},
		}),
	});
	assert.equal(result.spec.nodes[0]?.launch?.resolvedModel, "local-model/worker");
	assert.equal(result.spec.nodes[0]?.launch?.maxTokens, 4_096);
});

test("Binding treats an extension override of a built-in Provider as extension-dependent", async () => {
	const error = await expectBindingError(() => bindGraphSpecV3(spec({ agent: "reviewer", model: "openai/gpt-test" }), {
		extensionRegisteredProviderIds: ["openai"],
		preflightAgent: async (input) => ({
			ok: true,
			name: input.agent,
			agentDefinitionDigest: DEFINITION_DIGEST,
			launchContractDigest: LAUNCH_DIGEST,
			model: "openai/gpt-test",
			modelCandidates: ["openai/gpt-test"],
			extensions: NO_EXTENSIONS,
		}),
	}));
	assert.deepEqual(error.details?.providers, ["openai"]);
});

test("requires must resolve as a set to one Agent; explicit Agent must agree", async () => {
	const options = { catalog: catalog(), preflightAgent: fakePreflight() };
	const result = await bindGraphSpecV3(spec({ requires: ["review.spec", "review.code"] }), options);
	assert.equal(result.spec.nodes[0]?.agent, "reviewer");
	assert.deepEqual(result.spec.nodes[0]?.binding?.capabilityIds, ["review.code", "review.spec"]);

	await expectBindingError(() => bindGraphSpecV3(spec({ agent: "code-scout", capabilityId: "review.code" }), options));
	await expectBindingError(() => bindGraphSpecV3(spec({ requires: ["discover.code", "review.code"] }), options));
});

test("temporary Agent fallback is explicit, never applies to explicit Agent or strict contracts", async () => {
	const base = { catalog: catalog(), preflightAgent: fakePreflight(), temporaryAgent: "pi-graph.graph-worker" };
	await expectBindingError(() => bindGraphSpecV3(spec({ requires: ["missing.capability"] }), base));
	const fallback = await bindGraphSpecV3(spec({ requires: ["missing.capability"] }), { ...base, allowTemporaryAgent: true });
	assert.equal(fallback.spec.nodes[0]?.agent, "pi-graph.graph-worker");
	assert.equal(fallback.spec.nodes[0]?.binding?.resolution, "temporary-agent");
	assert.deepEqual(fallback.spec.nodes[0]?.binding?.unmatchedCapabilityIds, ["missing.capability"]);

	await expectBindingError(() => bindGraphSpecV3(spec({ agent: "reviewer", requires: ["missing.capability"] }), { ...base, allowTemporaryAgent: true }));
	await expectBindingError(() => bindGraphSpecV3(spec({ requires: ["missing.capability"] }, { contractPolicy: "strict" }), { ...base, allowTemporaryAgent: true }));
	const partial = await expectBindingError(() => bindGraphSpecV3(spec({ requires: ["review.code", "missing.capability"] }), { ...base, allowTemporaryAgent: true }));
	assert.match(partial.message, /partial capability match/u);
	const conflicting = await expectBindingError(() => bindGraphSpecV3(spec({ requires: ["discover.code", "review.code"] }), { ...base, allowTemporaryAgent: true }));
	assert.match(conflicting.message, /multiple Agents/u);
});

test("the packaged temporary Agent resolves through owned Agent discovery", async () => {
	const project = await mkdtemp(join(tmpdir(), "pi-graph-package-agent-"));
	try {
		await mkdir(join(project, ".pi"));
		await mkdir(join(project, "agents"));
		await writeFile(join(project, "package.json"), JSON.stringify({
			name: "pi-graph",
			"pi-graph": { agents: ["./agents"] },
		}));
		await writeFile(
			join(project, "agents", "graph-worker.md"),
			await readFile(new URL("../agents/graph-worker.md", import.meta.url), "utf8"),
		);

		const bound = await bindGraphSpecV3(spec({ requires: ["missing.capability"] }), {
			cwd: project,
			catalog: catalog(),
			allowTemporaryAgent: true,
		});
		assert.equal(bound.spec.nodes[0]?.agent, "pi-graph.graph-worker");
		assert.equal(bound.spec.nodes[0]?.binding?.resolution, "temporary-agent");
		assert.match(bound.spec.nodes[0]?.binding?.agentDefinitionDigest ?? "", /^[a-f0-9]{64}$/u);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("routingProfile catalogs are accepted but never converted into Graph model routing", async () => {
	const observed: V3AgentLaunchPreflightInput[] = [];
	const installedShape = catalog([{ capabilityId: "discover.code", agent: "code-scout", routingProfile: "code-discovery" }]);
	const result = await bindGraphSpecV3(spec({ capabilityId: "discover.code" }), { catalog: installedShape, preflightAgent: fakePreflight(observed) });
	assert.equal(observed[0]?.model, undefined);
	assert.equal(result.spec.nodes[0]?.launch, undefined);
	assert.equal(JSON.stringify(result.spec).includes("routingProfile"), false);
});

test("append binding returns only frozen exact-Agent nodes for mutation authority", async () => {
	const result = await bindGraphNodesV3([{
		taskId: "late",
		task: "Appended work",
		requires: ["review.code"],
		sideEffect: "none",
	}], { catalog: catalog(), preflightAgent: fakePreflight() });
	assert.equal(result.nodes[0]?.agent, "reviewer");
	assert.equal(Object.hasOwn(result.nodes[0]!, "requires"), false);
	assert.equal(result.nodes[0]?.binding?.resolution, "capability-catalog");
});

test("authorization recovery revalidates frozen binding and launch bytes without a catalog", async () => {
	const bound = await bindGraphSpecV3(spec({ capabilityId: "review.code", maxTokens: 4_096 }), { catalog: catalog(), preflightAgent: fakePreflight() });
	const authorization = authorizationV4For(bound.compiled, {
		runInstanceId: "run-binding",
		sessionId: "session-binding",
		supervisorEpoch: "epoch-binding",
		createdAt: "2026-08-24T00:00:00.000Z",
		sourceCwd: process.cwd(),
		sourceRepository: { kind: "directory", root: process.cwd(), device: "1", inode: "2" },
	});
	assert.equal(validateAuthorizationV4(structuredClone(authorization)).graphDigest, bound.compiled.graphDigest);

	const tampered = structuredClone(authorization);
	tampered.sourceGraphSpec.nodes[0]!.binding!.resolvedAgent = "forged-agent";
	tampered.sourceGraphSpecDigest = canonicalDigest(tampered.sourceGraphSpec);
	assert.throws(() => validateAuthorizationV4(tampered), (error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_AUTHORIZATION");
});

test("capability catalog loader rejects duplicate entries, links, and oversized reads", async () => {
	assert.throws(() => validateV3CapabilityCatalog(catalog([
		{ capabilityId: "review.code", agent: "reviewer" },
		{ capabilityId: "review.code", agent: "other" },
	])), (error: unknown) => error instanceof GraphV3Error && error.code === "CAPABILITY_CATALOG_INVALID");

	const dir = await mkdtemp(join(tmpdir(), "pi-graph-binding-catalog-"));
	const target = join(dir, "target.json");
	const link = join(dir, "catalog.json");
	await writeFile(target, JSON.stringify(catalog()));
	await symlink(target, link);
	await assert.rejects(readV3CapabilityCatalog({ path: link }), (error: unknown) => error instanceof GraphV3Error && error.code === "CAPABILITY_CATALOG_INVALID");
	await assert.rejects(readV3CapabilityCatalog({ path: target, maxBytes: 10 }), (error: unknown) => error instanceof GraphV3Error && error.code === "CAPABILITY_CATALOG_INVALID");
});

test("temporary Agent fallback is disabled in graph settings unless literally opted in", () => {
	const defaults = parseV3GraphConfig({}, "/tmp/pi-graph-config-agent");
	assert.equal(defaults.allowTemporaryAgent, false);
	assert.equal(parseV3GraphConfig({ allowTemporaryAgent: "true" }, "/tmp/pi-graph-config-agent").allowTemporaryAgent, false);
	assert.equal(parseV3GraphConfig({ allowTemporaryAgent: true }, "/tmp/pi-graph-config-agent").allowTemporaryAgent, true);
});

test("trusted parent ceiling admits inherited by default, rejects forged evidence, and preserves per-node readonly", async () => {
 const observed: V3AgentLaunchPreflightInput[] = [];
 const options = { parentToolAllowlist: ["read", "bash"], preflightAgent: fakePreflight(observed) };
 const bound = await bindGraphSpecV3(spec({ agent: "worker", readOnly: true, sideEffect: "external_read" }), options);
 assert.equal(bound.spec.permissionPolicy, "inherited");
 assert.deepEqual(bound.spec.parentToolAllowlist, ["read", "bash"]);
 assert.equal(bound.compiled.nodes[0]!.readOnly, true);
 assert.deepEqual(observed[0]!.parentToolAllowlist, ["read", "bash"]);
 await assert.rejects(bindGraphSpecV3(spec({ agent: "worker" }, { parentToolAllowlist: ["write"] }), options), /reserved/);
 await assert.rejects(bindGraphSpecV3(spec({ agent: "worker", readOnly: true, sideEffect: "external_write" }), options), /readOnly/);
 const empty = await bindGraphSpecV3(spec({ agent: "worker" }), { ...options, parentToolAllowlist: [] });
 assert.deepEqual(empty.compiled.nodes[0]!.parentToolAllowlist, []);
 const legacy = compileGraphSpecV3(spec({ agent: "worker" }));
 assert.equal(legacy.nodes[0]!.permissionPolicy, undefined);
 assert.equal(legacy.nodes[0]!.parentToolAllowlist, undefined);
 const wholeReadonly = await bindGraphSpecV3(spec({ agent: "worker", readOnly: false }, { readOnly: true }), options);
 assert.equal(wholeReadonly.compiled.nodes[0]!.readOnly, true);
});


test("native ceiling intersects non-empty Graph filter, preserves empty/legacy, and carries start/append preflight", async () => {
 assert.equal(v3NativeToolCeiling(undefined, ["read"]), undefined);
 assert.deepEqual(v3NativeToolCeiling(["read", "bash"], [])!.allowedTools, ["read", "bash", "graph_mailbox"]);
 assert.deepEqual(v3NativeToolCeiling(["read", "bash"], ["read"])!.allowedTools, ["read", "graph_mailbox"]);
 assert.deepEqual(v3NativeToolCeiling([], ["bash"])!.allowedTools, ["graph_mailbox"]);
 assert.deepEqual(v3NativeToolCeiling([], ["graph_mailbox"])!.allowedTools, ["graph_mailbox"]);
 const calls: V3AgentLaunchPreflightInput[] = [];
 const options = { parentToolAllowlist: ["read", "bash"], preflightAgent: fakePreflight(calls) };
 await bindGraphSpecV3(spec({ agent: "worker" }, { toolFilter: ["read"] }), options);
 assert.deepEqual(calls[0]!.graphToolFilter, ["read"]);
 await bindGraphNodesV3([{ taskId: "later", agent: "worker", task: "read", sideEffect: "none" }], { ...options, graphToolFilter: ["read"] });
 assert.deepEqual(calls[1]!.graphToolFilter, ["read"]);
});
