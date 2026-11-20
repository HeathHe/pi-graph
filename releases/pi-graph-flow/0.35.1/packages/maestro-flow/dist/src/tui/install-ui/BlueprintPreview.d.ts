export type FileStatus = 'new' | 'exists' | 'preserved';
interface BlueprintPreviewProps {
    mode: 'global' | 'project';
    projectPath: string;
    selectedIds: string[];
}
export declare function BlueprintPreview({ mode, projectPath, selectedIds }: BlueprintPreviewProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=BlueprintPreview.d.ts.map