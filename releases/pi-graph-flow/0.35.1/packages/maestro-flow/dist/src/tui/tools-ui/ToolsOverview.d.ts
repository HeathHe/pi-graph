import { type CliToolsConfig } from '../../config/cli-tools-config.js';
export interface ToolsOverviewProps {
    config: CliToolsConfig;
    workDir: string;
    onBack: () => void;
    onReload: () => void;
}
export declare function ToolsOverview({ config, workDir, onBack, onReload }: ToolsOverviewProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ToolsOverview.d.ts.map