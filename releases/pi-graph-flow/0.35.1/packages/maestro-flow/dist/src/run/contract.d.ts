import { z } from 'zod';
import { chainEffectSchema, type ContractSnapshot } from './protocol-schemas.js';
declare const gateDefinitionSchema: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
    key: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    required: z.ZodDefault<z.ZodBoolean>;
    blocking: z.ZodDefault<z.ZodBoolean>;
    applicable_modes: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        quick: "quick";
        standard: "standard";
        full: "full";
    }>>>;
    check: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$loose>]>;
export type ContractGateDefinition = z.infer<typeof gateDefinitionSchema>;
export type ChainEffect = z.infer<typeof chainEffectSchema>;
export interface CommandContractConsume {
    kind: string;
    alias?: string;
    required: boolean;
    require_status?: 'sealed';
    schema?: string;
    schema_range?: string;
    role?: 'primary' | 'attachment' | 'evidence' | 'checkpoint';
    accepts_negative_evidence?: boolean;
}
export interface CommandArgumentContract {
    name: string;
    type: 'boolean' | 'enum' | 'string' | 'number';
    required: boolean;
    default?: string | number | boolean;
    question?: string;
}
export interface CommandContractProduce {
    kind: string;
    primary: boolean;
    path?: string;
    alias?: string;
    role?: 'primary' | 'attachment' | 'evidence' | 'checkpoint';
    required?: boolean;
    schema?: string;
}
export interface CommandContract {
    contract_version?: 1 | 2 | 2.1;
    schema_version?: 'command-contract/1.0' | 'command-contract/2.0' | 'command-contract/2.1';
    consumes: CommandContractConsume[];
    arguments: CommandArgumentContract[];
    produces: CommandContractProduce[];
    orchestration?: {
        chain_effects: ChainEffect[];
    };
    gates: {
        entry: ContractGateDefinition[];
        exit: ContractGateDefinition[];
    };
    compatibility_warnings?: string[];
}
export declare function parseCommandContract(raw: unknown): CommandContract;
export declare function normalizedCommandContract(contract: CommandContract): Record<string, unknown>;
export declare function createContractSnapshot(contract: CommandContract, capturedAt?: string): ContractSnapshot;
export declare function hashCommandContract(contract: CommandContract): string;
declare const SESSION_MODES: readonly ["run", "brief", "none", "bootstrap"];
export type SessionMode = typeof SESSION_MODES[number];
export interface ResolvedCommandSource {
    path: string;
    relativePath: string;
    raw: string;
    contentHash: string;
    contract: CommandContract;
    contractSnapshot: ContractSnapshot;
    contractWarnings: string[];
    sessionMode: SessionMode;
}
/** Invalidate cached step-content resolutions (used by tests and long-lived servers). */
export declare function invalidateResolutionCache(): void;
export declare function resolveCommandSource(projectRoot: string, commandName: string): ResolvedCommandSource;
export interface ResolvedStepContent {
    prepare: {
        path: string;
        raw: string;
    } | null;
    workflow: {
        path: string;
        raw: string;
    } | null;
    runMode: {
        path: string;
        raw: string;
    } | null;
    refs: Array<{
        path: string;
        when: string;
    }>;
    /** Workflow-declared finish norms (frontmatter `finish:`), appended to the `run check` finish checklist. */
    finish: string[];
}
export declare function resolveStepContent(projectRoot: string, stepName: string, platformSuffix?: string): ResolvedStepContent;
export interface StepRegistryEntry {
    name: string;
    scope: 'global' | 'project';
    source: 'prepare' | 'workflow' | 'association';
    path: string;
}
/**
 * Enumerate every step name `resolveStepContent` can resolve: prepare/workflow
 * basenames plus workflow frontmatter command aliases. This is the build-time
 * mirror of the run-time step registry — `maestro skills --steps` exposes it so
 * chain-build prevalidation validates against the same name space `run next`
 * loads from.
 */
export declare function listResolvableSteps(projectRoot: string): StepRegistryEntry[];
export {};
//# sourceMappingURL=contract.d.ts.map