import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGraphConfig } from "../src/config.ts";
import { formatRecommendReport, recommendGraphConfig } from "../src/recommend.ts";
import type { PiSubagentsRpcLike } from "../src/pi-subagents-compat.ts";

interface FixtureOptions {
	peer?: string;
	development?: string;
	direct?: string;
	installed?: string;
	settings?: unknown;
}

const compatibleRpc: PiSubagentsRpcLike = {
	async call(method) {
		assert.equal(method, "ping");
		return {
			protocolVersion: 1,
			packageVersion: "99.0.0",
			capabilities: {
				methods: ["ping", "spawn", "status", "stop", "resume"],
				providerFailureStructured: true,
				exactModel: true,
			},
		};
	},
};

async function createFixture(t: TestContext, options: FixtureOptions = {}): Promise<{ agentDir: string; packageRoot: string; rpc: PiSubagentsRpcLike }> {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-recommend-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const packageRoot = join(root, "package");
	await mkdir(agentDir, { recursive: true });
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({
		...(options.direct ? { dependencies: { "pi-subagents": options.direct } } : {}),
		...(options.peer ? { peerDependencies: { "pi-subagents": options.peer } } : {}),
		...(options.development ? { devDependencies: { "pi-subagents": options.development } } : {}),
	}), "utf8");
	if (options.installed) {
		const dependencyDir = join(packageRoot, "node_modules", "pi-subagents");
		await mkdir(dependencyDir, { recursive: true });
		await writeFile(join(dependencyDir, "package.json"), JSON.stringify({ version: options.installed }), "utf8");
	}
	if (options.settings !== undefined) await writeFile(join(agentDir, "settings.json"), JSON.stringify(options.settings), "utf8");
	return { agentDir, packageRoot, rpc: compatibleRpc };
}

test("recommend accepts the latest-provider dependency policy and compatible public RPC capabilities", async (t) => {
	const fixture = await createFixture(t, {
		peer: ">=0.40.0",
		development: "latest",
		installed: "0.40.0",
		settings: {},
	});
	const report = await recommendGraphConfig(fixture);
	assert.equal(report.dependency.status, "ok");
	assert.equal(report.dependency.required, ">=0.40.0");
	assert.equal(report.dependency.development, "latest");
	assert.equal(report.dependency.installed, "0.40.0");
	assert.equal(report.piSubagents.packageVersion, "99.0.0");
	assert.equal(report.piSubagents.routingCompatible, true);
	assert.equal(report.graph.status, "missing");
	assert.deepEqual(report.graph.recommended, parseGraphConfig({}, fixture.agentDir));

	const formatted = formatRecommendReport(report);
	const marker = "Recommended settings.graph (valid JSON):\n";
	assert.ok(formatted.includes("version is diagnostic only"));
	assert.ok(formatted.includes(marker));
	assert.deepEqual(JSON.parse(formatted.slice(formatted.indexOf(marker) + marker.length)), report.graph.recommended);
});

test("recommend rejects a direct pinned pi-subagents dependency even when the installed copy matches", async (t) => {
	const fixture = await createFixture(t, {
		direct: "0.37.2",
		peer: ">=0.40.0",
		development: "latest",
		installed: "0.37.2",
		settings: {},
	});
	const report = await recommendGraphConfig(fixture);
	assert.equal(report.dependency.status, "mismatch");
	assert.match(report.dependency.recommendation, /Remove the direct pi-subagents dependency/);
});

test("recommend reports a missing peer declaration without requiring a nested runtime copy", async (t) => {
	const fixture = await createFixture(t, { development: "latest" });
	const report = await recommendGraphConfig(fixture);
	assert.equal(report.dependency.status, "missing");
	assert.equal(report.dependency.installed, null);
	assert.equal(report.graph.status, "missing");
});

test("recommend separates a compatible RPC v1 runtime from controlled-routing limitations", async (t) => {
	const fixture = await createFixture(t, { peer: ">=0.40.0", development: "latest", settings: {} });
	const report = await recommendGraphConfig({
		...fixture,
		rpc: {
			async call() {
				return { protocolVersion: 1, packageVersion: "100.0.0", capabilities: {} };
			},
		},
	});
	assert.equal(report.dependency.status, "ok");
	assert.equal(report.piSubagents.providerFailureStructured, false);
	assert.equal(report.piSubagents.exactModelControl, false);
	assert.equal(report.piSubagents.routingCompatible, true);
	assert.equal(report.piSubagents.controlledRoutingReady, false);
	assert.match(formatRecommendReport(report), /controlledRoutingReady=false/);
});

test("recommend reports invalid graph configuration without exposing settings secrets", async (t) => {
	const fakeApiKey = "sk-test-do-not-expose-123456";
	const fixture = await createFixture(t, {
		peer: ">=0.40.0",
		development: "latest",
		settings: {
			apiKey: fakeApiKey,
			graph: { authToken: fakeApiKey, history: [] },
		},
	});
	const report = await recommendGraphConfig(fixture);
	const formatted = formatRecommendReport(report);
	assert.equal(report.graph.status, "invalid");
	assert.ok(report.graph.issues.length > 0);
	assert.equal(JSON.stringify(report).includes(fakeApiKey), false);
	assert.equal(formatted.includes(fakeApiKey), false);
	assert.equal(formatted.includes("authToken"), false);
});
