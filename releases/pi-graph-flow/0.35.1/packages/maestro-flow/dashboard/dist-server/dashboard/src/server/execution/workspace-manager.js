// ---------------------------------------------------------------------------
// WorkspaceManager — per-issue workspace isolation via git worktree
// ---------------------------------------------------------------------------
import { execFile } from 'node:child_process';
import { mkdir, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const DEFAULT_WORKSPACE_CONFIG = {
    useWorktree: true,
    autoCleanup: true,
};
// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------
export class WorkspaceManager {
    activeWorkspaces = new Map();
    config;
    projectRoot;
    worktreeRoot;
    constructor(projectRoot, config) {
        this.config = { ...DEFAULT_WORKSPACE_CONFIG, ...config };
        this.projectRoot = resolve(projectRoot);
        this.worktreeRoot = resolve(this.config.root ?? join(projectRoot, '.worktrees'));
    }
    /**
     * Create an isolated workspace for an issue.
     * Uses git worktree for full isolation with shared .git objects.
     */
    async createForIssue(issueId) {
        // Return existing workspace if already created
        const existing = this.activeWorkspaces.get(issueId);
        if (existing) {
            try {
                await access(existing.path);
                return existing;
            }
            catch {
                // Path gone, recreate
                this.activeWorkspaces.delete(issueId);
            }
        }
        const safeName = this.safeIdentifier(issueId);
        const workspacePath = join(this.worktreeRoot, safeName);
        await mkdir(this.worktreeRoot, { recursive: true });
        let info;
        if (this.config.useWorktree) {
            info = await this.createWorktree(issueId, safeName, workspacePath);
        }
        else {
            info = await this.createDirectory(issueId, workspacePath);
        }
        this.activeWorkspaces.set(issueId, info);
        return info;
    }
    /**
     * Remove workspace after issue completion.
     */
    async removeForIssue(issueId) {
        const info = this.activeWorkspaces.get(issueId);
        if (!info)
            return;
        try {
            if (this.config.useWorktree && info.branch) {
                // Remove git worktree
                await execFileAsync('git', ['worktree', 'remove', '--force', info.path], {
                    cwd: this.projectRoot,
                });
                // Delete the branch — tolerate "not found" but warn on other errors
                await execFileAsync('git', ['branch', '-D', info.branch], {
                    cwd: this.projectRoot,
                }).catch((err) => {
                    const stderr = err.stderr ?? '';
                    if (!stderr.includes('not found')) {
                        console.warn(`[Workspace] Failed to delete branch ${info.branch}:`, stderr);
                    }
                });
            }
            else {
                await rm(info.path, { recursive: true, force: true });
            }
        }
        catch (err) {
            console.warn(`[Workspace] Failed to remove workspace for ${issueId}:`, err);
        }
        this.activeWorkspaces.delete(issueId);
    }
    /**
     * Get workspace path for an issue, or undefined if not created.
     */
    getWorkspacePath(issueId) {
        return this.activeWorkspaces.get(issueId)?.path;
    }
    /**
     * List all active workspaces.
     */
    listActive() {
        return Array.from(this.activeWorkspaces.values());
    }
    /**
     * Clean up all active workspaces (shutdown).
     */
    async destroy() {
        if (!this.config.autoCleanup)
            return;
        const issueIds = Array.from(this.activeWorkspaces.keys());
        await Promise.allSettled(issueIds.map((id) => this.removeForIssue(id)));
    }
    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------
    async createWorktree(issueId, safeName, workspacePath) {
        const branch = `issue/${safeName}`;
        const baseBranch = this.config.baseBranch ?? 'HEAD';
        // Ensure no stale worktree at this path
        try {
            await access(workspacePath);
            await execFileAsync('git', ['worktree', 'remove', '--force', workspacePath], {
                cwd: this.projectRoot,
            }).catch(() => { });
        }
        catch {
            // Path doesn't exist, clean
        }
        // Delete stale branch if exists
        await execFileAsync('git', ['branch', '-D', branch], {
            cwd: this.projectRoot,
        }).catch(() => { });
        // Create worktree with new branch
        await execFileAsync('git', ['worktree', 'add', '-b', branch, workspacePath, baseBranch], { cwd: this.projectRoot });
        return {
            issueId,
            path: workspacePath,
            branch,
            createdAt: new Date().toISOString(),
        };
    }
    async createDirectory(issueId, workspacePath) {
        await mkdir(workspacePath, { recursive: true });
        return {
            issueId,
            path: workspacePath,
            createdAt: new Date().toISOString(),
        };
    }
    /** Convert issue ID to filesystem-safe identifier */
    safeIdentifier(issueId) {
        return issueId
            .replace(/[^a-zA-Z0-9_-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 60);
    }
}
//# sourceMappingURL=workspace-manager.js.map