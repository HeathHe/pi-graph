import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AsyncTerminal } from "../lifecycle.ts";
import { modelThinkingConflict, modelWithThinking } from "../model-routing/model-execution.ts";
import type { RoutingDecision } from "../model-routing/types.ts";
import type { PlanningModelEvidence } from "./planning-gate.ts";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function exactRuntimeModel(model: unknown, thinking: unknown, label: string): string {
	if (typeof model !== "string" || !model.trim()) throw new Error(`${label} did not report a model.`);
	const normalizedThinking = typeof thinking === "string" && thinking.trim() ? thinking.trim() : undefined;
	const conflict = modelThinkingConflict(model.trim(), normalizedThinking);
	if (conflict) throw new Error(`${label} reported conflicting model/thinking provenance: ${conflict}`);
	return modelWithThinking(model.trim(), normalizedThinking);
}

export function planningChildIdentity(parent: AsyncTerminal, asyncRoot: string): { asyncId: string; asyncDir: string } {
	if (parent.state !== "complete") throw new Error(`Planning launcher ended as '${parent.state}'.`);
	const workflow = record(parent.status.workflow);
	const child = record(workflow?.value);
	const asyncId = typeof child?.runId === "string" && child.runId.trim() ? child.runId.trim() : undefined;
	if (!asyncId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(asyncId)) throw new Error("Planning launcher did not return a valid child run identity.");
	const expected = resolve(asyncRoot, asyncId);
	const artifactPaths = Array.isArray(child?.artifactPaths) ? child.artifactPaths.filter((value): value is string => typeof value === "string") : [];
	const asyncDir = artifactPaths.map((path) => resolve(path)).find((path) => path === expected);
	if (!asyncDir || !within(resolve(asyncRoot), asyncDir)) throw new Error("Planning launcher did not return the exact public async run directory.");
	return { asyncId, asyncDir };
}

export function planningEvidenceFromAsyncTerminal(input: {
	terminal: AsyncTerminal;
	decision: RoutingDecision;
	expectedAgent: string;
	expectedLaunchContractDigest: string;
}): { evidence: PlanningModelEvidence; output: string } {
	const { terminal, decision } = input;
	if (terminal.state !== "complete") throw new Error(`Planning child ended as '${terminal.state}'.`);
	if (!decision.selectedModel) throw new Error("Planning decision has no selected model.");
	const steps = Array.isArray(terminal.status.steps) ? terminal.status.steps.map(record).filter((value): value is JsonRecord => Boolean(value)) : [];
	if (steps.length !== 1) throw new Error("Planning child status must contain exactly one runtime step.");
	const step = steps[0]!;
	if (step.agent !== input.expectedAgent || !["complete", "completed"].includes(String(step.status))) throw new Error("Planning child status does not match the authorized Agent and completed state.");
	if (step.launchContractDigest !== input.expectedLaunchContractDigest) throw new Error("Planning child launch contract differs from the sealed preflight contract.");
	const resolvedModel = exactRuntimeModel(step.model, step.thinking, "Planning child");
	if (resolvedModel !== decision.selectedModel) throw new Error("Planning child resolved model differs from the sealed routing decision.");

	const declaredAttempts = Array.isArray(step.attemptedModels) ? step.attemptedModels : [];
	const modelAttempts = Array.isArray(step.modelAttempts) ? step.modelAttempts.map(record).filter((value): value is JsonRecord => Boolean(value)) : [];
	if (declaredAttempts.length === 0 || modelAttempts.length === 0) throw new Error("Planning child did not persist complete attempted-model provenance.");
	const attemptedModels = [
		...declaredAttempts.map((model) => exactRuntimeModel(model, step.thinking, "Planning attemptedModels")),
		...modelAttempts.map((attempt) => exactRuntimeModel(attempt.model, step.thinking, "Planning modelAttempts")),
	];
	if (attemptedModels.some((model) => model !== decision.selectedModel)) throw new Error("Planning child attempted a model other than the exact authorized model.");
	if (!terminal.output.trim()) throw new Error("Planning child completed without usable output.");
	return {
		output: terminal.output.trim(),
		evidence: {
			decisionId: decision.decisionId,
			resolvedModel,
			attemptedModels,
			modelFamily: decision.modelFamily ?? "",
			providerDomain: decision.providerDomain ?? "",
		},
	};
}
