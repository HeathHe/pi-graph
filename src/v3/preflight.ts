import { homedir } from "node:os";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

interface PreflightContractAgent {
	name?: string;
	source?: string;
	filePath?: string;
	definitionDigest?: string;
}

type PreflightResolver = (input: Record<string, unknown>) => Promise<
	| { ok: true; contract: { modelCandidates?: string[]; agent?: PreflightContractAgent; launchContractDigest?: string; digest?: string } }
	| { ok: false; message: string }
>;

let cachedResolver: PreflightResolver | undefined;
let cachedResolverPromise: Promise<PreflightResolver> | undefined;

async function publicPreflightResolver(): Promise<PreflightResolver> {
	if (cachedResolver) return cachedResolver;
	if (cachedResolverPromise) return cachedResolverPromise;
	cachedResolverPromise = (async () => {
		const managedPackageRoot = resolve(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
		const bundledPackageRoot = dirname(createRequire(import.meta.url).resolve("pi-subagents"));
		const candidates = [
			resolve(managedPackageRoot, "src", "api", "preflight.ts"),
			"pi-subagents/preflight",
		];
		const failures: string[] = [];
		for (const candidate of candidates) {
			try {
				if (candidate.startsWith("/")) {
					const info = await lstat(candidate);
					if (!info.isFile() || info.isSymbolicLink()) throw new Error("managed preflight entry is not a regular file");
				}
				const loaded = await createJiti(import.meta.url).import(candidate) as { resolveSubagentLaunchContract?: PreflightResolver };
				if (typeof loaded.resolveSubagentLaunchContract !== "function") throw new Error("resolveSubagentLaunchContract is not exported");
				cachedResolver = loaded.resolveSubagentLaunchContract;
				void bundledPackageRoot;
				return cachedResolver;
			} catch (error) {
				failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(`pi-subagents/preflight is unavailable. ${failures.join("; ")}`);
	})();
	try {
		return await cachedResolverPromise;
	} catch (error) {
		cachedResolverPromise = undefined;
		throw error;
	}
}

/**
 * V3 governance-free agent preflight: delegates agent resolution entirely to
 * pi-subagents' public preflight contract. pi-graph never selects or pins a model.
 */
export async function v3PreflightAgent(input: { agent: string; cwd: string; sessionId?: string }): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
	try {
		const resolver = await publicPreflightResolver();
		const result = await resolver({
			agent: input.agent,
			cwd: resolve(input.cwd),
			context: "fresh",
			task: "Resolve this Agent for the V3 capability catalog without launching it.",
		});
		if (!result.ok) return { ok: false, message: result.message };
		const agent = result.contract.agent;
		if (!agent || typeof agent.name !== "string" || typeof agent.source !== "string" || typeof agent.filePath !== "string") {
			return { ok: false, message: "the public preflight result omitted the selected Agent definition" };
		}
		return { ok: true, name: agent.name };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
