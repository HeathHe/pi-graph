/**
 * Source-side runtime port for one Fabric-routed teammate attempt.
 *
 * Flow owns the Gateway and route adapter, while Teammate owns execution. This
 * runtime-registered seam keeps that dependency one-way: Flow imports this
 * public contract and Teammate never imports Flow.
 */
import type { AttemptOutcome, BackendCapabilities, BackendRun } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { AgentTerminalStatus, SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { FabricBackendRouteResolver, FabricBackendRouteResolverAcquireRequest, FabricBackendRouteResolverAcquirer } from "pi-maestro-backends/fabric";
/** One already-authorized, device-local attempt. */
export interface FabricTeammateAttemptRequest {
    readonly placement: TeammatePlacementV1;
    /**
     * Source-local backend spec. `placement`, the origin Fabric backend selector,
     * origin cwd, and origin Todo ids must already have been removed.
     */
    readonly spec: TeammateRunSpec;
    readonly correlationId: string;
    /** Trusted source-local workspace path; it never comes from the wire. */
    readonly baseCwd: string;
    readonly signal: AbortSignal;
    readonly onChildEvent?: (event: Record<string, unknown>) => void;
    readonly onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
}
/** A live source attempt plus the exact backend admission that accepted it. */
export interface FabricTeammateAttempt extends BackendRun {
    readonly acceptedBackend: string;
    readonly acceptedModel?: string;
    readonly acceptedCapabilities: BackendCapabilities;
    readonly outcome: Promise<AttemptOutcome>;
}
export interface TeammateSourceBackendAvailability {
    readonly name: string;
    /** Capabilities evaluated from this exact, loadable backend registration. */
    readonly capabilities: BackendCapabilities;
}
/** Package-neutral positive facts about executable teammate sources. */
export interface TeammateSourceAvailability {
    readonly roles: readonly string[];
    readonly taskTypes: readonly string[];
    readonly models: readonly string[];
    readonly backends: readonly TeammateSourceBackendAvailability[];
}
export interface TeammateSourceAvailabilityRequest {
    /** Workspace whose role, routing, model, and backend authorities are queried. */
    readonly cwd: string;
}
/**
 * Executes exactly one source attempt.
 *
 * Implementations must resolve only after the selected local backend has
 * acknowledged start. They must not perform model fallback, create a DAG, or
 * publish a canonical completion; those remain origin-host responsibilities.
 */
export interface FabricTeammateRuntimePort {
    startAttempt(request: FabricTeammateAttemptRequest): Promise<FabricTeammateAttempt>;
    /**
     * Return only source-local capabilities that are presently proven executable.
     * Absence means the runtime cannot prove a complete source projection.
     */
    getSourceAvailability?(request: TeammateSourceAvailabilityRequest): Promise<TeammateSourceAvailability | undefined>;
}
export interface FabricTeammateRuntimePortOptions {
    /** Test/embedder override; production resolves the source workspace registry. */
    readonly backendRegistry?: BackendRegistry;
}
/**
 * Create the production source-side runtime.
 *
 * Each call resolves and starts exactly one source-local backend attempt. It
 * never enters the teammate orchestration loop, so it cannot retry another
 * model, publish an agent:// result, or recursively place through Fabric.
 */
export declare function createFabricTeammateRuntimePort(options?: FabricTeammateRuntimePortOptions): FabricTeammateRuntimePort;
export interface FabricTeammateRuntimeRegistration {
    readonly port: FabricTeammateRuntimePort;
    dispose(): void;
}
/** Install the source runtime used by Flow Agent Endpoint bridges in this process. */
export declare function registerFabricTeammateRuntimePort(port: FabricTeammateRuntimePort): FabricTeammateRuntimeRegistration;
/** Return the currently registered source runtime, if this host installed one. */
export declare function getFabricTeammateRuntimePort(): FabricTeammateRuntimePort | undefined;
/** Legacy process-scoped provider retained for existing Flow embedders. */
export type FabricRouteResolverProvider = () => FabricBackendRouteResolver | undefined;
/** Generation and owner identity supplied to every managed acquisition. */
export interface FabricRouteResolverProviderAcquireRequest extends FabricBackendRouteResolverAcquireRequest {
    readonly generation: number;
    readonly ownerId: string;
}
/** Provider-owned resource returned for one placed dispatch. */
export interface FabricRouteResolverProviderLease {
    readonly resolver: FabricBackendRouteResolver;
    release(): void | Promise<void>;
}
/** New providers can allocate and release dispatch-scoped resolver resources. */
export interface GenerationTrackedFabricRouteResolverProvider {
    acquire(request: FabricRouteResolverProviderAcquireRequest, signal: AbortSignal): FabricRouteResolverProviderLease | undefined | Promise<FabricRouteResolverProviderLease | undefined>;
}
export type FabricRouteResolverProviderInput = FabricRouteResolverProvider | GenerationTrackedFabricRouteResolverProvider;
export interface FabricRouteResolverProviderRegistrationOptions {
    /** Stable identity of the owning host lifecycle; generated when omitted. */
    readonly ownerId?: string;
}
/** Callable for legacy disposal, with explicit generation ownership metadata. */
export interface FabricRouteResolverProviderRegistration {
    (): void;
    readonly provider: FabricRouteResolverProviderInput;
    readonly generation: number;
    readonly ownerId: string;
    dispose(): void;
}
/** A dispatch capture that acquires from exactly one registered generation. */
export interface FabricRouteResolverProviderBinding extends FabricBackendRouteResolverAcquirer {
    readonly generation: number;
    readonly ownerId: string;
}
/**
 * Install one origin route resolver provider lifecycle.
 *
 * A live owner is never overwritten. Disposal is generation-fenced and
 * idempotent, so a stale disposer cannot remove a subsequently registered
 * owner.
 */
export declare function registerFabricRouteResolverProvider(provider: FabricRouteResolverProviderInput, options?: FabricRouteResolverProviderRegistrationOptions): FabricRouteResolverProviderRegistration;
/** Return an installed legacy provider; managed hosts use the binding API below. */
export declare function getFabricRouteResolverProvider(): FabricRouteResolverProvider | undefined;
/** Capture the current provider generation for one dispatch. */
export declare function getFabricRouteResolverProviderBinding(): FabricRouteResolverProviderBinding | undefined;
