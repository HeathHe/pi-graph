import type { OverlayAppliedState, TargetInfo } from './OverlayList.js';
export interface OverlayData {
    overlays: import('../../core/overlay/types.js').OverlayFile[];
    errors: {
        path: string;
        errors: string[];
    }[];
    appliedState: Map<string, OverlayAppliedState>;
    targets: TargetInfo[];
    handleDelete: (name: string) => void;
}
/**
 * Collect overlay data for rendering. Returns null if no overlays directory
 * or no overlays installed.
 */
export declare function prepareOverlayData(): OverlayData | null;
export declare function runOverlayListUI(interactive: boolean): Promise<void>;
//# sourceMappingURL=index.d.ts.map