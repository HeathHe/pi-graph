import { randomUUID } from "node:crypto";
import type {
	SettingsActivationPlan,
	SettingsApplyRuntimeResultV1,
	SettingsChange,
	SettingsCommitResultV1,
	SettingsContextV1,
	SettingsPrepareResultV1,
	SettingsResourceConflict,
	SettingsSnapshot,
	SettingsValidationIssue,
	SettingsValidationResult,
} from "./public/v1/index.ts";
import type { RegisteredSettingsProvider, SettingsProviderRegistry } from "./registry.ts";

export type SettingsApplyStatus =
	| "noop"
	| "validation-failed"
	| "conflict"
	| "prepare-failed"
	| "commit-failed"
	| "committed";

export interface SettingsProviderFailure {
	providerId: string;
	stage: "read" | "validate" | "prepare" | "commit" | "abort" | "rollback" | "runtime";
	message: string;
}

export interface SettingsApplyOutcome {
	status: SettingsApplyStatus;
	transactionId?: string;
	issues: readonly SettingsValidationIssue[];
	conflicts: readonly SettingsResourceConflict[];
	failures: readonly SettingsProviderFailure[];
	activation: readonly SettingsActivationPlan[];
	runtime: Readonly<Record<string, SettingsApplyRuntimeResultV1>>;
}

interface ProviderBaseline {
	instanceId: string;
	snapshot: SettingsSnapshot;
	registration: RegisteredSettingsProvider;
	registryGeneration: number;
	loadGeneration: number;
	contextKey: string;
}

interface PreparedProvider {
	registration: RegisteredSettingsProvider;
	changes: readonly SettingsChange[];
	result: SettingsPrepareResultV1;
}

interface CommittedProvider {
	prepared: PreparedProvider;
	result: SettingsCommitResultV1;
	previousBaseline: ProviderBaseline;
}

interface CapturedEdit {
	change: SettingsChange;
	revision: number;
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object" && !seen.has(value)) {
		seen.add(value);
		for (const child of Object.values(value)) freezeValue(child, seen);
		Object.freeze(value);
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function draftKey(change: SettingsChange): string {
	return `${change.scope}\u0000${change.key}`;
}

function contextKey(context: SettingsContextV1): string {
	return JSON.stringify([context.cwd, context.locale, context.sessionId ?? null, context.sessionGeneration ?? null, context.projectTrusted ?? null]);
}

export class SettingsCoordinator {
	private readonly baselines = new Map<string, ProviderBaseline>();
	private readonly drafts = new Map<string, Map<string, SettingsChange>>();
	private readonly editRevisions = new Map<string, Map<string, number>>();
	private nextEditRevision = 0;
	private applying = false;
	private activeLoads = 0;
	private loadGeneration = 0;

	constructor(private readonly registry: SettingsProviderRegistry) {}

	async load(context: SettingsContextV1): Promise<SettingsProviderFailure[]> {
		if (this.applying) return [{ providerId: "settings-coordinator", stage: "read", message: "settings apply is in progress; retry loading after it settles" }];
		const generation = ++this.loadGeneration;
		const registryGeneration = this.registry.generation;
		const loadedContext = freezeValue(structuredClone(context));
		this.activeLoads++;
		const failures: SettingsProviderFailure[] = [];
		const baselines = new Map<string, ProviderBaseline>();
		try {
		await Promise.all(this.registry.list().map(async (registration) => {
			try {
				const snapshot = await registration.provider.read({ context: loadedContext });
				if (this.registry.get(registration.providerId) !== registration) {
					failures.push({ providerId: registration.providerId, stage: "read", message: "settings provider changed during load; reload before saving" });
					return;
				}
				baselines.set(registration.providerId, {
					instanceId: registration.instanceId,
					snapshot,
					registration,
					registryGeneration,
					loadGeneration: generation,
					contextKey: contextKey(loadedContext),
				});
			} catch (error) {
				failures.push({ providerId: registration.providerId, stage: "read", message: errorMessage(error) });
			}
		}));
		if (generation !== this.loadGeneration || registryGeneration !== this.registry.generation) {
			return [{ providerId: "settings-coordinator", stage: "read", message: "settings load was superseded; reload the current context" }];
		}
		this.baselines.clear();
		for (const [providerId, baseline] of baselines) {
			if (this.registry.get(providerId) === baseline.registration) this.baselines.set(providerId, baseline);
		}
		return failures;
		} finally { this.activeLoads--; }
	}

