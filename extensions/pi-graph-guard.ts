import { existsSync, realpathSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { NodeContract } from "../src/workspace.ts";
import { canonicalRemoteToolInput, isReadOnlyRemoteToolName } from "../src/remote-tools.ts";

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

function inScopes(path: string, scopes: NodeContract["readScope"]): boolean {
	const target = canonical(path);
	return scopes.some((scope) => scope.kind === "file" ? canonical(scope.path) === target : within(canonical(scope.path), target));
}

function contractAt(cwd: string): NodeContract | null {
	const path = join(cwd, ".pi-graph", "node-contract.json");
	if (!existsSync(path)) return null;
	const contract = JSON.parse(readFileSync(path, "utf8")) as NodeContract;
	if (contract.schemaVersion !== 1 || contract.workspaceCwd !== cwd || !Array.isArray(contract.readScope) || !Array.isArray(contract.writeScope) || typeof contract.allowBash !== "boolean"
		|| (contract.resourceScopes !== undefined && !Array.isArray(contract.resourceScopes))) throw new Error("invalid node contract");
	return contract;
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

function bashViolation(command: string, contract: NodeContract): string | null {
	void command;
	void contract;
	return "bash is disabled for graph child nodes because shell path authority cannot be proven soundly.";
}

export function remoteToolViolation(toolName: string, input: unknown, contract: Pick<NodeContract, "resourceScopes">): string | null {
	if (!isReadOnlyRemoteToolName(toolName)) return `non-file tool '${toolName}' is not an attested read-only operation.`;
	const actualInput = canonicalRemoteToolInput(input ?? {});
	const matching = (contract.resourceScopes ?? []).some((scope) => scope.access === "read"
		&& scope.toolNames?.includes(toolName)
		&& scope.toolInput !== undefined
		&& canonicalRemoteToolInput(scope.toolInput) === actualInput);
	return matching ? null : `non-file tool '${toolName}' or its exact input is not declared by the remote read contract.`;
}

export default function piGraphGuard(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD !== "1") return;
	pi.events.emit("subagent:acknowledge-extension", { id: "pi-graph-guard" });
	pi.on("tool_call", (event, ctx) => {
		let contract: NodeContract | null;
		try {
			contract = contractAt(ctx.cwd);
		} catch {
			return { block: true, reason: "pi-graph guard: node contract is malformed; failing closed." };
		}
		if (!contract) return;
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			const violation = bashViolation(typeof command === "string" ? command : "", contract);
			if (violation) return { block: true, reason: `pi-graph guard: ${violation}` };
			return;
		}
		const target = pathInput(event, ctx.cwd);
			if (!target) {
				if (hasPathLikeInput(event.input)) return { block: true, reason: `pi-graph guard: unsupported path-bearing tool '${event.toolName}' is blocked.` };
			const remoteViolation = remoteToolViolation(event.toolName, event.input, contract);
			if (remoteViolation) return { block: true, reason: `pi-graph guard: ${remoteViolation}` };
			return;
		}
		const contractFile = join(contract.workspaceCwd, ".pi-graph", "node-contract.json");
		const writing = event.toolName === "write" || event.toolName === "edit";
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
