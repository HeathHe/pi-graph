export type ParentRouteLane = "parent_direct" | "direct_subagent" | "graph_candidate";

export type ParentRouteStatus = "required" | "dispatching" | "completed" | "failed";

export interface CapabilityCatalogEntry {
	capabilityId: string;
	agent: string;
	description: string;
	source: string;
	filePath: string;
	idempotent: boolean | string;
	sideEffect: string;
	routingProfile?: string;
}

export interface CapabilityCatalog {
	entries: CapabilityCatalogEntry[];
	diagnostics: string[];
	generatedAt: string;
	digest: string;
}

export interface RequiredParentRoute {
	decisionId: string;
	turnId: string;
	prompt: string;
	lane: Extract<ParentRouteLane, "direct_subagent">;
	capabilityId: string;
	agent: string;
	visualEvidenceId?: string;
	reasonCode: "EXPLICIT_PRODUCT_PERSPECTIVE" | "EXPLICIT_VISUAL_INTERACTION_REVIEW" | "VISUAL_CONTEXT_FOLLOW_UP";
	status: ParentRouteStatus;
	dispatchToolCallId?: string;
	repairCount: number;
}

export type ParentRoutingEnforcement = "shadow" | "require";
