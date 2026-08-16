import { mkdtemp, mkdir, readdir, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileGraphSpecV3 } from "../../src/v3/compiler.ts";
import { initializeV3Run } from "../../src/v3/initialize.ts";
import { readLatestV3Attempt, readV3AcceptanceEvidence } from "../../src/v3/attempt.ts";
import { SubagentRpcClient } from "../../src/v3/rpc.ts";
import { V3GraphRunner } from "../../src/v3/runner.ts";
import type { GraphSpecV3 } from "../../src/v3/types.ts";
import { MockSubagents, completeChild, failChild } from "../helpers/mock-subagents.ts";

async function once(i: number): Promise<boolean> {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-retry-repro-")));
	const sourceDir = join(sandbox, "source");
	const runsDir = join(sandbox, "runs");
	await mkdir(sourceDir, { recursive: true });
	await mkdir(runsDir, { recursive: true });
	const graphDir = join(runsDir, "graph-test");
	const runInstanceId = `run-${Date.now()}-${i}`;
	const runDir = join(graphDir, runInstanceId);
	const mock = new MockSubagents();
	let attempts = 0;
	mock.behaviors.set("FLAKY", async (input) => {
		attempts += 1;
		if (attempts === 1) await failChild(input);
		else await completeChild({ ...input, writes: [{ path: "flaky.txt", content: "ok\n" }] });
	});
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "flaky retry",
		nodes: [
			{
				taskId: "flaky",
				agent: "test-agent",
				task: "FLAKY node",
				sideEffect: "local_write",
				writeScope: [{ kind: "file", path: "flaky.txt" }],
				validationCommands: ["test -f flaky.txt"],
				retryPolicy: { maxAttempts: 3, retryOn: ["task_failed"], backoffMs: 50 },
			},
		],
	};
	const graph = compileGraphSpecV3(spec);
	const rpc = new SubagentRpcClient(mock);
	const init = await initializeV3Run({ trustedRoot: resolve(runsDir), runDir, graph, sessionId: "s", supervisorEpoch: "e", sourceCwd: sourceDir, runInstanceId });
	const runner = new V3GraphRunner({ rpc, runDir, graph, authorization: init.authorization, sourceCwd: sourceDir, sessionId: "s", supervisorEpoch: "e", preflightAgent: async () => undefined });
	const snapshot = await runner.run();
	const ok = snapshot.status === "complete" && attempts >= 2;
	if (!ok) {
		console.error(`=== FAIL run ${i}: attempts=${attempts} status=${snapshot.status}`);
		console.error(JSON.stringify(snapshot, null, 2).slice(0, 6000));
		const files = await readdir(runDir);
		console.error("runDir files:", files);
		for (const task of ["flaky"]) {
			const attemptsDir = join(runDir, "nodes", task, "attempts");
			try {
				const entries = await readdir(attemptsDir);
				for (const e of entries.sort()) {
					const base = join(attemptsDir, e, "attempt.json");
					const raw = await readFile(base, "utf8").catch(() => null);
					if (raw) console.error(`  [${e}]`, raw.slice(0, 900));
				}
			} catch (err) {
				console.error(`  attempts/${task}:`, String(err));
			}
		}
		await mock.dispose();
		return false;
	}
	const latest = await readLatestV3Attempt(runDir, "flaky");
	console.log(`run ${i}: status=${snapshot.status} attempts=${attempts} latest.attempt=${latest?.evidence.attempt} latest.phase=${latest?.evidence.phase}`);
	await mock.dispose();
	return true;
}

const ITER = Number(process.argv[2] ?? "1");
let failures = 0;
for (let i = 0; i < ITER; i++) {
	const ok = await once(i);
	if (!ok) failures += 1;
}
console.log(`\nDONE: ${ITER - failures}/${ITER} ok, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
