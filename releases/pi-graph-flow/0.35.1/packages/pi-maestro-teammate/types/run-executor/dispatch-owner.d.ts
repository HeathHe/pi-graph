import type { AgentConfig } from "../agents/agents.ts";
import type { ReplyTarget } from "../shared/routing.ts";
import type { SingleResult, AgentProgress, AgentProgressStatus, AgentTerminalStatus, AgentRunPhase, RecentToolInfo, TeammateExecutionProvenance } from "../shared/types.ts";
import type { ResolvedModelRegistrationCandidate, ResolvedModelRegistrationRouting } from "../models/model-routing.ts";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import type { ModelRuntimeDescriptor } from "../models/model-registry.ts";
import type { ModelRegistryDispatchContext, NormalizedTask, RemoteLocationRouting, RunSingleTeammateParams, RunTeammateOptions, RunTeammateParams } from "../runs/execution-infra.ts";
import type { AttemptOutcome, BackendCapabilities, BackendRun, BackendRunOptions, ConfigValue } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry, ResolvedBackend } from "pi-maestro-backend-core/v1/registry";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { ExecutionPorts } from "./lifecycle-contracts.ts";
export interface ModelRegistryRunBinding {
    hostOptions: RunTeammateOptions;
    cwd: string;
    replyTo: ReplyTarget;
}
export interface MutableModelRegistryDispatchContext extends ModelRegistryDispatchContext {
    readonly plansByCorrelationId: Map<string, ResolvedModelRegistrationRouting>;
    readonly resolutionsByCorrelationId: Map<string, Map<string, ResolvedBackend>>;
}
export interface PreparedBackendAttempt {
    readonly backendName: string;
    readonly config: Record<string, ConfigValue>;
    readonly capabilities: BackendCapabilities;
    start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun>;
}
export interface FabricSourceRuntimeOptions {
    readonly backendRegistry?: BackendRegistry;
}
declare function createDispatchContext(ports: ExecutionPorts): {
    providerOf: (model: string) => string | undefined;
    modelRegistryRunBindings: WeakMap<ModelRegistryDispatchContext, Map<string, ModelRegistryRunBinding>>;
    hostRegistryProvenanceResults: WeakMap<SingleResult, TeammateExecutionProvenance>;
    hostRegistryResultProvenance: (result: SingleResult) => TeammateExecutionProvenance | undefined;
    captureModelRegistryAuthority: (options: RunTeammateOptions) => ModelRegistryDispatchContext["authority"] | undefined;
    createModelRegistryDispatchContext: (authority: ModelRegistryDispatchContext["authority"], options: RunTeammateOptions) => MutableModelRegistryDispatchContext;
    modelRegistrationPlan: (authority: ModelRegistryDispatchContext["authority"], params: Pick<RunSingleTeammateParams, "model" | "fallbackModels" | "backend" | "cwd">, agentConfig?: AgentConfig) => ResolvedModelRegistrationRouting;
    isRemoteModelRegistration: (candidate: ResolvedModelRegistrationCandidate) => boolean;
    ownsResumablePiCheckpoint: (candidate: ResolvedModelRegistrationCandidate) => boolean;
    canResumePiCheckpoint: (from: ResolvedModelRegistrationCandidate, to: ResolvedModelRegistrationCandidate) => boolean;
    hasRemoteModelDispatchAuthority: (options: RunTeammateOptions) => boolean;
    captureBuiltinDeploymentDefault: (params: RunSingleTeammateParams, options: RunTeammateOptions, cwd: string, role: AgentConfig, catalog: readonly TeammateModelCapability[] | undefined, remote?: RemoteLocationRouting) => Promise<{
        registry: BackendRegistry;
        resolved: import("pi-graph-provider-backend/protocol/registry").ResolvedBackend<import("pi-maestro-fabric-core/v1/placement").TeammatePlacementV1>;
        assertCurrent: () => void;
    } | undefined>;
    modelRegistrationBackendSpecOf: (params: RunSingleTeammateParams, cwd: string, candidate: ResolvedModelRegistrationCandidate) => TeammateRunSpec;
    preflightModelRegistrationPlan: (context: MutableModelRegistryDispatchContext, correlationId: string, params: RunSingleTeammateParams, cwd: string, plan: ResolvedModelRegistrationRouting, options: RunTeammateOptions, graphTaskCount?: number, registry?: BackendRegistry) => Promise<string[]>;
    candidateForRuntimeModel: (plan: ResolvedModelRegistrationRouting, deploymentId: string, runtimeModel: string | undefined) => ResolvedModelRegistrationCandidate | undefined;
    registryResultCandidate: (result: SingleResult, plan: ResolvedModelRegistrationRouting, initialCandidate: ResolvedModelRegistrationCandidate) => ResolvedModelRegistrationCandidate;
    executionTransportProvenance: (candidate: ResolvedModelRegistrationCandidate) => TeammateExecutionProvenance["transport"];
    attachRegistryResultProvenance: (result: SingleResult, context: ModelRegistryDispatchContext, plan: ResolvedModelRegistrationRouting, initialCandidate: ResolvedModelRegistrationCandidate) => void;
    removeUntrustedResultProvenance: (result: SingleResult) => void;
    backendNameOf: (params: RunSingleTeammateParams, model: string | undefined, remote?: RemoteLocationRouting) => string | undefined;
    backendSpecOf: (params: RunSingleTeammateParams, cwd: string, model: string | undefined, remote?: RemoteLocationRouting) => TeammateRunSpec;
    PROGRESS_STATUSES: readonly AgentProgressStatus[];
    PROGRESS_PHASES: readonly AgentRunPhase[];
    progressNumber: (value: unknown, fallback: number) => number;
    progressTools: (value: unknown) => RecentToolInfo[];
    projectBackendProgress: (data: Record<string, unknown>, agent: string, startedAt: number) => AgentProgress;
    backendOptionsOf: (correlationId: string, baseCwd: string, options: RunTeammateOptions, agent: string, startedAt: number, config: Record<string, ConfigValue>) => BackendRunOptions;
    BackendCapabilityAdmissionError: {
        new (errors: readonly string[]): {
            readonly errors: readonly string[];
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
    prepareBackendAttemptOnce: (registry: BackendRegistry, spec: TeammateRunSpec, requestedBackend?: string, preflight?: ResolvedBackend) => Promise<PreparedBackendAttempt>;
    sourceModelRegistrationPlan: (projection: ModelRegistryDispatchContext["authority"], requestedModel: string | undefined) => ResolvedModelRegistrationRouting;
    assertFabricSourceLocalDeployment: (deploymentId: string, runtime: ModelRuntimeDescriptor) => void;
    SOURCE_SPEC_KEYS: Set<string>;
    assertSourceAttemptInput: (input: {
        placement: unknown;
        spec: TeammateRunSpec;
        correlationId: string;
        baseCwd: string;
        signal: AbortSignal;
    }) => string;
    startFabricSourceBackendAttempt: (input: {
        placement: import("pi-maestro-fabric-core/v1/placement").TeammatePlacementV1;
        spec: TeammateRunSpec;
        correlationId: string;
        baseCwd: string;
        signal: AbortSignal;
        onChildEvent?: (event: Record<string, unknown>) => void;
        onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
    }, runtimeOptions?: FabricSourceRuntimeOptions) => Promise<{
        acceptedBackend: string;
        acceptedModel?: string;
        acceptedCapabilities: BackendCapabilities;
        outcome: Promise<AttemptOutcome>;
        send: BackendRun["send"];
        abort: BackendRun["abort"];
    }>;
};
export type DispatchContext = ReturnType<typeof createDispatchContext>;
export declare function createDispatchOwner(ports: ExecutionPorts): {
    hostRegistryResultProvenance: (result: SingleResult) => TeammateExecutionProvenance | undefined;
    projectBackendProgress: (data: Record<string, unknown>, agent: string, startedAt: number) => AgentProgress;
    startFabricSourceBackendAttempt: (input: {
        placement: import("pi-maestro-fabric-core/v1/placement").TeammatePlacementV1;
        spec: TeammateRunSpec;
        correlationId: string;
        baseCwd: string;
        signal: AbortSignal;
        onChildEvent?: (event: Record<string, unknown>) => void;
        onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
    }, runtimeOptions?: FabricSourceRuntimeOptions) => Promise<{
        acceptedBackend: string;
        acceptedModel?: string;
        acceptedCapabilities: BackendCapabilities;
        outcome: Promise<AttemptOutcome>;
        send: BackendRun["send"];
        abort: BackendRun["abort"];
    }>;
    runGraph: (tasks: NormalizedTask[], concurrency: number, options: RunTeammateOptions) => Promise<SingleResult[]>;
    normalizeGraphConcurrency: (concurrency: number, taskCount: number) => number;
    runSingleTeammate: (params: RunSingleTeammateParams, options: RunTeammateOptions) => Promise<SingleResult>;
    runSingleTeammateWithOrigin: (params: RunSingleTeammateParams, options: RunTeammateOptions, capturedBackendSource?: {
        readonly origin: object | undefined;
    }) => Promise<SingleResult>;
    runTeammate: (params: RunTeammateParams, options: RunTeammateOptions) => Promise<SingleResult[]>;
};
export {};
