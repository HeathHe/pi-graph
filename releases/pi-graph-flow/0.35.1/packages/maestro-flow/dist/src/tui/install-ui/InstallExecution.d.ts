import { type InstallResult } from '../../core/install-executor.js';
import type { InstallFlowConfig } from './types.js';
export type { InstallResult as InstallFlowResult } from '../../core/install-executor.js';
interface InstallExecutionProps {
    config: InstallFlowConfig;
    pkgRoot: string;
    version: string;
    onComplete: (result: InstallResult) => void;
}
export declare function InstallExecution({ config, pkgRoot, version, onComplete }: InstallExecutionProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=InstallExecution.d.ts.map