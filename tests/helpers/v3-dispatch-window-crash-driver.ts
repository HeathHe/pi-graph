// SIGKILL fixture: pause the RPC caller after pi-subagents created the durable
// child but before Runner can persist its dispatch binding.
import { writeFile } from "node:fs/promises";
import { V3GraphHost } from "../../src/v3/host.ts";
import { SubagentRpcClient } from "../../src/v3/rpc.ts";
import type { GraphSpecV3 } from "../../src/v3/types.ts";
import { MockSubagents, completeChild } from "./mock-subagents.ts";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env ${name}`);
	return value;
}

class DispatchWindowRpc extends SubagentRpcClient {
	private readonly readyFile: string;
	constructor(events: MockSubagents, readyFile: string) {
		super(events);
		this.readyFile = readyFile;
	}
	override async spawn(params: Record<string, unknown>, stableRequestId?: string, beforeEmit?: () => void) {
		const identity = await super.spawn(params, stableRequestId, beforeEmit);
		await writeFile(this.readyFile, "spawned-before-binding\n", "utf8");
		await new Promise<void>(() => undefined);
		return identity;
	}
}

async function main(): Promise<void> {
	const runsDir = required("V3_E2E_RUNS_DIR");
	const sourceDir = required("V3_E2E_SOURCE_DIR");
	const readyFile = required("V3_E2E_READY_FILE");
	const mock = new MockSubagents();
	mock.behaviors.set("DISPATCH_WINDOW", (input) => completeChild({ ...input, output: "durable-child-output" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "dispatch crash window",
		nodes: [{ taskId: "window", agent: "test-agent", task: "DISPATCH_WINDOW", sideEffect: "local_read" }],
	};
	const host = new V3GraphHost({
		rpc: new DispatchWindowRpc(mock, readyFile),
		runsDir,
		sessionId: "dispatch-window-crashed",
		supervisorEpoch: "dispatch-window-crashed",
		preflightAgent: async () => undefined,
	});
	const started = await host.start(spec, sourceDir);
	await host.waitForCompletion(started.graphId);
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
