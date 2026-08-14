import { createHash } from "node:crypto";
import type { RoutingDecision } from "./types.ts";

function digestPayload(decision: Omit<RoutingDecision, "seal">): string {
	return createHash("sha256").update(JSON.stringify(decision)).digest("hex");
}

export function sealRoutingDecision(decision: Omit<RoutingDecision, "seal">): RoutingDecision {
	return {
		...decision,
		seal: { algorithm: "sha256", digest: digestPayload(decision) },
	};
}

export function validateRoutingDecision(value: unknown): RoutingDecision {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RoutingDecision must be an object.");
	const decision = value as RoutingDecision;
	if (
		decision.schemaVersion !== 1
		|| typeof decision.decisionId !== "string"
		|| !decision.decisionId
		|| typeof decision.taskBinding !== "string"
		|| !decision.taskBinding
		|| typeof decision.routingProfile !== "string"
		|| !decision.routingProfile
		|| !["shadow", "require"].includes(decision.enforcement)
		|| !["L0", "L1", "L2", "L3"].includes(decision.fallbackLevel)
		|| !Array.isArray(decision.eligibleCandidates)
		|| !Array.isArray(decision.producerFamilies)
		|| !Array.isArray(decision.producerProviderDomains)
		|| !["unknown", "selected_only", "runtime_reported", "verified"].includes(decision.identityConfidence)
		|| !decision.budget
		|| !Number.isInteger(decision.budget.providerRetries)
		|| decision.budget.providerRetries < 0
		|| !Number.isInteger(decision.budget.modelDegradations)
		|| decision.budget.modelDegradations < 0
		|| !Number.isInteger(decision.degradationIndex)
		|| decision.degradationIndex < 0
		|| typeof decision.configDigest !== "string"
		|| !/^[a-f0-9]{64}$/i.test(decision.configDigest)
		|| (decision.availableModelsDigest !== undefined && !/^[a-f0-9]{64}$/i.test(decision.availableModelsDigest))
		|| (decision.requiredInputModalities !== undefined && (
			!Array.isArray(decision.requiredInputModalities)
			|| decision.requiredInputModalities.length === 0
			|| decision.requiredInputModalities.some((value) => !["text", "image"].includes(value))
			|| new Set(decision.requiredInputModalities).size !== decision.requiredInputModalities.length
		))
		|| typeof decision.reason !== "string"
		|| !decision.reason
		|| !Number.isFinite(Date.parse(decision.createdAt))
		|| !Number.isFinite(Date.parse(decision.sealedAt))
		|| decision.seal?.algorithm !== "sha256"
		|| !/^[a-f0-9]{64}$/i.test(decision.seal.digest)
	) throw new Error("RoutingDecision contains invalid fields.");
	if (decision.fallbackLevel === "L3") {
		if (decision.selectedModel !== undefined || decision.candidateIndex !== undefined) throw new Error("L3 RoutingDecision must not select a model.");
	} else {
		if (
			typeof decision.selectedModel !== "string"
			|| !decision.selectedModel
			|| !Number.isInteger(decision.candidateIndex)
			|| decision.candidateIndex! < 0
			|| decision.candidateIndex! >= decision.eligibleCandidates.length
			|| decision.eligibleCandidates[decision.candidateIndex!]?.selectedModel !== decision.selectedModel
		) throw new Error("RoutingDecision selection does not match its eligible candidates.");
	}
	if (decision.maxAuthorizationUse && (
		decision.maxAuthorizationUse.taskBinding !== decision.taskBinding
		|| decision.maxAuthorizationUse.model !== decision.selectedModel
		|| typeof decision.maxAuthorizationUse.authorizationId !== "string"
		|| !decision.maxAuthorizationUse.authorizationId
		|| !Number.isFinite(Date.parse(decision.maxAuthorizationUse.consumedAt))
	)) throw new Error("RoutingDecision max authorization use does not match the selected model and task.");
	const { seal, ...payload } = decision;
	if (seal.digest !== digestPayload(payload)) throw new Error("RoutingDecision seal mismatch.");
	return decision;
}
