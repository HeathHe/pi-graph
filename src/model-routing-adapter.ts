import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AcceptanceRecord } from "./authorization.ts";
import type { CompiledGraph, CompiledNode, GraphSnapshot, NodeRuntimeState, ResultManifest } from "./types.ts";
import type { GraphStore } from "./store.ts";
import { evaluateRoutingPolicy } from "./model-routing/evaluate-routing-policy.ts";
import { loadModelRoutingConfig, type ModelRoutingConfigInput } from "./model-routing/config.ts";
import { defaultMaxAuthorizationStore, validateMaxAuthorization } from "./model-routing/runtime-state.ts";
import type { MaxAuthorization, MaxAuthorizationStore, ModelExecution, ModelRoutingConfig, ProducerModelExecution, RoutingAvailableModel, RoutingDecision, TaskRisk } from "./model-routing/types.ts";
import { baseModel } from "./model-routing/model-execution.ts";
import { digestFile } from "./workspace.ts";
import { sealRoutingDecision } from "./model-routing/validate-routing-decision.ts";

export function graphRoutingTaskBinding(input: { graphId: string; taskId: string; task: string }): string {
	return createHash("sha256").update(JSON.stringify({ scope: "pi-graph", graphId: input.graphId, taskId: input.taskId, task: input.task })).digest("hex");
}

export function subagentRoutingTaskBinding(input: { toolCallId: string; taskIndex: number; agent?: string; task?: string }): string {
	return createHash("sha256").update(JSON.stringify({ scope: "pi-subagents", ...input })).digest("hex");
}

function legacyModel(node: Pick<CompiledNode, "model" | "thinking">): string | undefined {
	if (!node.model) return undefined;
	return node.thinking ? `${node.model}:${node.thinking}` : node.model;
}

async function producerExecutions(
	graph: CompiledGraph,
	node: CompiledNode,
	store: GraphStore,
	config: ModelRoutingConfig,
): Promise<ProducerModelExecution[]> {
	const refs = node.producerRefs?.length ? node.producerRefs : node.dependsOn;
	if (refs.length === 0) return [];
	const snapshot = await store.loadSnapshot();
	const output: ProducerModelExecution[] = [];
	for (const taskId of refs) {
		const state = snapshot.nodes[taskId];
		if (state?.status !== "accepted") {
			output.push({ taskId, resolvedModel: "", modelFamily: "", providerDomain: "", identityConfidence: "unknown" });
			continue;
		}
		const attempt = state.attempts.at(-1);
		const manifestPath = attempt?.manifestPath ?? store.path("nodes", taskId, `attempt-${attempt?.attempt ?? state.attempt}`, "result-manifest.json");
		try {
			await store.assertManagedFilePath(manifestPath, `Producer ResultManifest for ${taskId}`);
			const authority = await store.readAttemptRecord(taskId, attempt?.attempt ?? state.attempt);
			const acceptancePath = store.path("nodes", taskId, `attempt-${attempt?.attempt ?? state.attempt}`, "acceptance.json");
			await store.assertManagedFilePath(acceptancePath, `Producer acceptance for ${taskId}`);
			const acceptance = JSON.parse(await readFile(acceptancePath, "utf8")) as AcceptanceRecord;
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ResultManifest;
			const attemptNumber = attempt?.attempt ?? state.attempt;
			if (authority.phase !== "accepted" || authority.taskId !== taskId || authority.attempt !== attemptNumber || authority.attemptNonce !== acceptance.attemptNonce) throw new Error("producer authority identity is not accepted");
			if (acceptance.graphId !== graph.graphId || acceptance.taskId !== taskId || acceptance.attempt !== attemptNumber || await digestFile(manifestPath) !== acceptance.manifestDigest) throw new Error("producer acceptance evidence does not match the manifest");
			if (manifest.graphId !== graph.graphId || manifest.taskId !== taskId || manifest.attempt !== attemptNumber || manifest.status !== "complete" || !manifest.modelExecution) throw new Error("accepted producer manifest has no valid modelExecution provenance");
			const execution = manifest.modelExecution as ModelExecution;
			const registry = config.registry.models.find((entry) => entry.model === baseModel(execution.resolvedModel) || entry.aliases?.includes(baseModel(execution.resolvedModel)));
			if (!registry || execution.routingViolations?.length) throw new Error("producer model identity is unregistered or violated its sealed route");
			output.push({
				taskId,
				resolvedModel: execution.resolvedModel,
				modelFamily: registry.family,
				providerDomain: registry.providerDomain,
				identityConfidence: execution.identityConfidence,
			});
		} catch {
			output.push({ taskId, resolvedModel: "", modelFamily: "", providerDomain: "", identityConfidence: "unknown" });
		}
	}
	return output;
}

