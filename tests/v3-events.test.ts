import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V3EventWriter, V3_EVENT_MAX_BYTES, V3_EVENT_MAX_COUNT } from "../src/v3/events.ts";
import { validateV3EventTruncationRecord } from "../src/v3/events.ts";

async function eventLogDir() {
	return mkdtemp(join(tmpdir(), "v3-events-"));
}

test("V3 event writer appends unverified shadow lines with bounded schema", async () => {
	const dir = await eventLogDir();
	const writer = new V3EventWriter(join(dir, "events.jsonl"), join(dir, "events.truncated.json"));
	const accepted = await writer.append({ at: new Date().toISOString(), type: "node_prepared", runInstanceId: "r1", graphId: "g1", taskId: "t1", attempt: 1 });
	assert.equal(accepted, true);
	const accepted2 = await writer.append({ at: new Date().toISOString(), type: "node_accepted", runInstanceId: "r1", graphId: "g1", taskId: "t1", attempt: 1 });
	assert.equal(accepted2, true);
	const lines = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n");
	assert.equal(lines.length, 2);
	for (const line of lines) {
		const event = JSON.parse(line);
		assert.equal(event.schemaVersion, 1);
		assert.equal(event.unverified, true);
	}
	const diag = await writer.diagnostics();
	assert.equal(diag.health, "healthy");
	assert.equal(diag.events, 2);
});

test("V3 event writer latches on an oversized event and writes the truncated sidecar", async () => {
	const dir = await eventLogDir();
	const writer = new V3EventWriter(join(dir, "events.jsonl"), join(dir, "events.truncated.json"));
	const big = "x".repeat(V3_EVENT_MAX_BYTES + 1);
	const accepted = await writer.append({ at: new Date().toISOString(), type: "node_verifying", runInstanceId: "r1", graphId: "g1", payload: big });
	assert.equal(accepted, false);
	const acceptedAfter = await writer.append({ at: new Date().toISOString(), type: "node_accepted", runInstanceId: "r1", graphId: "g1" });
	assert.equal(acceptedAfter, false, "writer must be latched after a rejected event");
	const sidecar = JSON.parse(await readFile(join(dir, "events.truncated.json"), "utf8"));
	assert.equal(sidecar.schemaVersion, 1);
	assert.equal(sidecar.unverified, true);
	assert.equal(sidecar.reason, "event-too-large");
	assert.ok(validateV3EventTruncationRecord(sidecar));
	// No event line was written.
	const diag = await writer.diagnostics();
	assert.equal(diag.health, "truncated");
});

test("V3 event writer stops appending at the event-count boundary", async () => {
	const dir = await eventLogDir();
	const eventsPath = join(dir, "events.jsonl");
	const truncatedPath = join(dir, "events.truncated.json");
	// Seed the log at the boundary with one buffered write instead of 10k fsynced
	// appends (each append is an atomic rename + fsync, which would take ~50s and
	// starve parallel test processes). The production boundary constant stays intact.
	const lines: string[] = new Array(V3_EVENT_MAX_COUNT);
	for (let index = 0; index < V3_EVENT_MAX_COUNT; index += 1) {
		lines[index] = JSON.stringify({ schemaVersion: 1, unverified: true, seq: index + 1, at: new Date().toISOString(), type: "n", runInstanceId: "r1", graphId: "g1", index });
	}
	await writeFile(eventsPath, `${lines.join("\n")}\n`, "utf8");
	const writer = new V3EventWriter(eventsPath, truncatedPath);
	await writer.initialize();
	const accepted = await writer.append({ at: new Date().toISOString(), type: "over", runInstanceId: "r1", graphId: "g1" });
	assert.equal(accepted, false);
	const sidecar = JSON.parse(await readFile(truncatedPath, "utf8"));
	assert.equal(sidecar.reason, "event-count-limit");
	assert.equal(sidecar.acceptedEvents, V3_EVENT_MAX_COUNT);
});

test("V3 event writer recomputes capacity from existing lines after restart", async () => {
	const dir = await eventLogDir();
	const first = new V3EventWriter(join(dir, "events.jsonl"), join(dir, "events.truncated.json"));
	for (let index = 0; index < 3; index += 1) await first.append({ at: new Date().toISOString(), type: "n", runInstanceId: "r1", graphId: "g1", index });
	// A second writer instance must recompute the event count from disk.
	const second = new V3EventWriter(join(dir, "events.jsonl"), join(dir, "events.truncated.json"));
	await second.initialize();
	const diag = await second.diagnostics();
	assert.equal(diag.events, 3);
});