	baseline(providerId: string): SettingsSnapshot | undefined {
		const baseline = this.baselines.get(providerId);
		return baseline && baseline.registryGeneration === this.registry.generation
			&& baseline.loadGeneration === this.loadGeneration
			&& this.registry.get(providerId) === baseline.registration ? baseline.snapshot : undefined;
	}

	setChange(providerId: string, change: SettingsChange): void {
		const providerDraft = this.drafts.get(providerId) ?? new Map<string, SettingsChange>();
		providerDraft.set(draftKey(change), structuredClone(change));
		this.drafts.set(providerId, providerDraft);
		const versions = this.editRevisions.get(providerId) ?? new Map<string, number>();
		versions.set(draftKey(change), ++this.nextEditRevision);
		this.editRevisions.set(providerId, versions);
	}

	changes(providerId?: string): SettingsChange[] {
		if (providerId !== undefined) return structuredClone([...(this.drafts.get(providerId)?.values() ?? [])]);
		return structuredClone([...this.drafts.values()].flatMap((draft) => [...draft.values()]));
	}

	modifiedProviderIds(): string[] {
		return [...this.drafts.entries()]
			.filter(([, changes]) => changes.size > 0)
			.map(([providerId]) => providerId)
			.sort();
	}

	discard(providerId?: string): void {
		if (providerId === undefined) { this.drafts.clear(); this.editRevisions.clear(); }
		else { this.drafts.delete(providerId); this.editRevisions.delete(providerId); }
	}

	async apply(context: SettingsContextV1): Promise<SettingsApplyOutcome> {
		if (this.applying || this.activeLoads > 0) {
			return outcome("validation-failed", undefined, [], [], [{ providerId: "settings-coordinator", stage: "validate", message: "settings apply or load is in progress; retry after it settles" }], [], {});
		}
		this.applying = true;
		const captured = new Map<string, readonly CapturedEdit[]>();
		try {
			for (const providerId of this.modifiedProviderIds()) captured.set(providerId, [...this.drafts.get(providerId)!.entries()].map(([key, change]) => ({
				change: freezeValue(structuredClone(change)), revision: this.editRevisions.get(providerId)!.get(key)!,
			})));
			return await this.applyCaptured(freezeValue(structuredClone(context)), captured);
		} finally { this.applying = false; }
	}

