export type HarnessType = 'claude' | 'codex';
export interface AddonTarget {
    /** Harness type */
    harness: HarnessType;
    /** Source path within the repo (e.g. '.claude/skills/impeccable') */
    srcPath: string;
    /** Target path relative to base (e.g. '.claude/skills/impeccable') */
    destPath: string;
}
export interface AddonDef {
    /** Unique addon identifier */
    id: string;
    /** Display name */
    name: string;
    /** One-line description */
    description: string;
    /** GitHub repo in owner/repo format */
    repo: string;
    /** Branch to clone from */
    branch: string;
    /** Install targets per harness — each copies srcPath → destPath */
    targets: AddonTarget[];
    /** Homepage URL for info link */
    homepage?: string;
    /** Tags for categorization */
    tags?: string[];
}
/** Harness dir mapping: harness → dotdir */
export declare const HARNESS_DIRS: Record<HarnessType, string>;
export declare const ADDON_REGISTRY: AddonDef[];
//# sourceMappingURL=addon-registry.d.ts.map