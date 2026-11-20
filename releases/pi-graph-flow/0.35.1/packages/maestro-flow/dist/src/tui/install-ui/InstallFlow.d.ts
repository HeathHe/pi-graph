import { type FlowStepCompat } from './useInstallFlowState.js';
export interface InstallFlowProps {
    pkgRoot: string;
    version: string;
    initialStep?: FlowStepCompat;
    initialMode?: 'global' | 'project';
    initialStepIds?: string[];
    initialProjectPath?: string;
}
export declare function InstallFlow({ pkgRoot, version, initialStep, initialMode, initialStepIds, initialProjectPath }: InstallFlowProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=InstallFlow.d.ts.map