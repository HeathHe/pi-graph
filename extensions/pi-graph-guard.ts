import { existsSync, realpathSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { NodeContract } from "../src/workspace.ts";

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

function inScopes(path: string, scopes: NodeContract["readScope"]): boolean {
	const target = canonical(path);
	return scopes.some((scope) => scope.kind === "file" ? canonical(scope.path) === target : within(canonical(scope.path), target));
}

function contractAt(cwd: string): NodeContract | null {
	const path = join(cwd, ".pi-graph", "node-contract.json");
	if (!existsSync(path)) return null;
	const contract = JSON.parse(readFileSync(path, "utf8")) as NodeContract;
	if (contract.schemaVersion !== 1 || contract.workspaceCwd !== cwd || !Array.isArray(contract.readScope) || !Array.isArray(contract.writeScope) || typeof contract.allowBash !== "boolean") throw new Error("invalid node contract");
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
	if (!contract.allowBash) return "bash is disabled for this graph node.";
	if (/(^|[\s/'"])(?:\.pi-graph)(?:[/\s'"]|$)/.test(command)) return "graph control files are not accessible from bash.";
	if (/(^|\s)(sudo\b|rm\s+-rf\s+\/|shutdown\b|reboot\b)/.test(command)) return "dangerous shell operation is blocked.";
	if (/(^|[\s;|&()'"/])\.\.(?:\/|(?=[\s;|&()'"]|$))/.test(command) || /(^|[\s;|&])cd\s+(?:['"]?)(?:\.\.|\/|~)/.test(command)) return "shell parent-directory traversal is blocked.";
	if (/(^|[\s=])~(?:\/|\s|$)|\$(?:HOME|OLDPWD|PWD)\b/.test(command)) return "shell home/environment path expansion is blocked.";
	const absolutePaths = command.match(/(?:^|[\s'"=<>|])\/(?:[^\s'"<>|;&]+)/g) ?? [];
	for (const token of absolutePaths) {
		const path = token.trim().replace(/^[='"<>|]+|['"<>|]+$/g, "");
		if (path === "/dev/null") continue;
		if (!within(contract.workspaceCwd, canonical(path))) return `shell path escapes workspace: ${path}`;
	}
	return null;
}

export default function piGraphGuard(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD !== "1") return;
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
			return;
		}
		const contractFile = join(contract.workspaceCwd, ".pi-graph", "node-contract.json");
		const writing = event.toolName === "write" || event.toolName === "edit";
		if (canonical(target) === canonical(contractFile)) {
			if (writing) return { block: true, reason: "pi-graph guard: node contract is read-only." };
			return;
		}
		const scopes = writing ? contract.writeScope : [...contract.readScope, ...contract.writeScope];
		if (!inScopes(target, scopes)) return { block: true, reason: `pi-graph guard: ${event.toolName} path is outside declared ${writing ? "write" : "read"} scope: ${target}` };
	});
}