export interface GraphRoutingInput {
	graph: CompiledGraph;
	node: CompiledNode;
	state: NodeRuntimeState;
	store: GraphStore;
	config?: ModelRoutingConfig;
	configInput?: ModelRoutingConfigInput;
	authorizationStore?: MaxAuthorizationStore;
	availableModels?: ReadonlyArray<RoutingAvailableModel>;
	consumeMaxAuthorization?: boolean;
}

export async function resolveGraphRoutingDecision(input: GraphRoutingInput): Promise<RoutingDecision | undefined> {
	if (!input.node.routingProfile) return undefined;
	const config = input.config ?? await loadModelRoutingConfig(input.configInput);
	const previousAttempt = input.state.attempts.at(-1);
	const previousDecisionBytes = previousAttempt?.routingDecision as RoutingDecision | undefined;
	const previousDecision = previousDecisionBytes?.fallbackLevel === "L3" || previousAttempt?.failure?.kind === "routing_preflight_drift"
		? undefined
		: previousDecisionBytes;
	const previousRetryKind = previousAttempt?.failure?.retryKind;
	const retryKind = previousDecision
		? previousRetryKind === "provider" ? "provider"
			: previousRetryKind === "model_degrade" ? "model_degrade"
				: "task_retry"
		: undefined;
	return evaluateRoutingPolicy(config, {
		taskBinding: graphRoutingTaskBinding({ graphId: input.graph.graphId, taskId: input.node.taskId, task: input.node.task }),
		agent: input.node.agent,
		routingProfile: input.node.routingProfile,
		taskRisk: input.node.taskRisk as TaskRisk | undefined,
		requestedModel: legacyModel(input.node),
		producerExecutions: await producerExecutions(input.graph, input.node, input.store, config),
		maxAuthorization: input.node.maxAuthorization as MaxAuthorization | undefined,
		authorizationStore: input.authorizationStore ?? defaultMaxAuthorizationStore,
		consumeMaxAuthorization: input.consumeMaxAuthorization ?? true,
		previousDecision,
		...(retryKind ? { retryKind } : {}),
		availableModels: input.availableModels,
		requireAvailableModels: true,
	});
}

export function blockGraphRoutingDecision(decision: RoutingDecision, reason: string): RoutingDecision {
	const {
		seal: _seal,
		selectedModel: _selectedModel,
		modelFamily: _modelFamily,
		provider: _provider,
		providerDomain: _providerDomain,
		candidateIndex: _candidateIndex,
		maxAuthorizationUse: _maxAuthorizationUse,
		...base
	} = decision;
	const now = new Date().toISOString();
	return sealRoutingDecision({
		...base,
		decisionId: randomUUID(),
		createdAt: now,
		fallbackLevel: "L3",
		parentDecisionId: decision.decisionId,
		reason,
		sealedAt: now,
	});
}

export async function authorizeLegacyMax(
	graph: Pick<CompiledGraph, "graphId">,
	node: Pick<CompiledNode, "taskId" | "task" | "model" | "thinking" | "maxAuthorization">,
	config?: ModelRoutingConfig,
	store: MaxAuthorizationStore = defaultMaxAuthorizationStore,
): Promise<void> {
	const model = legacyModel(node as CompiledNode);
	if (!model || !/(?:^|:)max$/.test(model)) return;
	const taskBinding = graphRoutingTaskBinding({ graphId: graph.graphId, taskId: node.taskId, task: node.task });
	const effectiveConfig = config ?? await loadModelRoutingConfig();
	validateMaxAuthorization(node.maxAuthorization as MaxAuthorization | undefined, {
		taskBinding,
		model,
		trustedIssuers: effectiveConfig.policy.maxAuthorizationIssuers ?? {},
	});
	store.consume(node.maxAuthorization! as MaxAuthorization, { taskBinding, model });
}

export function routingAttemptBudget(node: CompiledNode, snapshot: GraphSnapshot["nodes"][string]): number {
	const decisions = snapshot.attempts.map((attempt) => attempt.routingDecision as RoutingDecision | undefined).filter((decision): decision is RoutingDecision => Boolean(decision));
	if (decisions.length === 0) return node.retryPolicy.maxAttempts;
	const initial = decisions[0]!;
	return node.retryPolicy.maxAttempts + initial.budget.modelDegradations;
}
