/**
 * Centralized Path Validation Utility
 *
 * Provides secure path validation and resolution for MCP tools.
 * Prevents path traversal attacks and ensures operations stay within allowed directories.
 */
/**
 * Check if sandbox mode is enabled
 * When enabled, path validation restricts access to allowed directories only
 */
export declare function isSandboxEnabled(): boolean;
/**
 * Get the canonical repository boundary.
 * Priority remains MAESTRO_PROJECT_ROOT > process.cwd(), but nested cwd/env
 * values now converge on the same realpath-resolved `.workflow` carrier.
 */
export declare function getProjectRoot(): string;
/**
 * Get allowed directories list
 * Priority: MAESTRO_ALLOWED_DIRS > [getProjectRoot()]
 */
export declare function getAllowedDirectories(): string[];
/**
 * Normalize path (unify separators to forward slash)
 */
export declare function normalizePath(p: string): string;
/**
 * Check if path is within allowed directories
 */
export declare function isPathWithinAllowedDirectories(targetPath: string, allowedDirectories: string[]): boolean;
/**
 * Validate and resolve path (core function)
 *
 * Security model:
 * 1. Resolve to absolute path
 * 2. Check against allowed directories
 * 3. Resolve symlinks and re-verify
 *
 * @param filePath - Path to validate
 * @param options - Validation options
 * @returns Validated absolute path
 * @throws Error if path is outside allowed directories or validation fails
 */
export declare function validatePath(filePath: string, options?: {
    allowedDirectories?: string[];
    mustExist?: boolean;
}): Promise<string>;
/**
 * Resolve project-relative path (simplified, no strict validation)
 * Use for cases where strict security validation is not needed
 */
export declare function resolveProjectPath(...pathSegments: string[]): string;
