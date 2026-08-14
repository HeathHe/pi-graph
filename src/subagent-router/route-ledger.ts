import type { ParentRoutingEnforcement, RequiredParentRoute } from "./types.ts";

const MANAGEMENT_ACTIONS = new Set(["list", "status", "doctor", "create", "update", "delete", "eject", "disable", "enable", "reset"]);
const PARENT_DOMAIN_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls", "fffind", "fast_context_search"]);
const SAFE_GRAPH_ACTIONS = new Set(["status", "list", "doctor", "recommend", "stop"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskAgents(input: unknown): string[] {
	if (!isRecord(input)) return [];
	if (typeof input.action === "string" && MANAGEMENT_ACTIONS.has(input.action)) return [];
	const agents: string[] = [];
	const visit = (value: unknown): void => {
		if (!isRecord(value)) return;
		if (typeof value.agent === "string") agents.push(value.agent);
		for (const key of ["tasks", "chain", "parallel"]) {
			const child = value[key];
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	};
	visit(input);
	return agents;
}

export class ParentRouteLedger {
	private route: RequiredParentRoute | undefined;

	begin(route: RequiredParentRoute | undefined): void {
		this.route = route;
	}

	current(): RequiredParentRoute | undefined {
		return this.route;
	}

	onToolCall(event: { toolCallId: string; toolName: string; input: unknown }, enforcement: ParentRoutingEnforcement): { block?: boolean; reason?: string } | undefined {
		const route = this.route;
		if (!route || route.status === "completed") return;
		if (event.toolName === "graph" && isRecord(event.input) && typeof event.input.action === "string" && SAFE_GRAPH_ACTIONS.has(event.input.action)) return;
		if (event.toolName === "subagent" && isRecord(event.input) && typeof event.input.action === "string" && MANAGEMENT_ACTIONS.has(event.input.action)) return;
		if (event.toolName === "routed_subagent" || event.toolName === "subagent") {
			const agents = taskAgents(event.input);
			if (agents.length === 1 && agents[0] === route.agent) {
				if (route.visualEvidenceId) {
					const supplied = isRecord(event.input) && typeof event.input.visualEvidenceId === "string" ? event.input.visualEvidenceId : undefined;
					if (event.toolName !== "routed_subagent" || supplied !== route.visualEvidenceId) {
						if (enforcement === "require") {
							return { block: true, reason: `Parent route ${route.decisionId} requires the sealed visualEvidenceId '${route.visualEvidenceId}' on routed_subagent(agent='${route.agent}').` };
						}
						return;
					}
				}
				route.status = "dispatching";
				route.dispatchToolCallId = event.toolCallId;
				return;
			}
			if (enforcement === "require" && agents.length > 0) {
				return { block: true, reason: `Parent route ${route.decisionId} requires '${route.agent}' (${route.capabilityId}) before another specialist is dispatched.` };
			}
		}
		if (enforcement === "require" && event.toolName === "graph") {
			return { block: true, reason: `Parent route ${route.decisionId} is a single read-only specialist request. Use routed_subagent(agent='${route.agent}') instead of Graph.` };
		}
		if (enforcement === "require" && PARENT_DOMAIN_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Parent route ${route.decisionId} requires routed_subagent(agent='${route.agent}') before parent-side ${event.toolName}. Delegate the specialist request instead of performing it in the parent.`,
			};
		}
		return;
	}

	onToolCallBlocked(toolCallId: string): void {
		const route = this.route;
		if (!route || route.status !== "dispatching" || route.dispatchToolCallId !== toolCallId) return;
		route.status = "failed";
	}

	onToolResult(event: { toolCallId: string; isError?: boolean }): void {
		const route = this.route;
		if (!route || route.dispatchToolCallId !== event.toolCallId) return;
		route.status = event.isError ? "failed" : "completed";
	}

	needsRepair(enforcement: ParentRoutingEnforcement): RequiredParentRoute | undefined {
		const route = this.route;
		if (enforcement !== "require" || !route || !["required", "dispatching", "failed"].includes(route.status) || route.repairCount >= 1) return undefined;
		if (route.status === "failed" && !route.dispatchToolCallId) return undefined;
		route.repairCount += 1;
		return route;
	}
}
