import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const v3SourceDir = join(repositoryRoot, "src", "v3");

async function v3Sources(): Promise<Array<{ file: string; source: string }>> {
	const files = (await readdir(v3SourceDir)).filter((file) => file.endsWith(".ts")).sort();
	return Promise.all(files.map(async (file) => ({ file, source: await readFile(join(v3SourceDir, file), "utf8") })));
}

test("src/v3 has zero direct imports from model routing, subagent routing, recommendations, adapters, extensions, or legacy validation", async () => {
	const forbidden = /(?:from\s+|import\s*\()["'][^"']*(?:model-routing|subagent-router|recommend|model-routing-adapter|extensions\/|\.\.\/validation\.ts)/u;
	for (const { file, source } of await v3Sources()) assert.doesNotMatch(source, forbidden, file);
});

test("V3 relative import closure stays within its kernel and owned runtime", async () => {
	const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu;
	const pending = (await readdir(v3SourceDir)).filter((file) => file.endsWith(".ts")).map((file) => join(v3SourceDir, file));
	const visited = new Set<string>();
	while (pending.length > 0) {
		const file = resolve(pending.pop()!);
		if (visited.has(file)) continue;
		visited.add(file);
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(importPattern)) {
			const specifier = match[1]!;
			if (!specifier.startsWith(".")) continue;
			const imported = resolve(dirname(file), specifier);
			const fromV3 = relative(join(repositoryRoot, "src"), imported);
			assert.match(fromV3, /^(?:v3|runtime)\//u, "only the kernel and its owned runtime may enter the closure");
			assert.equal(fromV3.startsWith("..") || fromV3 === "", false, `${relative(repositoryRoot, file)} imports governance-bearing module ${relative(repositoryRoot, imported)}`);
			assert.doesNotMatch(relative(repositoryRoot, imported), /model-routing|subagent-router|recommend|model-routing-adapter|extensions|src\/types\.ts/u);
			pending.push(imported);
		}
	}
	assert.ok(visited.size >= 10);
});

test("V3 initialize and inspect have no governance configuration probes", async () => {
	for (const file of ["initialize.ts", "inspect.ts"]) {
		const source = await readFile(join(v3SourceDir, file), "utf8");
		assert.doesNotMatch(source, /model-registry\.json|routing-policy\.json/u, file);
	}
});

test("V3 Binding and freezing resolve all Pi Agent scopes while shadow dispatch stays project-scoped", async () => {
	const binding = await readFile(join(v3SourceDir, "binding.ts"), "utf8");
	const preflight = await readFile(join(v3SourceDir, "preflight.ts"), "utf8");
	const workspace = await readFile(join(v3SourceDir, "workspace.ts"), "utf8");
	const runner = await readFile(join(v3SourceDir, "runner.ts"), "utf8");
	assert.match(binding, /agentScope:\s*"both"/u);
	assert.match(preflight, /agentScope:\s*input\.agentScope\s*\?\?\s*"both"/u);
	assert.match(preflight, /agentScope:\s*"project"/u);
	assert.match(workspace, /discoverAgents\(sourceCwd,\s*"both"\)/u);
	assert.doesNotMatch(workspace, /discoverAgents\(sourceCwd,\s*"project"\)/u);
	assert.match(runner, /agentScope:\s*"project"/u);
});
