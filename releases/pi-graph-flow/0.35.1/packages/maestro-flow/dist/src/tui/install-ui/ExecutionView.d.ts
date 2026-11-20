import { type ScannedComponent } from '../../commands/install-backend.js';
import { type InstallConfig, type InstallResult } from './types.js';
interface ExecutionViewProps {
    components: ScannedComponent[];
    config: InstallConfig;
    pkgRoot: string;
    version: string;
    onComplete: (result: InstallResult) => void;
}
export declare function ExecutionView({ components, config, pkgRoot, version, onComplete, }: ExecutionViewProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ExecutionView.d.ts.map