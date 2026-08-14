import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
assert.equal(packageJson.dependencies?.["pi-subagents"], undefined, "pi-graph must not own a direct pi-subagents runtime copy");
assert.equal(packageJson.peerDependencies?.["pi-subagents"], ">=0.40.0");
assert.equal(packageJson.devDependencies?.["pi-subagents"], "latest");

const installed = JSON.parse(await readFile(new URL("../node_modules/pi-subagents/package.json", import.meta.url), "utf8")) as { version: string };
const latest = execFileSync("npm", ["view", "pi-subagents@latest", "version"], { encoding: "utf8" }).trim();
assert.equal(installed.version, latest, `installed pi-subagents ${installed.version} is not npm latest ${latest}`);

const jiti = createJiti(import.meta.url);
for (const publicExport of ["pi-subagents/background-work", "pi-subagents/delegation", "pi-subagents/preflight"] as const) {
	await jiti.import(publicExport);
}
const delegationApi = jiti("pi-subagents/delegation") as Record<string, unknown>;
assert.equal(delegationApi.SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
assert.equal(delegationApi.SUBAGENT_DELEGATION_RESPONSE_EVENT, "prompt-template:subagent:response");
assert.equal(delegationApi.SUBAGENT_DELEGATION_CANCEL_EVENT, "prompt-template:subagent:cancel");
const { parseSubagentDelegationRequest } = jiti(new URL("../node_modules/pi-subagents/src/slash/delegation-request.ts", import.meta.url).href) as {
	parseSubagentDelegationRequest(data: unknown): { ok: boolean; error?: string };
};
const publicRequest = {
	requestId: "latest-request",
	ownerRunId: "latest-owner",
	nodeId: "latest-node",
	agent: "code-reviewer",
	task: "review",
	context: "fresh",
	cwd: process.cwd(),
	model: "ark/glm-5.2",
	result: { kind: "text" },
};
assert.equal(parseSubagentDelegationRequest(publicRequest).ok, true, "latest delegation parser must accept the public request shape");
const rejectedVersion = parseSubagentDelegationRequest({ ...publicRequest, version: 2 });
assert.equal(rejectedVersion.ok, false, "latest delegation parser must expose any protocol change around unsupported fields");
assert.match(rejectedVersion.error ?? "", /Unsupported delegation field: version/);
const { toSubagentDelegationResponse } = jiti(new URL("../node_modules/pi-subagents/src/slash/delegation-adapters.ts", import.meta.url).href) as {
	toSubagentDelegationResponse(request: Record<string, unknown>, result: Record<string, unknown>, aborted: boolean): Record<string, unknown>;
};
const latestFailureResponse = toSubagentDelegationResponse(publicRequest, {
	isError: true,
	content: [{ type: "text", text: "provider failed" }],
	details: { results: [{ error: "provider failed", failureDomain: "provider", failureCode: "503", failureStage: "runtime" }] },
}, false);
assert.equal(Object.hasOwn(latestFailureResponse, "failure"), false);
assert.equal(Object.hasOwn(latestFailureResponse, "failureDomain"), false);
assert.equal(Object.hasOwn(latestFailureResponse, "failureCode"), false);
assert.equal(Object.hasOwn(latestFailureResponse, "failureStage"), false);

const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-graph-latest-agents-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
	process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
	const agentsDir = join(isolatedAgentDir, "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(join(isolatedAgentDir, "settings.json"), JSON.stringify({
		subagents: { agentOverrides: { reviewer: { disabled: true } } },
	}, null, 2));
	await writeFile(join(agentsDir, "code-reviewer.md"), "---\nname: code-reviewer\naliases: reviewer\ndescription: Code review\nmodel: ark/glm-5.2\nthinking: false\ntools: read\n---\nReview code.\n");
	await writeFile(join(agentsDir, "product-manager.md"), "---\nname: product-manager\ndescription: Product definition\nmodel: wisdomrouter/gpt-5.6-sol\nthinking: xhigh\ntools: read\n---\nDefine the product.\n");
	await writeFile(join(agentsDir, "interaction-designer.md"), "---\nname: interaction-designer\ndescription: Interaction design\nmodel: wisdomrouter/gpt-5.6-sol\nthinking: high\ntools: read\n---\nSpecify interaction behavior.\n");
	const { resolveSubagentLaunchContract } = await jiti.import("pi-subagents/preflight") as {
		resolveSubagentLaunchContract(input: { agent: string; cwd: string }): Promise<
			| { ok: true; contract: { agent: { name: string; filePath: string }; modelCandidates: string[] } }
			| { ok: false; message: string }
		>;
	};
	const contracts = new Map<string, Awaited<ReturnType<typeof resolveSubagentLaunchContract>>>();
	for (const agent of ["code-reviewer", "reviewer", "product-manager", "interaction-designer"]) {
		contracts.set(agent, await resolveSubagentLaunchContract({ agent, cwd: isolatedAgentDir }));
		assert.equal(contracts.get(agent)?.ok, true, `${agent} must resolve through the latest public preflight API`);
	}
	const canonical = contracts.get("code-reviewer");
	const alias = contracts.get("reviewer");
	assert.ok(canonical?.ok && alias?.ok);
	assert.equal(alias.contract.agent.name, "code-reviewer");
	assert.equal(alias.contract.agent.filePath, canonical.contract.agent.filePath);
	assert.deepEqual(canonical.contract.modelCandidates, ["ark/glm-5.2"]);
	const product = contracts.get("product-manager");
	const interaction = contracts.get("interaction-designer");
	assert.ok(product?.ok && interaction?.ok);
	assert.deepEqual(product.contract.modelCandidates, ["wisdomrouter/gpt-5.6-sol:xhigh"]);
	assert.deepEqual(interaction.contract.modelCandidates, ["wisdomrouter/gpt-5.6-sol:high"]);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(isolatedAgentDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ installed: installed.version, latest, publicExports: true, delegationProtocol: true, providerFailureStructured: false, agentAliasContract: true }, null, 2));
