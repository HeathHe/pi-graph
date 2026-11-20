interface KeyHintsProps {
    hints: string;
}
/**
 * Standardized keyboard hint footer.
 * Always rendered at the bottom of interactive screens with marginTop={1}.
 */
export declare function KeyHints({ hints }: KeyHintsProps): import("react/jsx-runtime").JSX.Element;
interface SectionHeaderProps {
    title: string;
}
/**
 * Bold cyan section header — the standard heading pattern.
 */
export declare function SectionHeader({ title }: SectionHeaderProps): import("react/jsx-runtime").JSX.Element;
interface StatusBadgeProps {
    enabled: boolean;
    /** Override labels. Default: ✓/✗ */
    labels?: {
        on: string;
        off: string;
    };
}
/**
 * Standardized status indicator: green ✓ or red ✗.
 */
export declare function StatusBadge({ enabled, labels }: StatusBadgeProps): import("react/jsx-runtime").JSX.Element;
interface CursorMarkerProps {
    active: boolean;
}
/**
 * Standardized cursor: ▸ in cyan when active, space when not.
 */
export declare function CursorMarker({ active }: CursorMarkerProps): import("react/jsx-runtime").JSX.Element;
interface CheckboxProps {
    checked: boolean;
    highlighted?: boolean;
}
/**
 * Standardized checkbox: [x] in green when checked, [ ] in gray when not.
 * When highlighted and checked, uses greenBright.
 */
export declare function Checkbox({ checked, highlighted }: CheckboxProps): import("react/jsx-runtime").JSX.Element;
interface BreadcrumbProps {
    path: string[];
}
export declare function Breadcrumb({ path }: BreadcrumbProps): import("react/jsx-runtime").JSX.Element;
interface StepProgressProps {
    steps: {
        key: string;
        label: string;
    }[];
    currentKey: string;
}
/**
 * Horizontal step progress bar: [x] done [>] current [ ] pending
 */
export declare function StepProgress({ steps, currentKey }: StepProgressProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=components.d.ts.map