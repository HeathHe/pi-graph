import { type HookLevel } from '../../commands/hooks.js';
export interface HooksSelection {
    basePreset: HookLevel;
    selectedHooks: string[];
    isCustom: boolean;
}
interface HooksConfigProps {
    selection: HooksSelection;
    onSelectionChange: (sel: HooksSelection) => void;
    title?: string;
    descriptions?: Record<string, string>;
    /** Which tool's hook defs to use */
    tool?: 'claude' | 'codex' | 'agy';
}
export declare function HooksConfig({ selection, onSelectionChange, title, descriptions, tool, }: HooksConfigProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=HooksConfig.d.ts.map