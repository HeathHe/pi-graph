import { createHash, verify } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MaxAuthorization, MaxAuthorizationStore, MaxAuthorizationUse, RoutingObservation } from "./types.ts";

function validIso(value: string): boolean {
	return Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

export function validateMaxAuthorization(
	authorization: MaxAuthorization | undefined,
	input: { taskBinding: string; model: string; now?: Date; trustedIssuers?: Record<string, Record<string, string>> },
): MaxAuthorization {
	if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) throw new Error("max requires a structured authorization.");
	const now = input.now ?? new Date();
	if (
		typeof authorization.authorizationId !== "string"
		|| !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(authorization.authorizationId)
		|| authorization.taskBinding !== input.taskBinding
		|| typeof authorization.issuer !== "string"
		|| !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(authorization.issuer)
		|| typeof authorization.keyId !== "string"
		|| !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(authorization.keyId)
		|| authorization.model !== input.model
		|| authorization.thinking !== "max"
		|| authorization.singleUse !== true
		|| typeof authorization.signature !== "string"
		|| !/^[A-Za-z0-9_-]{40,512}$/.test(authorization.signature)
		|| typeof authorization.nonce !== "string"
		|| !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(authorization.nonce)
		|| !validIso(authorization.issuedAt)
		|| !validIso(authorization.expiresAt)
		|| Date.parse(authorization.issuedAt) > now.getTime()
		|| Date.parse(authorization.expiresAt) <= now.getTime()
		|| Date.parse(authorization.expiresAt) <= Date.parse(authorization.issuedAt)
	) throw new Error("max authorization is invalid, expired, or not bound to this task and model.");
	if (input.trustedIssuers) {
		const publicKey = input.trustedIssuers[authorization.issuer]?.[authorization.keyId];
		if (!publicKey) throw new Error("max authorization issuer or key is not trusted by the routing policy.");
		let valid = false;
		try {
			valid = verify(null, Buffer.from(maxAuthorizationPayload(authorization)), publicKey, Buffer.from(authorization.signature, "base64url"));
		} catch {
			valid = false;
		}
		if (!valid) throw new Error("max authorization signature is invalid.");
	}
	return authorization;
}

export function maxAuthorizationPayload(authorization: Omit<MaxAuthorization, "signature"> | MaxAuthorization): string {
	return JSON.stringify({
		authorizationId: authorization.authorizationId,
		issuer: authorization.issuer,
		keyId: authorization.keyId,
		taskBinding: authorization.taskBinding,
		model: authorization.model,
		thinking: authorization.thinking,
		issuedAt: authorization.issuedAt,
		expiresAt: authorization.expiresAt,
		nonce: authorization.nonce,
		singleUse: authorization.singleUse,
	});
}

export class InMemoryMaxAuthorizationStore implements MaxAuthorizationStore {
	private readonly uses = new Map<string, MaxAuthorizationUse>();

	consume(authorization: MaxAuthorization, input: { taskBinding: string; model: string; now?: Date }): MaxAuthorizationUse {
		validateMaxAuthorization(authorization, input);
		const existing = this.uses.get(authorization.authorizationId);
		if (existing) {
			if (existing.taskBinding !== input.taskBinding || existing.model !== input.model) {
				throw new Error("max authorization has already been consumed by a different task or model.");
			}
			// A task-scoped authorization is consumed once, but retries and crash recovery
			// for that same task/model must observe the original use idempotently.
			return existing;
		}
		const use: MaxAuthorizationUse = {
			authorizationId: authorization.authorizationId,
			taskBinding: input.taskBinding,
			model: input.model,
			consumedAt: (input.now ?? new Date()).toISOString(),
		};
		this.uses.set(authorization.authorizationId, use);
		return use;
	}

	get(authorizationId: string): MaxAuthorizationUse | undefined {
		return this.uses.get(authorizationId);
	}

	clear(): void {
		this.uses.clear();
	}
}

export class DurableMaxAuthorizationStore implements MaxAuthorizationStore {
	private readonly root: string;
	constructor(root = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "model-routing", "max-authorization-uses")) {
		this.root = resolve(root);
	}

	consume(authorization: MaxAuthorization, input: { taskBinding: string; model: string; now?: Date }): MaxAuthorizationUse {
		validateMaxAuthorization(authorization, input);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const rootInfo = lstatSync(this.root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("max authorization ledger root must be a real directory.");
		const token = createHash("sha256").update(authorization.authorizationId).digest("hex");
		const path = join(this.root, `${token}.json`);
		const use: MaxAuthorizationUse = { authorizationId: authorization.authorizationId, taskBinding: input.taskBinding, model: input.model, consumedAt: (input.now ?? new Date()).toISOString() };
		let descriptor: number | undefined;
		try {
			descriptor = openSync(path, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify(use)}\n`, "utf8");
			fsyncSync(descriptor);
			return use;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("max authorization ledger entry is not a regular file.");
			const existing = JSON.parse(readFileSync(path, "utf8")) as MaxAuthorizationUse;
			if (existing.authorizationId !== authorization.authorizationId || existing.taskBinding !== input.taskBinding || existing.model !== input.model || !validIso(existing.consumedAt)) throw new Error("max authorization has already been consumed by a different task or model, or its ledger is invalid.");
			return existing;
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}
}

export const defaultMaxAuthorizationStore = new DurableMaxAuthorizationStore();

const observations: RoutingObservation[] = [];
const MAX_OBSERVATIONS = 500;

export function recordRoutingObservation(observation: RoutingObservation): void {
	observations.push(structuredClone(observation));
	if (observations.length > MAX_OBSERVATIONS) observations.splice(0, observations.length - MAX_OBSERVATIONS);
}

export function routingObservations(): RoutingObservation[] {
	return structuredClone(observations);
}

export function clearRoutingObservations(): void {
	observations.length = 0;
}
