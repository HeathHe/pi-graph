import { type CommandDef } from '../../config/argument-hint-parser.js';
import { type SkillConfigFile } from '../../config/skill-config.js';
export interface SkillParamEditorProps {
    skillName: string;
    commandDef: CommandDef | null;
    config: SkillConfigFile;
    workDir: string;
    onBack: () => void;
    onReload: () => void;
}
export declare function SkillParamEditor({ skillName, commandDef, config, workDir, onBack, onReload, }: SkillParamEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=SkillParamEditor.d.ts.map