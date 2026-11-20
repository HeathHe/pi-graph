import { type ExtraMcpTargetId } from '../../commands/install-backend.js';
interface ExtraMcpConfigProps {
    mode: 'global' | 'project';
    selectedIds: ExtraMcpTargetId[];
    onSelectionChange: (ids: ExtraMcpTargetId[]) => void;
    onDone: () => void;
    onBack: () => void;
}
export declare function ExtraMcpConfig({ mode, selectedIds, onSelectionChange, onDone, onBack, }: ExtraMcpConfigProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ExtraMcpConfig.d.ts.map