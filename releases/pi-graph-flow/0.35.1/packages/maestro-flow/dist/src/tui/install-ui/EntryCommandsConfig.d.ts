import type { EntryStepInfo } from '../../core/entry-command-generator.js';
interface EntryCommandsConfigProps {
    eligibleSteps: EntryStepInfo[];
    selectedSteps: string[];
    onSelectionChange: (steps: string[]) => void;
    onDone: () => void;
}
export declare function EntryCommandsConfig({ eligibleSteps, selectedSteps, onSelectionChange, onDone, }: EntryCommandsConfigProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=EntryCommandsConfig.d.ts.map