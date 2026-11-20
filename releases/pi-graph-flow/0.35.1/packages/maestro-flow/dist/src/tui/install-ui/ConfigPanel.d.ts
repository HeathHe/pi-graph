import type { InstallConfig } from './types.js';
interface ConfigPanelProps {
    config: InstallConfig;
    onConfigChange: (config: Partial<InstallConfig>) => void;
    onDone: () => void;
    onBack: () => void;
    existingManifest: boolean;
}
export declare function ConfigPanel({ config, onConfigChange, onDone, onBack, existingManifest, }: ConfigPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ConfigPanel.d.ts.map