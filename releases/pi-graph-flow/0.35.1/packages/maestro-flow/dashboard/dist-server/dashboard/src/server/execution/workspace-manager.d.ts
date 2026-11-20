export interface WorkspaceConfig {
    /** Root directory for worktrees. Defaults to .worktrees/ in project root */
    root?: string;
    /** Whether to use git worktree (true) or just a subdirectory (false) */
    useWorktree: boolean;
    /** Base branch for worktree creation. Defaults to current HEAD */
    baseBranch?: string;
    /** Auto-cleanup completed worktrees */
    autoCleanup: boolean;
}
export declare const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig;
export interface WorkspaceInfo {
    issueId: string;
    path: string;
    branch?: string;
    createdAt: string;
}
export declare class WorkspaceManager {
    private readonly activeWorkspaces;
    private readonly config;
    private readonly projectRoot;
    private readonly worktreeRoot;
    constructor(projectRoot: string, config?: Partial<WorkspaceConfig>);
    /**
     * Create an isolated workspace for an issue.
     * Uses git worktree for full isolation with shared .git objects.
     */
    createForIssue(issueId: string): Promise<WorkspaceInfo>;
    /**
     * Remove workspace after issue completion.
     */
    removeForIssue(issueId: string): Promise<void>;
    /**
     * Get workspace path for an issue, or undefined if not created.
     */
    getWorkspacePath(issueId: string): string | undefined;
    /**
     * List all active workspaces.
     */
    listActive(): WorkspaceInfo[];
    /**
     * Clean up all active workspaces (shutdown).
     */
    destroy(): Promise<void>;
    private createWorktree;
    private createDirectory;
    /** Convert issue ID to filesystem-safe identifier */
    private safeIdentifier;
}
