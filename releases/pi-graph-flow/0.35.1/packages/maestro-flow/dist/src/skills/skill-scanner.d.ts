export type SkillPlatform = 'claude' | 'codex' | 'agent' | 'agy' | 'pi';
export interface ScannedSkill {
    type: 'command' | 'skill';
    scope: 'global' | 'project';
    platform: SkillPlatform;
    name: string;
    filePath: string;
    description: string;
    argumentHint: string;
    requiredCount: number;
    deferredCount: number;
    missingRequired: string[];
}
export interface ScanOptions {
    platform?: SkillPlatform;
}
export interface PiSkillSource {
    dir: string;
    scope: 'global' | 'project';
}
export interface PiSkillSourceDiagnostic extends PiSkillSource {
    code: 'PI_SKILL_DIR_MISSING';
}
/**
 * Locate Pi skills through the owning npm package.
 *
 * npm may keep maestro-flow under pi-maestro-flow/node_modules or dedupe both
 * packages into the same node_modules directory, so inspect both ancestors and
 * sibling package slots. The package manifest's `pi.skills` field is the only
 * directory authority.
 */
export declare function discoverPiSkillSources(workflowRoot?: string, runtimeModulePath?: string, advertisedPackageRoot?: string | undefined): PiSkillSource[];
export declare function diagnosePiSkillSources(workflowRoot?: string, runtimeModulePath?: string): PiSkillSourceDiagnostic[];
export declare function scanAllSkills(workflowRoot?: string, opts?: ScanOptions): ScannedSkill[];
/** Look up a single skill/command by name. Returns null if not found. */
export declare function findSkill(name: string, type?: 'command' | 'skill', platform?: SkillPlatform): ScannedSkill | null;
//# sourceMappingURL=skill-scanner.d.ts.map