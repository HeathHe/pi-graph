import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseGraphConfig } from "../src/config.ts";

test("graph config preserves fractional storage limits and bounds the target", () => {
	const config = parseGraphConfig({ history: { maxStorageGB: 0.5, targetStorageGB: 0.25 } }, "/tmp/pi-agent");
	assert.equal(config.history?.maxStorageBytes, 0.5 * 1024 ** 3);
	assert.equal(config.history?.targetStorageBytes, 0.25 * 1024 ** 3);
	const bounded = parseGraphConfig({ history: { maxStorageGB: 1 } }, "/tmp/pi-agent");
	assert.equal(bounded.history?.targetStorageBytes, 1 * 1024 ** 3);
});

test("graph config fails closed on malformed graph and history objects", () => {
	assert.throws(() => parseGraphConfig([]), /must be an object/);
	assert.throws(() => parseGraphConfig({ history: [] }), /history must be an object/);
	assert.throws(() => parseGraphConfig({ resourceLimits: [] }), /resourceLimits must be an object/);
	assert.throws(() => parseGraphConfig({ resourceLimits: { "agent:frontend-developer": 0 } }), /integer from 1 to 6/);
	assert.equal(parseGraphConfig({}, "/tmp/pi-agent").runsDir, join("/tmp/pi-agent", "graph-runs"));
});

test("graph config accepts bounded generic resource limits", () => {
	assert.deepEqual(
		parseGraphConfig({ resourceLimits: { "agent:frontend-developer": 1, "provider:kimi": 2 } }, "/tmp/pi-agent").resourceLimits,
		{ "agent:frontend-developer": 1, "provider:kimi": 2 },
	);
});
