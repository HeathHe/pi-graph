export interface StepDef {
    id: string;
    label: string;
    description: string;
}
interface StepSelectorProps {
    steps: StepDef[];
    selectedIds: string[];
    onSelectionChange: (ids: string[]) => void;
    onDone: () => void;
}
export declare function StepSelector({ steps, selectedIds, onSelectionChange, onDone }: StepSelectorProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=StepSelector.d.ts.map