	private async applyCaptured(context: SettingsContextV1, captured: ReadonlyMap<string, readonly CapturedEdit[]>): Promise<SettingsApplyOutcome> {
		const providerIds = [...captured.keys()];
		if (providerIds.length === 0) return emptyOutcome("noop");
		const transactionId = randomUUID();
		const registryGeneration = this.registry.generation, loadGeneration = this.loadGeneration;
		const registrations: Array<{ registration: RegisteredSettingsProvider; changes: readonly SettingsChange[]; baseline: ProviderBaseline }> = [];
		const failures: SettingsProviderFailure[] = [];
		for (const providerId of providerIds) {
			const registration = this.registry.get(providerId), baseline = this.baselines.get(providerId);
			if (!registration || !baseline || baseline.registration !== registration
				|| baseline.registryGeneration !== registryGeneration || baseline.loadGeneration !== loadGeneration
				|| baseline.contextKey !== contextKey(context)) {
				failures.push({ providerId, stage: "validate", message: "settings provider changed or loaded context changed; reload before saving" });
				continue;
			}
			registrations.push({ registration, baseline, changes: Object.freeze(captured.get(providerId)!.map(edit => edit.change)) });
		}
		if (failures.length > 0) return outcome("validation-failed", transactionId, [], [], failures, [], {});
		const isCurrent = (): boolean => this.registry.generation === registryGeneration && this.loadGeneration === loadGeneration
			&& registrations.every(({ registration }) => this.registry.get(registration.providerId) === registration);
		const checkCurrent = (stage: string): void => { if (!isCurrent()) throw new Error(`settings context/provider lifetime changed during ${stage}; reload and reconcile before saving`); };

		const validations = await Promise.all(registrations.map(async ({ registration, changes, baseline }) => {
			try {
				checkCurrent("validation");
				const validation = await registration.provider.validate({ context, transactionId, changes, expectedRevisions: baseline.snapshot.configured.resources });
				checkCurrent("validation");
				return validation;
			} catch (error) {
				failures.push({ providerId: registration.providerId, stage: "validate", message: errorMessage(error) });
				return undefined;
			}
		}));
		const validationIssues = validations.flatMap(value => value?.issues ?? []), validationConflicts = validations.flatMap(value => value?.conflicts ?? []);
		if (!isCurrent() && failures.length === 0) failures.push({ providerId: "settings-coordinator", stage: "validate", message: "settings context changed after validation; reload before saving" });
		if (validationConflicts.length > 0) return outcome("conflict", transactionId, validationIssues, validationConflicts, failures, [], {});
		if (failures.length > 0 || validations.some(value => value?.valid !== true)) return outcome("validation-failed", transactionId, validationIssues, [], failures, [], {});

		const prepared: PreparedProvider[] = [];
		for (const { registration, changes, baseline } of registrations) {
			try {
				checkCurrent("prepare");
				if (!registration.provider.prepare || !registration.provider.commit) throw new Error("provider is read-only");
				const result = await registration.provider.prepare({ context, transactionId, changes, expectedRevisions: baseline.snapshot.configured.resources });
				// Record returned owned tokens before detecting drift so they can be
				// aborted on the original provider, never on its replacement.
				if (result.prepared && result.prepareToken) prepared.push({ registration, changes, result });
				checkCurrent("prepare");
				if (!result.prepared || !result.prepareToken || !result.validation.valid) {
					const conflicts = result.conflicts ?? result.validation.conflicts ?? [];
					await this.abortPrepared(context, transactionId, prepared, failures, "prepare rejected");
					return outcome(conflicts.length > 0 ? "conflict" : "prepare-failed", transactionId, result.validation.issues, conflicts, failures, result.activation ?? [], {});
				}
			} catch (error) { failures.push({ providerId: registration.providerId, stage: "prepare", message: errorMessage(error) }); break; }
		}
		if (failures.length > 0) {
			await this.abortPrepared(context, transactionId, prepared, failures, "prepare failed");
			return outcome("prepare-failed", transactionId, [], [], failures, [], {});
		}

		const committed: CommittedProvider[] = [], activation: SettingsActivationPlan[] = [];
		const settleCommitFailure = async (providerId: string, error: unknown): Promise<SettingsApplyOutcome> => {
			const fact = committed.length > 0
				? `${committed.length} successful commit receipt(s) observed: physical writes occurred; original-provider compensation will be attempted. Earlier changed notifications, if any, cannot be retracted.`
				: "No successful commit receipt was returned; any unconfirmed write requires verification.";
			failures.push({ providerId, stage: "commit", message: `${errorMessage(error)}. ${fact}` });
			await this.rollbackCommitted(context, transactionId, committed, failures, isCurrent);
			await this.abortPrepared(context, transactionId, prepared.slice(committed.length), failures, "commit failed or context changed");
			return outcome("commit-failed", transactionId, [], [], failures, activation, {});
		};
		for (const entry of prepared) {
			try {
				checkCurrent("commit");
				const previousBaseline = registrations.find(value => value.registration === entry.registration)!.baseline;
				const result = await entry.registration.provider.commit!({ context, transactionId, prepareToken: entry.result.prepareToken! });
				// A successful receipt is a physical-write fact even when the
				// registry lifetime changed while the commit was in flight.
				committed.push({ prepared: entry, result, previousBaseline });
				activation.push(...result.activation);
				checkCurrent("commit");
			} catch (error) { return settleCommitFailure(entry.registration.providerId, error); }
		}

		for (const entry of committed) {
			const { registration } = entry.prepared;
			try {
				checkCurrent("publication");
				this.baselines.set(registration.providerId, { ...entry.previousBaseline, snapshot: entry.result.snapshot });
				this.registry.emitChanged({ providerId: registration.providerId, providerInstanceId: registration.instanceId, transactionId, changedKeys: entry.result.changedKeys, snapshot: entry.result.snapshot, revisions: entry.result.revisions, activation: entry.result.activation });
				checkCurrent("publication");
			} catch (error) { return settleCommitFailure(registration.providerId, error); }
		}

		const runtime: Record<string, SettingsApplyRuntimeResultV1> = {}, runtimeStarted: string[] = [];
		const unresolvedRuntime = (providerId: string): SettingsApplyOutcome => {
			failures.push({ providerId, stage: "runtime", message: `settings context changed after runtime started for ${runtimeStarted.join(", ")}; ${committed.length} physical commits were observed. Recorded runtime results remain facts; no automatic rollback of runtime effects was attempted. Manual verification is required.` });
			return outcome("commit-failed", transactionId, [], [], failures, activation, runtime);
		};
		for (const entry of committed) {
			const { registration, changes } = entry.prepared;
			if (!isCurrent()) return runtimeStarted.length > 0 ? unresolvedRuntime(registration.providerId) : settleCommitFailure(registration.providerId, "settings context changed before runtime");
			if (registration.provider.applyRuntime) {
				runtimeStarted.push(registration.providerId);
				try {
					runtime[registration.providerId] = await registration.provider.applyRuntime({ context, transactionId, changes, snapshot: entry.result.snapshot });
				} catch (error) { failures.push({ providerId: registration.providerId, stage: "runtime", message: errorMessage(error) }); }
				if (!isCurrent()) return unresolvedRuntime(registration.providerId);
			}
		}
		// No draft is acknowledged until all awaited runtime work has settled
		// in the same lifetime. Later edits still use their independent revision.
		for (const entry of committed) {
			const providerId = entry.prepared.registration.providerId;
			if (!isCurrent()) return runtimeStarted.length > 0 ? unresolvedRuntime(providerId) : settleCommitFailure(providerId, "settings context changed before draft acknowledgement");
			const draft = this.drafts.get(providerId), revisions = this.editRevisions.get(providerId);
			for (const edit of captured.get(providerId)!) {
				const key = draftKey(edit.change);
				if (entry.result.changedKeys.includes(edit.change.key) && revisions?.get(key) === edit.revision) { draft?.delete(key); revisions.delete(key); }
			}
			if (draft?.size === 0) { this.drafts.delete(providerId); this.editRevisions.delete(providerId); }
		}
		return outcome("committed", transactionId, [], [], failures, activation, runtime);
	}

