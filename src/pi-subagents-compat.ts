export interface PiSubagentsRpcLike {
	call(method: "ping" | "status" | "spawn" | "interrupt" | "stop" | "resume", params?: unknown, stableRequestId?: string): Promise<unknown>;
}

export interface PiSubagentsRuntimeCapabilities {
	runtimeAvailable: boolean;
	packageVersion: string | null;
	rpcProtocol: number | null;
	ping: boolean;
	asyncSpawn: boolean;
	status: boolean;
	stop: boolean;
	resume: boolean;
	resolvedModelObservable: boolean;
	attemptedModelsObservable: boolean;
	providerFailureStructured: boolean;
	exactModelControl: boolean;
	runtimeCompatible: boolean;
	provenanceObservable: boolean;
	controlledRoutingReady: boolean;
	limitations: string[];
	/** @deprecated Use runtimeCompatible. Kept for report compatibility. */
	routingCompatible: boolean;
	issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function advertisedMethods(raw: Record<string, unknown>, capabilities: Record<string, unknown>): Set<string> | null {
	const value = raw.methods ?? raw.rpcMethods ?? capabilities.methods ?? capabilities.rpcMethods;
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
	return new Set(value);
}

function explicitCapability(capabilities: Record<string, unknown>, names: string[]): boolean | undefined {
	for (const name of names) {
		if (typeof capabilities[name] === "boolean") return capabilities[name] as boolean;
		const value = capabilities[name];
		if (isRecord(value) && positiveInteger(value.version)) return true;
	}
	return undefined;
}

export async function inspectPiSubagentsRuntime(rpc?: PiSubagentsRpcLike): Promise<PiSubagentsRuntimeCapabilities> {
	const unavailable: PiSubagentsRuntimeCapabilities = {
		runtimeAvailable: false,
		packageVersion: null,
		rpcProtocol: null,
		ping: false,
		asyncSpawn: false,
		status: false,
		stop: false,
		resume: false,
		resolvedModelObservable: false,
		attemptedModelsObservable: false,
		providerFailureStructured: false,
		exactModelControl: false,
		runtimeCompatible: false,
		provenanceObservable: false,
		controlledRoutingReady: false,
		limitations: [],
		routingCompatible: false,
		issues: ["pi-subagents public RPC ping is unavailable."],
	};
	if (!rpc) return unavailable;

	let raw: unknown;
	try {
		raw = await rpc.call("ping");
	} catch (error) {
		return {
			...unavailable,
			issues: [`pi-subagents public RPC ping failed: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	if (!isRecord(raw)) return { ...unavailable, runtimeAvailable: true, ping: true, issues: ["pi-subagents RPC ping returned a non-object payload."] };

	const protocol = positiveInteger(raw.protocolVersion) ?? positiveInteger(raw.version);
	const packageVersion = typeof raw.packageVersion === "string" ? raw.packageVersion : null;
	const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
	const methods = advertisedMethods(raw, capabilities);
	// The public RPC v1 contract guarantees these methods. If a future runtime
	// advertises an explicit method list, prefer that list instead of guessing.
	const supports = (method: string): boolean => methods ? methods.has(method) : protocol === 1;
	const asyncSpawn = supports("spawn");
	const status = supports("status");
	const stop = supports("stop");
	const resume = supports("resume");
	// RPC v1 publicly defines model/attemptedModels/modelAttempts as stable
	// lifecycle fields. Structured provider-failure classification is stricter:
	// require an explicit capability rather than inferring it from text or version.
	const resolvedModelObservable = explicitCapability(capabilities, ["resolvedModel", "modelProvenance", "resolvedModelObservable"]) ?? protocol === 1;
	const attemptedModelsObservable = explicitCapability(capabilities, ["attemptedModels", "modelAttempts", "attemptedModelsObservable"]) ?? protocol === 1;
	const providerFailureStructured = explicitCapability(capabilities, ["providerFailure", "providerFailureClassification", "providerFailureStructured"]) ?? false;
	const exactModelControl = explicitCapability(capabilities, ["exactModel", "disableFallback", "perCallFallbackControl"]) ?? false;

	const issues: string[] = [];
	const limitations: string[] = [];
	if (protocol !== 1) issues.push(`Unsupported pi-subagents RPC protocol ${protocol ?? "unknown"}; pi-graph requires public RPC v1.`);
	if (!asyncSpawn) issues.push("Async RPC spawn capability is unavailable.");
	if (!status) issues.push("RPC status capability is unavailable.");
	if (!stop) issues.push("RPC stop capability is unavailable.");
	if (!resume) issues.push("RPC resume capability is unavailable.");
	if (!resolvedModelObservable) issues.push("Resolved model provenance is not observable through the public runtime contract.");
	if (!attemptedModelsObservable) issues.push("Attempted model provenance is not observable through the public runtime contract.");
	if (!providerFailureStructured) limitations.push("Structured provider-failure classification is not advertised; automatic provider retry and model degradation remain disabled for free-form failures.");
	if (!exactModelControl) limitations.push("Per-call exact-model or fallback-disable control is not advertised; managed Agent launch contracts must be audited to contain exactly one model candidate.");
	const runtimeCompatible = protocol === 1 && asyncSpawn && status && stop && resume;
	const provenanceObservable = resolvedModelObservable && attemptedModelsObservable;
	const controlledRoutingReady = runtimeCompatible && provenanceObservable && exactModelControl;
	return {
		runtimeAvailable: true,
		packageVersion,
		rpcProtocol: protocol,
		ping: true,
		asyncSpawn,
		status,
		stop,
		resume,
		resolvedModelObservable,
		attemptedModelsObservable,
		providerFailureStructured,
		exactModelControl,
		runtimeCompatible,
		provenanceObservable,
		controlledRoutingReady,
		limitations,
		routingCompatible: runtimeCompatible,
		issues,
	};
}

export function controlledRoutingReadiness(
	runtime: PiSubagentsRuntimeCapabilities,
	managedLaunchContractsAudited: boolean,
): { ready: boolean; issues: string[] } {
	const issues = [...runtime.issues];
	if (!runtime.runtimeCompatible) issues.push("The pi-subagents public RPC runtime is incompatible.");
	if (!runtime.provenanceObservable) issues.push("Runtime model provenance is not observable.");
	if (!runtime.exactModelControl && !managedLaunchContractsAudited) {
		issues.push("Managed Agent launch contracts have not been audited to exclude fallback model candidates.");
	}
	return { ready: runtime.runtimeCompatible && runtime.provenanceObservable && (runtime.exactModelControl || managedLaunchContractsAudited), issues: [...new Set(issues)] };
}
