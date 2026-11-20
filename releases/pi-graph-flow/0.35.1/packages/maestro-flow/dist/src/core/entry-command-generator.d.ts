/** Steps generated when no explicit selection is given. */
export declare const DEFAULT_ENTRY_STEPS: string[];
export interface EntryStepInfo {
    step: string;
    description: string;
    argumentHint: string;
    preparePath: string;
}
/**
 * Scan pkgRoot for steps eligible for entry skill generation:
 * a step qualifies when both prepare/<step>.md and workflows/<step>.md exist.
 */
export declare function scanEntrySteps(pkgRoot: string): EntryStepInfo[];
/** Skill name: odyssey-* steps keep their own name; others get maestro- prefix. */
export declare function entrySkillName(step: string): string;
export declare function renderEntryCommand(info: EntryStepInfo): string;
/**
 * Generate entry skills for the given steps into targetDir
 * (a skills directory, e.g. `.pi/skills`). Each step produces
 * `<targetDir>/maestro-<step>/SKILL.md`. Unknown step names are skipped.
 */
export declare function buildEntryCommands(pkgRoot: string, targetDir: string, steps?: string[]): {
    files: number;
    written: string[];
    unknown: string[];
};
//# sourceMappingURL=entry-command-generator.d.ts.map