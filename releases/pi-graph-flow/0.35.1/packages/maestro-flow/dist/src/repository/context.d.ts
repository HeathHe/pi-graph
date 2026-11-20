import type { WorkspaceConfig, WorkspaceCorpus, WorkspaceLink } from '../types/index.js';
import type { AgentRepositoryBinding, AgentRepositoryContext } from '../../shared/agent-types.js';
export declare const REPOSITORY_IDENTITY_SCHEMA: "repository-identity/1.0";
export declare const REPOSITORY_IDENTITY_PATH: string;
export declare const CURRENT_REPOSITORY_ALIAS: "current";
export interface RepositoryIdentityManifest {
    schema_version: typeof REPOSITORY_IDENTITY_SCHEMA;
    repo_id: string;
    repo_name: string;
    created_at: string;
}
export type RepositoryRelation = 'current' | 'linked';
export interface RepositoryContext {
    /** Null only for a readable legacy repository with no persisted manifest. */
    repoId: string | null;
    repoName: string;
    /** Historical path-derived workspace identity. This intentionally does not use repoId. */
    workspaceId: string;
    projectRoot: string;
    workflowRoot: string;
    /** Host repository whose link configuration grants this authority. */
    authorityRoot: string;
    relation: RepositoryRelation;
    alias: string;
    identityPersisted: boolean;
    read: WorkspaceCorpus[];
    write: WorkspaceCorpus[];
}
export interface InspectedWorkspaceLink {
    resolvedPath: string;
    workflowRoot: string;
    valid: boolean;
    identityPersisted: boolean;
    repoId: string | null;
    repoName: string;
    error?: string;
}
export declare function isPathContained(candidate: string, root: string): boolean;
export declare function canonicalizeRepositoryRoot(projectRoot: string): string;
export declare function readRepositoryIdentity(projectRoot: string): RepositoryIdentityManifest | null;
export declare function initializeRepositoryIdentity(projectRoot: string, options?: {
    repoName?: string;
}): RepositoryIdentityManifest;
export declare function reseedRepositoryIdentity(projectRoot: string, options?: {
    repoName?: string;
}): {
    previous: RepositoryIdentityManifest | null;
    current: RepositoryIdentityManifest;
};
/** Find and canonicalize the nearest repository boundary without mutating identity. */
export declare function findRepositoryRoot(startDir: string): string | null;
export declare function inspectWorkspaceLink(projectRoot: string, link: WorkspaceLink): InspectedWorkspaceLink;
export interface ResolveRepositoryOptions {
    projectRoot?: string;
    config?: WorkspaceConfig;
    require?: {
        mode: 'read' | 'write';
        corpus: WorkspaceCorpus;
    };
}
/**
 * Resolve a repository selector in the fixed order: current, exact repo ID,
 * exact linked alias, then unique repository display name.
 */
export declare function resolveRepositoryContext(selector?: string, options?: ResolveRepositoryOptions): RepositoryContext;
export declare function assertRepositoryCapability(context: RepositoryContext, mode: 'read' | 'write', corpus: WorkspaceCorpus): void;
/** Resolve the immutable actor context passed to agent and MCP runtimes. */
export declare function resolveAgentRepositoryContext(projectRoot: string, options?: {
    allowLegacyReadFallback?: boolean;
}): AgentRepositoryContext;
export declare function resolveAgentRepositoryTarget(actor: AgentRepositoryContext, targetRepoId: string | undefined, mode: 'read' | 'write', corpus: WorkspaceCorpus): AgentRepositoryBinding;
interface ActiveRepositoryExecution {
    actor: AgentRepositoryContext;
    target: AgentRepositoryBinding;
}
/** Re-read host config and manifests so a stale Agent/MCP snapshot cannot retain revoked authority. */
export declare function revalidateAgentRepositoryTarget(actor: AgentRepositoryContext, supplied: AgentRepositoryBinding, mode: 'read' | 'write', corpus: WorkspaceCorpus): AgentRepositoryBinding;
export declare function runWithRepositoryExecution<T>(actor: AgentRepositoryContext, target: AgentRepositoryBinding, operation: () => T): T;
export declare function getActiveRepositoryExecution(): ActiveRepositoryExecution | undefined;
export interface RepositoryMutationContext {
    projectRoot: string;
    repoId: string | null;
    /** Optional only for legacy in-repository writer call sites. */
    relation?: RepositoryRelation;
    alias?: string;
    authorityRoot?: string;
}
/**
 * Revalidate linked authority and target identity under deterministic source/target
 * locks immediately around a corpus mutation. Legacy links remain read-only.
 */
export declare function withRepositoryMutation<T>(supplied: RepositoryMutationContext, corpus: WorkspaceCorpus, targetPaths: readonly string[], operation: (validated: RepositoryContext) => T): T;
export interface ResolveRepositorySelectorsOptions {
    projectRoot?: string;
    config?: WorkspaceConfig;
    corpus?: WorkspaceCorpus;
    mode?: 'read' | 'write';
}
/** Resolve human-facing selectors and return only persisted corpus-safe IDs. */
export declare function resolveRepositorySelectorIds(selectors: readonly string[], options?: ResolveRepositorySelectorsOptions): string[];
/**
 * Resolve an ID-only tool contract. Aliases and display names deliberately fail
 * even when they would otherwise resolve, preventing non-canonical values from
 * leaking into corpus metadata.
 */
export declare function resolveRepositoryId(repoId: string, options?: ResolveRepositorySelectorsOptions): RepositoryContext;
export {};
//# sourceMappingURL=context.d.ts.map