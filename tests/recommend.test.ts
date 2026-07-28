import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGraphConfig } from "../src/config.ts";
import { formatRecommendReport, recommendGraphConfig } from "../src/recommend.ts";

interface FixtureOptions {
	required?: string;
	installed?: string;
	settings?: unknown;
}

async function createFixture(t: TestContext, options: FixtureOptions = {}): Promise<{ agentDir: string; packageRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-recommend-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const packageRoot = join(root, "package");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(packageRoot, { recursive: true }),
	]);
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({
		dependencies: options.required === undefined ? {} : { "pi-subagents": options.required },
	}));
	if (options.installed !== undefined) {
		const installedRoot = join(packageRoot, "node_modules", "pi-subagents");
		await mkdir(installedRoot, { recursive: true });
		await writeFile(join(installedRoot, "package.json"), JSON.stringify({ version: options.installed }));
	}
	if (options.settings !== undefined) {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	}
	return { agentDir, packageRoot };
}

test("recommend reports a matching pi-subagents dependency and parser-derived graph defaults", async (t) => {
	const fixture = await createFixture(t, {
		required: "0.37.2",
		installed: "0.37.2",
		settings: { graph: {} },
	});
	const report = await recommendGraphConfig(fixture);
	assert.equal(report.dependency.status, "ok");
	assert.equal(report.dependency.required, "0.37.2");
	assert.equal(report.dependency.installed, "0.37.2");
	assert.equal(report.graph.status, "valid");
	assert.deepEqual(report.graph.recommended, parseGraphConfig({}, fixture.agentDir));

	const formatted = formatRecommendReport(report);
	const marker = "Recommended settings.graph (valid JSON):\n";
	assert.ok(formatted.includes(marker));
	assert.deepEqual(JSON.parse(formatted.slice(formatted.indexOf(marker) + marker.length)), report.graph.recommended);
});

test("recommend reports a mismatched pi-subagents dependency", async (t) => {
	const fixture = await createFixture(t, {
		required: "0.37.2",
		installed: "0.37.1",
		settings: {},
	});
	const report = await recommendGraphConfig(fixture);
	assert.equal(report.dependency.status, "mismatch");
	assert.match(report.dependency.recommendation, /npm install pi-subagents@0\.37\.2/);
	assert.equal(report.graph.status, "missing");
});

test("recommend compares SemVer numeric identifiers without precision loss", async (t) => {
	const mismatchFixture = await createFixture(t, {
		required: "9007199254740992.0.0",
		installed: "9007199254740993.0.0",
		settings: {},
	});
	const mismatchReport = await recommendGraphConfig(mismatchFixture);
	assert.equal(mismatchReport.dependency.status, "mismatch");

	const matchingFixture = await createFixture(t, {
		required: "9007199254740993.0.0",
		installed: "9007199254740993.0.0",
		settings: {},
	});
	const matchingReport = await recommendGraphConfig(matchingFixture);
	assert.equal(matchingReport.dependency.status, "ok");
});

test("recommend never accepts identical malformed versions", async (t) => {
	for (const version of ["1.2", "01.2.3", "1.2.3-01"]) {
		const fixture = await createFixture(t, {
			required: version,
			installed: version,
			settings: {},
		});
		const report = await recommendGraphConfig(fixture);
		assert.equal(report.dependency.status, "mismatch", version);
	}
});

test("recommend reports a missing dependency and treats absent settings.json as missing configuration", async (t) => {
	const fixture = await createFixture(t, { required: "0.37.2" });
	const report = await recommendGraphConfig(fixture);
	assert.equal(report.dependency.status, "missing");
	assert.equal(report.dependency.installed, null);
	assert.equal(report.graph.status, "missing");
	assert.deepEqual(report.graph.issues, []);
});

test("recommend reports invalid graph configuration without exposing settings secrets", async (t) => {
	const fakeApiKey = "sk-test-do-not-expose-123456";
	const fixture = await createFixture(t, {
		required: "0.37.2",
		installed: "0.37.2",
		settings: {
			apiKey: fakeApiKey,
			graph: {
				authToken: fakeApiKey,
				history: [],
			},
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
