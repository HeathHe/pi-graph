import { type SkillPlatform } from './skill-scanner.js';
export interface SkillsCmdOptions {
    json?: boolean;
    quiet?: boolean;
    platform?: SkillPlatform;
    steps?: boolean;
}
export declare function runSkills(opts: SkillsCmdOptions): Promise<number>;
//# sourceMappingURL=cmd-skills.d.ts.map