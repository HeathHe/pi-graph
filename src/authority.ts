import { createHash } from "node:crypto";
import type { CompiledGraph, GraphSnapshot, ValidationResult } from "./types.ts";

export interface AuthorizationRecord {
	schemaVersion: 2;
	compilerProjectionVersion: 1;
	runInstanceId: string;
	graphId: string;
	graphDigest: string;
	graph: CompiledGraph;
	sourceCwd: string;
	sessionId?: string;
	supervisorEpoch: string;
	createdAt: string;
}

export interface AttemptRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	phase: "prepared" | "dispatching" | "running" | "collecting" | "validated" | "applying" | "accepted" | "terminal";
	supervisorEpoch: string;
	fencingGeneration: number;
	requestDigest?: string;
	asyncId?: string;
	sessionId?: string;
	terminalStatus?: "failed" | "stale" | "stopped";
	terminalError?: string;
	terminalRetryKind?: "dispatch" | "timeout" | "failed" | "validation" | "provider";
	updatedAt: string;
}

export interface AttemptRecoveryRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	fromStatus: "stale";
	toStatus: "running" | "verifying";
	preparedAt: string;
}

export interface WorkspaceRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	workspaceKind: "shadow" | "git";
	contractDigest: string;
	writeBaseline: Record<string, string | null>;
	readBaseline: Record<string, string | null>;
	inputBaseline: Record<string, { sourcePath: string; digest: string | null }>;
	createdAt: string;
}

export interface ValidatedResultRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	outputDigest: string;
	validation: ValidationResult[];
	validatedAt: string;
}

export interface AcceptanceRecord {
	schemaVersion: 2;
	runInstanceId: string;
	graphId: string;
	taskId: string;
	attempt: number;
	attemptNonce: string;
	manifestDigest: string;
	outputDigest: string;
	acceptedAt: string;
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function authorizationFor(graph: CompiledGraph, snapshot: GraphSnapshot): AuthorizationRecord {
	if (snapshot.schemaVersion !== 2) throw new Error("Authority records require a Graph Runtime v2 snapshot.");
	return {
		schemaVersion: 2,
		compilerProjectionVersion: 1,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		graphDigest: canonicalDigest(graph),
		graph,
		sourceCwd: snapshot.sourceCwd,
		...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
		supervisorEpoch: snapshot.supervisorEpoch,
		createdAt: snapshot.createdAt,
	};
}
