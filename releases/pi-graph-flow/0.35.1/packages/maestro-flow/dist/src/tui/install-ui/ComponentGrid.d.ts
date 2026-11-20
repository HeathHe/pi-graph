import type { ScannedComponent } from '../../commands/install-backend.js';
export interface ComponentGridProps {
    components: ScannedComponent[];
    selectedIds: string[];
    onSelectionChange: (ids: string[]) => void;
    onDone: () => void;
}
export declare function ComponentGrid({ components, selectedIds, onSelectionChange, onDone, }: ComponentGridProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ComponentGrid.d.ts.map