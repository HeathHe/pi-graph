interface ReviewPanelProps {
    config: {
        mode: 'global' | 'project';
        projectPath: string;
        selectedIds: string[];
        mcpEnabled: boolean;
        mcpTools: string[];
        mcpProjectRoot: string;
        hookLevel: string;
        doBackup: boolean;
    };
    componentLabels: string[];
    fileCount: number;
    onConfirm: () => void;
    onBack: () => void;
}
export declare function ReviewPanel({ config, componentLabels, fileCount, onConfirm, onBack, }: ReviewPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ReviewPanel.d.ts.map