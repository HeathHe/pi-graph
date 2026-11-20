export type ToggleState = 'on' | 'off' | 'available';
export interface ToggleItem {
    name: string;
    type: 'command' | 'skill' | 'agent';
    state: ToggleState;
    sourcePath: string;
    targetActive: string;
    targetDisabled: string;
}
export declare function scanToggleItems(pkgRoot: string, targetBase: string): ToggleItem[];
export declare function applyToggle(item: ToggleItem, pkgRoot: string): boolean;
export declare function updateManifestDisabledItems(scope: 'global' | 'project', targetPath: string, disabledNames: string[]): void;
