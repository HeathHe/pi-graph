import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectRunFormat } from "../src/v3/format-detector.ts";
import { inspectV3Run } from "../src/v3/inspect.ts";
import type { RunFormatKind } from "../src/v3/types.ts";

interface AuthorizationVariant {
	name: string;
	value?: Record<string, unknown>;
}

const snapshotVariants: Array<{ name: string; value: unknown }> = [
	{ name: "missing", value: undefined },
	{ name: "invalid-object", value: {} },
	{ name: "v1", value: { schemaVersion: 1 } },
	{ name: "v2", value: { schemaVersion: 2 } },
	{ name: "v3", value: { schemaVersion: 3 } },
	{ name: "v4", value: { schemaVersion: 4 } },
	{ name: "unknown", value: { schemaVersion: 99 } },
];

const authorizationVariants: AuthorizationVariant[] = [
	{ name: "absent" },
	{ name: "invalid-object", value: {} },
	{ name: "v1", value: { schemaVersion: 1 } },
	{ name: "v2", value: { schemaVersion: 2 } },
	{ name: "v3", value: { schemaVersion: 3 } },
	{ name: "v4-runtime-missing", value: { schemaVersion: 4 } },
	{ name: "v4-runtime-v2", value: { schemaVersion: 4, runtimeSchemaVersion: 2 } },
	{ name: "v4-runtime-v3", value: { schemaVersion: 4, runtimeSchemaVersion: 3 } },
	{ name: "v4-runtime-v4", value: { schemaVersion: 4, runtimeSchemaVersion: 4 } },
	{ name: "unknown", value: { schemaVersion: 99 } },
];

function expectedKind(snapshot: unknown, authorization: Record<string, unknown> | undefined): RunFormatKind {
	const snapshotVersion = (snapshot as Record<string, unknown> | undefined)?.schemaVersion;
	const authorizationVersion = authorization?.schemaVersion;
	if (snapshotVersion === 1 && authorization === undefined) return "legacy-readonly";
	if (snapshotVersion === 2 && (authorizationVersion === 2 || authorizationVersion === 3)) return "legacy-v2";
	if (snapshotVersion === 3 && authorizationVersion === 4 && authorization?.runtimeSchemaVersion === 3) return "v3";
	return "invalid";
}

test("V3 format detector implements the complete legal/invalid version matrix", () => {
	let checked = 0;
	for (const snapshot of snapshotVariants) {
		for (const authorization of authorizationVariants) {
			const detected = detectRunFormat(snapshot.value, authorization.value);
			assert.equal(detected.kind, expectedKind(snapshot.value, authorization.value), `${snapshot.name} + ${authorization.name}`);
			checked += 1;
		}
	}
	assert.equal(checked, snapshotVariants.length * authorizationVariants.length);
	assert.equal(checked, 70);
});

test("V3 inspect classifies snapshot-v1 without authorization as legacy-readonly without writing", async (t) => {
	const runDir = await mkdtemp(join(tmpdir(), "pi-graph-v3-legacy-v1-"));
	t.after(() => rm(runDir, { recursive: true, force: true }));
	const snapshot = JSON.stringify({ schemaVersion: 1, graphId: "legacy-1", status: "complete" });
	await writeFile(join(runDir, "snapshot.json"), snapshot);
	const beforeEntries = await readdir(runDir);
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "legacy-readonly");
	assert.equal(inspection.format.kind, "legacy-readonly");
	assert.equal(inspection.graphId, "legacy-1");
	assert.equal(await readFile(join(runDir, "snapshot.json"), "utf8"), snapshot);
	assert.deepEqual(await readdir(runDir), beforeEntries);
});

test("V3 inspect classifies snapshot-v2 with authorization-v2 or v3 as legacy-v2 without writing", async (t) => {
	for (const authorizationVersion of [2, 3]) {
		const runDir = await mkdtemp(join(tmpdir(), `pi-graph-v3-legacy-v2-auth${authorizationVersion}-`));
		t.after(() => rm(runDir, { recursive: true, force: true }));
		const snapshot = JSON.stringify({ schemaVersion: 2, graphId: `legacy-${authorizationVersion}`, runInstanceId: "legacy-run", status: "running" });
		const authorization = JSON.stringify({ schemaVersion: authorizationVersion, graphId: `legacy-${authorizationVersion}` });
		await writeFile(join(runDir, "snapshot.json"), snapshot);
		await writeFile(join(runDir, "authorization.json"), authorization);
		const beforeEntries = await readdir(runDir);
		const inspection = await inspectV3Run(runDir);
		assert.equal(inspection.status, "legacy-v2");
		assert.equal(inspection.format.kind, "legacy-v2");
		assert.equal(await readFile(join(runDir, "snapshot.json"), "utf8"), snapshot);
		assert.equal(await readFile(join(runDir, "authorization.json"), "utf8"), authorization);
		assert.deepEqual(await readdir(runDir), beforeEntries);
	}
});

test("V3 inspect treats every mixed legacy/V3 pair as needs_attention without rewriting it", async (t) => {
	const runDir = await mkdtemp(join(tmpdir(), "pi-graph-v3-mixed-"));
	t.after(() => rm(runDir, { recursive: true, force: true }));
	const snapshot = JSON.stringify({ schemaVersion: 3, graphId: "mixed", status: "queued" });
	const authorization = JSON.stringify({ schemaVersion: 3 });
	await writeFile(join(runDir, "snapshot.json"), snapshot);
	await writeFile(join(runDir, "authorization.json"), authorization);
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.equal(inspection.format.kind, "invalid");
	assert.equal(await readFile(join(runDir, "snapshot.json"), "utf8"), snapshot);
	assert.equal(await readFile(join(runDir, "authorization.json"), "utf8"), authorization);
});
