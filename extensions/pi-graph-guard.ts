import { existsSync, realpathSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { V3NodeContract } from "../src/v3/workspace.ts";
import { isReadOnlyRemoteToolName } from "../src/v3/remote-tools.ts";

type GuardContract = V3NodeContract;

function canonical(path: string): string {
	let candidate = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(candidate)) {
		const parent = dirname(candidate);
		if (parent === candidate) break;
		suffix.unshift(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		candidate = parent;
	}
	return resolve(existsSync(candidate) ? realpathSync.native(candidate) : candidate, ...suffix);
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function hasProtectedControlSegment(root: string, target: string): boolean {
	if (!within(root, target)) return false;
	const parts = relative(root, target).split(sep).filter(Boolean);
	return parts.some((part, index) => part === ".git" || part === ".pi-graph" || part === ".pi-subagents" || (part === "agents" && parts[index - 1] === ".pi"));
}

function isNestedProtectedControlPath(root: string, target: string): boolean {
	if (!within(root, target)) return false;
	const parts = relative(root, target).split(sep).filter(Boolean);
	return parts.some((part, index) => index > 0 && (part === ".git" || part === ".pi-graph" || part === ".pi-subagents" || (part === "agents" && parts[index - 1] === ".pi")));
}

function inScopes(path: string, scopes: GuardContract["readScope"]): boolean {
	const target = canonical(path);
	return scopes.some((scope) => scope.kind === "file" ? canonical(scope.path) === target : within(canonical(scope.path), target));
}

function contractAt(cwd: string): GuardContract | null {
	const path = join(cwd, ".pi-graph", "node-contract.json");
	if (!existsSync(path)) return null;
	const contract = JSON.parse(readFileSync(path, "utf8")) as Partial<V3NodeContract>;
	if (contract.schemaVersion !== 1 || contract.workspaceCwd !== cwd || !Array.isArray(contract.readScope) || !Array.isArray(contract.writeScope) || contract.allowBash !== false
		|| typeof contract.readOnly !== "boolean"
		|| !Array.isArray(contract.toolFilter) || contract.toolFilter.some((name: unknown) => typeof name !== "string" || !name)
		|| "resourceScopes" in contract) throw new Error("invalid node contract");
	return contract as GuardContract;
}

function pathInput(event: ToolCallEvent, cwd: string): string | null {
	const input = event.input as Record<string, unknown>;
	if (!["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) return null;
	const value = input.path;
	return typeof value === "string" && value.trim() ? resolve(cwd, value) : cwd;
}

function hasPathLikeInput(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasPathLikeInput);
	return Object.entries(value as Record<string, unknown>).some(([key, child]) => /(?:path|file|dir|cwd|root)/i.test(key) || hasPathLikeInput(child));
}

function bashViolation(command: string, contract: GuardContract): string | null {
	void command;
	void contract;
	return "bash is disabled for graph child nodes because shell path authority cannot be proven soundly.";
}

export function remoteToolViolation(toolName: string, contract: Pick<V3NodeContract, "toolFilter">): string | null {
	if (!contract.toolFilter.includes(toolName)) return `non-file tool '${toolName}' is outside the exact graph toolFilter.`;
	if (!isReadOnlyRemoteToolName(toolName)) return `non-file tool '${toolName}' is not an attested read-only operation.`;
	return null;
}

export default function piGraphGuard(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD !== "1") return;
	pi.events.emit("subagent:acknowledge-extension", { id: "pi-graph-guard" });
	pi.on("tool_call", (event, ctx) => {
		let contract: GuardContract | null;
		try {
			contract = contractAt(ctx.cwd);
		} catch {
			return { block: true, reason: "pi-graph guard: node contract is malformed; failing closed." };
		}
		if (!contract) return;
		if (contract.toolFilter.length > 0 && !contract.toolFilter.includes(event.toolName)) {
			return { block: true, reason: `pi-graph guard: tool '${event.toolName}' is outside the graph toolFilter.` };
		}
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			const violation = bashViolation(typeof command === "string" ? command : "", contract);
			if (violation) return { block: true, reason: `pi-graph guard: ${violation}` };
			return;
		}
		const target = pathInput(event, ctx.cwd);
			if (!target) {
				if (hasPathLikeInput(event.input)) return { block: true, reason: `pi-graph guard: unsupported path-bearing tool '${event.toolName}' is blocked.` };
			const remoteViolation = remoteToolViolation(event.toolName, contract);
			if (remoteViolation) return { block: true, reason: `pi-graph guard: ${remoteViolation}` };
			return;
		}
		const contractFile = join(contract.workspaceCwd, ".pi-graph", "node-contract.json");
		const writing = event.toolName === "write" || event.toolName === "edit";
		if (writing && contract.readOnly) return { block: true, reason: "pi-graph guard: this graph is read-only." };
		if (isNestedProtectedControlPath(contract.workspaceCwd, target)) {
			return { block: true, reason: "pi-graph guard: nested runtime, Agent, and repository control paths are not accessible." };
		}
		if (hasProtectedControlSegment(contract.workspaceCwd, target) && canonical(target) !== canonical(contractFile) && !inScopes(target, writing ? contract.writeScope : contract.readScope)) {
			return { block: true, reason: "pi-graph guard: nested runtime, Agent, and repository control paths are not accessible." };
		}
		const protectedWriteRoots = [join(contract.workspaceCwd, ".pi-graph"), join(contract.workspaceCwd, ".pi", "agents"), join(contract.workspaceCwd, ".pi-subagents"), join(contract.workspaceCwd, ".git"), ...(contract.protectedWorkspaceRoots ?? [])];
		if (writing && protectedWriteRoots.some((root) => within(canonical(root), canonical(target)))) {
			return { block: true, reason: "pi-graph guard: runtime, Agent, and repository control files are read-only." };
		}
		const protectedReadRoots = [join(contract.workspaceCwd, ".pi", "agents"), join(contract.workspaceCwd, ".pi-subagents"), join(contract.workspaceCwd, ".git"), ...(contract.protectedWorkspaceRoots ?? [])];
		if (!writing && protectedReadRoots.some((root) => within(canonical(root), canonical(target)))) {
			return { block: true, reason: "pi-graph guard: runtime, Agent, and repository control files are not child-readable." };
		}
		if (canonical(target) === canonical(contractFile)) {
			return;
		}
		const scopes = writing ? contract.writeScope : [...contract.readScope, ...contract.writeScope];
		if (!inScopes(target, scopes)) return { block: true, reason: `pi-graph guard: ${event.toolName} path is outside declared ${writing ? "write" : "read"} scope: ${target}` };
	});
}
