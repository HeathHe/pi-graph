import { type CommandDef } from '../../config/argument-hint-parser.js';
import { type SkillConfigFile } from '../../config/skill-config.js';
export interface SkillsListProps {
    config: SkillConfigFile;
    commandDefs: Map<string, CommandDef>;
    workDir: string;
    onBack: () => void;
    onEdit: (skillName: string) => void;
    onReload: () => void;
}
export declare function SkillsList({ config, commandDefs, workDir, onBack, onEdit, onReload }: SkillsListProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=SkillsList.d.ts.map