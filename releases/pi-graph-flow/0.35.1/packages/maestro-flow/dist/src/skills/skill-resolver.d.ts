export interface SkillFrontmatter {
    name?: string;
    description?: string;
    'argument-hint'?: string;
    'allowed-tools'?: string[];
    orchestration_kind?: 'atomic' | 'terminal_pipeline';
    nested_spawn?: boolean;
    [key: string]: unknown;
}
export interface SkillManifest {
    filePath: string;
    frontmatter: SkillFrontmatter;
    body: string;
    requiredPaths: string[];
    deferredPaths: string[];
    missingRequired: string[];
}
export interface LoadedSkill extends SkillManifest {
    requiredBodies: Array<{
        path: string;
        content: string;
    }>;
}
/** Expand `~/`, `@~/`, and resolve relative paths.
 *
 * Resolution rules (first match wins):
 *   1. `~/foo` / `@~/foo`             → `<homedir>/foo`
 *   2. absolute path                   → as-is
 *   3. starts with `.claude/`          → scope-root-relative (walk up baseDir
 *      until we find the parent that contains the `.claude/` segment, treat
 *      that parent as root). Used by skill SKILL.md files that reference
 *      sibling files via `@.claude/skills/<name>/specs/...`.
 *   4. otherwise                       → relative to baseDir (.md's directory)
 */
/** Normalize a stored absolute-ish path: expand `~/` to homedir, leave others. */
export declare function normalizeStoredPath(p: string): string;
export declare function expandPath(raw: string, baseDir: string): string;
/** Parse manifest only — does NOT read required files. */
export declare function parseSkillManifest(filePath: string): SkillManifest;
/** Parse + read all required files. Throws on first missing required. */
export declare function loadSkill(filePath: string): LoadedSkill;
//# sourceMappingURL=skill-resolver.d.ts.map