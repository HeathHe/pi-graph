export interface CyberItemProps {
    /** 1-based display index (1-9) */
    index: number;
    /** Human-readable component label */
    label: string;
    /** Number of files in the source directory */
    fileCount: number;
    /** Whether this row is currently selected for install */
    selected: boolean;
    /** Whether the component has source files available */
    available: boolean;
    /** Whether this row is currently highlighted by cursor */
    highlighted: boolean;
    /** Short description of the component */
    description: string;
    /** Whether this component is mandatory (always installed, cannot be deselected) */
    mandatory?: boolean;
}
export declare function CyberItem({ index, label, fileCount, selected, available, highlighted, description, mandatory, }: CyberItemProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=CyberItem.d.ts.map