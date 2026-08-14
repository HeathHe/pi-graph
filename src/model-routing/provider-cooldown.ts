export interface ProviderRetryDelayInput {
	attempt: number;
	baseMs?: number;
	maximumMs?: number;
	retryAfterMs?: number;
	random?: () => number;
}

export function providerRetryDelay(input: ProviderRetryDelayInput): number {
	const baseMs = Math.max(0, input.baseMs ?? 5_000);
	const maximumMs = Math.max(baseMs, input.maximumMs ?? 300_000);
	const cap = Math.min(maximumMs, baseMs * (2 ** Math.max(0, input.attempt - 1)));
	const random = Math.min(0.999999999, Math.max(0, (input.random ?? Math.random)()));
	const jitter = Math.floor(random * (cap + 1));
	return Math.max(Math.max(0, input.retryAfterMs ?? 0), jitter);
}

interface CooldownState {
	until: number;
	probeOwner?: string;
}

async function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	if (signal?.aborted) throw new Error("Provider cooldown wait was cancelled.");
	await new Promise<void>((resolveWait, reject) => {
		let settled = false;
		const finish = (operation: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			operation();
		};
		const onAbort = () => finish(() => reject(new Error("Provider cooldown wait was cancelled.")));
		const timer = setTimeout(() => finish(resolveWait), ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class ProviderCooldownRegistry {
	private readonly states = new Map<string, CooldownState>();

	trip(key: string, delayMs: number, now = Date.now()): number {
		const until = now + Math.max(0, Math.ceil(delayMs));
		const prior = this.states.get(key);
		this.states.set(key, { until: Math.max(until, prior?.until ?? 0) });
		return until;
	}

	remaining(key: string, now = Date.now()): number {
		const state = this.states.get(key);
		return state ? Math.max(0, state.until - now) : 0;
	}

	async acquireAfterFailure(key: string, owner: string, signal?: AbortSignal): Promise<() => void> {
		while (true) {
			const state = this.states.get(key);
			if (!state) return () => undefined;
			const remaining = state.until - Date.now();
			if (remaining > 0) {
				await abortableWait(remaining, signal);
				continue;
			}
			if (!state.probeOwner || state.probeOwner === owner) {
				state.probeOwner = owner;
				return () => {
					const current = this.states.get(key);
					if (current?.probeOwner === owner) this.states.delete(key);
				};
			}
			await abortableWait(25, signal);
		}
	}

	clear(): void {
		this.states.clear();
	}
}

const PROVIDER_COOLDOWNS_GLOBAL = Symbol.for("pi-graph.provider-cooldowns.v1");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;
const existingProviderCooldowns = globalRegistry[PROVIDER_COOLDOWNS_GLOBAL];
export const providerCooldowns = existingProviderCooldowns
	? existingProviderCooldowns as ProviderCooldownRegistry
	: (globalRegistry[PROVIDER_COOLDOWNS_GLOBAL] = new ProviderCooldownRegistry()) as ProviderCooldownRegistry;
