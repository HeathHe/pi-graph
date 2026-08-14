import test from "node:test";
import assert from "node:assert/strict";
import { controlledRoutingReadiness, inspectPiSubagentsRuntime } from "../src/pi-subagents-compat.ts";

test("runtime handshake accepts public RPC v1 only when routing-critical capabilities are explicit", async () => {
	const report = await inspectPiSubagentsRuntime({
		async call(method) {
			assert.equal(method, "ping");
			return {
				protocolVersion: 1,
				packageVersion: "0.40.0",
				capabilities: {
					methods: ["ping", "spawn", "status", "stop", "resume"],
					providerFailureStructured: true,
					perCallFallbackControl: true,
				},
			};
		},
	});
	assert.deepEqual({
		runtimeAvailable: report.runtimeAvailable,
		rpcProtocol: report.rpcProtocol,
		asyncSpawn: report.asyncSpawn,
		status: report.status,
		stop: report.stop,
		resume: report.resume,
		resolvedModelObservable: report.resolvedModelObservable,
		attemptedModelsObservable: report.attemptedModelsObservable,
		providerFailureStructured: report.providerFailureStructured,
		exactModelControl: report.exactModelControl,
		routingCompatible: report.routingCompatible,
	}, {
		runtimeAvailable: true,
		rpcProtocol: 1,
		asyncSpawn: true,
		status: true,
		stop: true,
		resume: true,
		resolvedModelObservable: true,
		attemptedModelsObservable: true,
		providerFailureStructured: true,
		exactModelControl: true,
		routingCompatible: true,
	});
});

test("runtime handshake understands the real pi-subagents 0.40.0 ping shape", async () => {
	const report = await inspectPiSubagentsRuntime({
		async call() {
			return {
				version: 1,
				methods: ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"],
				capabilities: { status: true, fleetStatus: { version: 1 }, asyncSpawn: true, steer: true, interrupt: true, stop: true, resume: true },
			};
		},
	});
	assert.equal(report.runtimeCompatible, true);
	assert.equal(report.provenanceObservable, true);
	assert.equal(report.controlledRoutingReady, false);
	assert.equal(report.routingCompatible, true);
	assert.equal(controlledRoutingReadiness(report, false).ready, false);
	assert.equal(controlledRoutingReadiness(report, true).ready, true);
	assert.match(report.limitations.join(" "), /launch contracts must be audited/);
});

test("runtime handshake fails closed for an incomplete future method contract", async () => {
	const report = await inspectPiSubagentsRuntime({
		async call() {
			return {
				protocolVersion: 1,
				capabilities: {
					methods: ["ping", "spawn", "status"],
					providerFailureStructured: true,
					exactModel: true,
				},
			};
		},
	});
	assert.equal(report.stop, false);
	assert.equal(report.resume, false);
	assert.equal(report.routingCompatible, false);
	assert.match(report.issues.join(" "), /stop capability/);
});

test("runtime handshake reports an unavailable or changed RPC without guessing from a version", async () => {
	const failed = await inspectPiSubagentsRuntime({
		async call() {
			throw new Error("no responder");
		},
	});
	assert.equal(failed.runtimeAvailable, false);
	assert.equal(failed.routingCompatible, false);

	const changed = await inspectPiSubagentsRuntime({
		async call() {
			return { protocolVersion: 2, packageVersion: "999.0.0" };
		},
	});
	assert.equal(changed.runtimeAvailable, true);
	assert.equal(changed.rpcProtocol, 2);
	assert.equal(changed.routingCompatible, false);
	assert.match(changed.issues[0] ?? "", /Unsupported pi-subagents RPC protocol/);
});
