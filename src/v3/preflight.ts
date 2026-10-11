import { resolve } from "node:path";
import { createJiti } from "jiti";

interface PreflightContractAgent {
	name?: string;
	source?: string;
	filePath?: string;
	definitionDigest?: string;
}

interface PreflightContract {
 customModelDefinitions?:import("../runtime/custom-models.ts").CustomGraphModel[];
	model?: string;
	modelCandidates?: string[];
	thinking?: string;
	agent?: PreflightContractAgent;
	tools?: {
		effectiveAllowlist?: string[];
		explicitAllowlist?: boolean;
		runtimeExtensions?: string[];
		configuredExtensions?: string[];
		extensionArgs?: string[];
		disableAmbientExtensions?: boolean;
	};
	launchContractDigest?: string;
	digest?: string;
}

export interface V3PreflightParentModel {
	provider: string;
	id: string;
}

export interface V3PreflightAvailableModel {
	provider: string;
	id: string;
	fullId?: string;
	api?: string;
	input?: readonly string[];
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

type PreflightResolver = (input: Record<string, unknown>) => Promise<
	| { ok: true; contract: PreflightContract }
	| { ok: false; message: string }
>;

let cachedResolver: PreflightResolver | undefined;
let cachedResolverPromise: Promise<PreflightResolver> | undefined;

async function publicPreflightResolver(): Promise<PreflightResolver> {
 const { resolveSubagentLaunchContract } = await import('../runtime/launch-contract.ts');
 return resolveSubagentLaunchContract as unknown as PreflightResolver;
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
			agentScope: "project",
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

/** Native ceilings propagate to descendants; Graph's explicit filter must travel with them. */
export function v3NativeToolCeiling(parentTools: readonly string[] | undefined, toolFilter?: readonly string[]) {
	if (parentTools === undefined) return undefined;
	const allowedTools = [...new Set([...parentTools.filter(tool => tool !== "contact_supervisor" && tool !== "subagent_supervisor" && !tool.startsWith("intercom")), "graph_mailbox"])]
		.filter((tool) => tool === "graph_mailbox" || !toolFilter?.length || toolFilter.includes(tool));
	return { version: 1 as const, allowedTools, denyExtensions: false, sources: ["pi-graph-parent"] };
}

export interface V3AgentLaunchPreflightInput {
	graphToolFilter?: string[];
	parentToolAllowlist?: string[];
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	thinking?: string | false;
	turnBudget?: { maxTurns: number; graceTurns?: number };
	agentScope?: "project" | "both";
	parentModel?: V3PreflightParentModel;
	availableModels?: readonly V3PreflightAvailableModel[];
	preferredProvider?: string;
}

export interface V3AgentLaunchExtensionPlan {
	runtimeExtensions: string[];
	configuredExtensions: string[];
	extensionArgs: string[];
	disableAmbientExtensions: boolean;
}

export type V3AgentLaunchPreflightResult =
	| {
		ok: true;
  customModelDefinitions?:import("../runtime/custom-models.ts").CustomGraphModel[];
		name: string;
		agentDefinitionDigest: string;
		launchContractDigest: string;
		model?: string;
		modelCandidates: string[];
		thinking?: string;
		extensions: V3AgentLaunchExtensionPlan;
		toolAllowlist?: string[];
		explicitToolAllowlist?: boolean;
	}
	| { ok: false; message: string };

function exactStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
		throw new Error(`the public preflight result omitted valid ${field} evidence`);
	}
	return [...value];
}

function extensionPlan(contract: PreflightContract): V3AgentLaunchExtensionPlan {
	if (!contract.tools || typeof contract.tools.disableAmbientExtensions !== "boolean") {
		throw new Error("the public preflight result omitted exact child extension evidence");
	}
	return {
		runtimeExtensions: exactStringArray(contract.tools.runtimeExtensions, "runtimeExtensions"),
		configuredExtensions: exactStringArray(contract.tools.configuredExtensions, "configuredExtensions"),
		extensionArgs: exactStringArray(contract.tools.extensionArgs, "extensionArgs"),
		disableAmbientExtensions: contract.tools.disableAmbientExtensions,
	};
}

/**
 * Resolve one exact Pi Agent and the public launch-affecting subset. The adapter
 * supplies hints; pi-subagents remains the only component that resolves Agent
 * definitions, model availability, and effective thinking.
 */
export async function v3PreflightAgentLaunch(input: V3AgentLaunchPreflightInput): Promise<V3AgentLaunchPreflightResult> {
	try {
		const resolver = await publicPreflightResolver();
		const result = await resolver({
			agent: input.agent,
			agentScope: input.agentScope ?? "both",
			cwd: resolve(input.cwd),
			context: "fresh",
			task: input.task,
			...(input.parentToolAllowlist === undefined ? {} : { capabilityCeiling: v3NativeToolCeiling(input.parentToolAllowlist, input.graphToolFilter) }),
			...(input.model === undefined ? {} : { model: input.model }),
			...(input.thinking === undefined ? {} : { thinking: input.thinking }),
			...(input.turnBudget === undefined ? {} : { turnBudget: input.turnBudget }),
			...(input.parentModel === undefined ? {} : { parentModel: input.parentModel }),
			...(input.availableModels === undefined ? {} : { availableModels: input.availableModels }),
			...(input.preferredProvider === undefined ? {} : { preferredProvider: input.preferredProvider }),
		});
		if (!result.ok) return { ok: false, message: result.message };
		const { agent, launchContractDigest } = result.contract;
		if (!agent || typeof agent.name !== "string" || typeof agent.definitionDigest !== "string" || typeof launchContractDigest !== "string") {
			return { ok: false, message: "the public preflight result omitted exact Agent launch evidence" };
		}
		const modelCandidates = exactStringArray(result.contract.modelCandidates, "modelCandidates");
		// The owned resolver enforces registered models and configured role modelScope.
		// Model families do not override an explicit valid scope authorization.
		if (typeof result.contract.tools?.explicitAllowlist !== "boolean") {
			return { ok: false, message: "the public preflight result omitted explicit child tool allowlist evidence" };
		}
		return {
			ok: true,
			name: agent.name,
   ...(result.contract.customModelDefinitions?{customModelDefinitions:result.contract.customModelDefinitions}:{}),
			agentDefinitionDigest: agent.definitionDigest,
			launchContractDigest,
			...(typeof result.contract.model === "string" ? { model: result.contract.model } : {}),
			modelCandidates,
			...(typeof result.contract.thinking === "string" ? { thinking: result.contract.thinking } : {}),
			extensions: extensionPlan(result.contract),
			toolAllowlist: exactStringArray(result.contract.tools?.effectiveAllowlist, "effectiveAllowlist"),
			explicitToolAllowlist: result.contract.tools?.explicitAllowlist === true,
		};
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
