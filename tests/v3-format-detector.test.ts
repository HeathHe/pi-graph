import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { detectRunFormat } from "../src/v3/format-detector.ts";
import { inspectV3Run } from "../src/v3/inspect.ts";
import type { RunFormatKind } from "../src/v3/types.ts";

interface AuthorizationVariant {
	name: string;
	value?: Record<string, unknown>;
}

async function canonicalTempRoot(prefix: string): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
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

test("V3 inspect fails closed for all pre-V3 and mixed formats without rewriting them", async (t) => {
  const runDir = await canonicalTempRoot("pi-graph-v3-unsupported-format-");
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const snapshot = JSON.stringify({ schemaVersion: 2, graphId: "old-run", status: "running" });
  const authorization = JSON.stringify({ schemaVersion: 3, graphId: "old-run" });
  await writeFile(join(runDir, "snapshot.json"), snapshot);
  await writeFile(join(runDir, "authorization.json"), authorization);
  const beforeEntries = await readdir(runDir);
  const inspection = await inspectV3Run(runDir, { trustedRoot: dirname(runDir) });
  assert.equal(inspection.status, "needs_attention");
  assert.equal(inspection.format.kind, "invalid");
  assert.equal(await readFile(join(runDir, "snapshot.json"), "utf8"), snapshot);
  assert.equal(await readFile(join(runDir, "authorization.json"), "utf8"), authorization);
  assert.deepEqual(await readdir(runDir), beforeEntries);
});
