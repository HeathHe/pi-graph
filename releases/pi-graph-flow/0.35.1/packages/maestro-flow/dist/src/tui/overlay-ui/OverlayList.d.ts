import type { OverlayFile } from '../../core/overlay/types.js';
export interface LoadError {
    path: string;
    errors: string[];
}
export interface OverlayAppliedState {
    name: string;
    appliedScopes: string[];
}
export interface SectionMarker {
    overlayName: string;
    patchIdx: number;
    line: number;
    description: string;
}
export interface TargetSection {
    name: string;
    openLine: number;
    closeLine: number;
}
export interface TargetInfo {
    name: string;
    /** Which CLI this target belongs to. */
    cli: 'claude' | 'codex';
    sections: TargetSection[];
    markers: SectionMarker[];
}
export interface OverlayListProps {
    overlays: OverlayFile[];
    errors: LoadError[];
    appliedState: Map<string, OverlayAppliedState>;
    targets: TargetInfo[];
    interactive: boolean;
    onDelete: (name: string) => void;
}
export declare function OverlayList({ overlays: initialOverlays, errors, appliedState: initialApplied, targets: initialTargets, interactive, onDelete, }: OverlayListProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=OverlayList.d.ts.map