	private async abortPrepared(
		context: SettingsContextV1,
		transactionId: string,
		prepared: readonly PreparedProvider[],
		failures: SettingsProviderFailure[],
		reason: string,
	): Promise<void> {
		for (const entry of [...prepared].reverse()) {
			if (!entry.registration.provider.abort || !entry.result.prepareToken) continue;
			try {
				await entry.registration.provider.abort({ context, transactionId, prepareToken: entry.result.prepareToken, reason });
			} catch (error) {
				failures.push({ providerId: entry.registration.providerId, stage: "abort", message: errorMessage(error) });
			}
		}
	}

	private async rollbackCommitted(
		context: SettingsContextV1,
		transactionId: string,
		committed: readonly CommittedProvider[],
		failures: SettingsProviderFailure[],
		isCurrent: () => boolean,
	): Promise<void> {
		for (const entry of [...committed].reverse()) {
			const { registration, result, prepareToken } = {
				registration: entry.prepared.registration,
				result: entry.result,
				prepareToken: entry.prepared.result.prepareToken,
			};
			if (!registration.provider.rollback || !prepareToken) {
				failures.push({ providerId: registration.providerId, stage: "rollback", message: "provider cannot roll back an observed committed write; physical state is unresolved and requires verification" });
				continue;
			}
			try {
				const rollback = await registration.provider.rollback({
					context,
					transactionId,
					prepareToken,
					committedRevisions: result.revisions,
				});
				// Compensation belongs to the original provider. Its old snapshot
				// must not be installed into a replacement discovery/context.
				if (isCurrent()) this.baselines.set(registration.providerId, rollback.snapshot
					? { ...entry.previousBaseline, snapshot: rollback.snapshot }
					: entry.previousBaseline);
				if (!rollback.rolledBack) {
					failures.push({ providerId: registration.providerId, stage: "rollback", message: "provider reported an incomplete rollback; physical state requires verification" });
				}
			} catch (error) {
				failures.push({ providerId: registration.providerId, stage: "rollback", message: errorMessage(error) });
			}
		}
	}
}

function emptyOutcome(status: SettingsApplyStatus): SettingsApplyOutcome {
	return outcome(status, undefined, [], [], [], [], {});
}

function outcome(
	status: SettingsApplyStatus,
	transactionId: string | undefined,
	issues: readonly SettingsValidationIssue[],
	conflicts: readonly SettingsResourceConflict[],
	failures: readonly SettingsProviderFailure[],
	activation: readonly SettingsActivationPlan[],
	runtime: Readonly<Record<string, SettingsApplyRuntimeResultV1>>,
): SettingsApplyOutcome {
	return { status, transactionId, issues, conflicts, failures, activation, runtime };
}
