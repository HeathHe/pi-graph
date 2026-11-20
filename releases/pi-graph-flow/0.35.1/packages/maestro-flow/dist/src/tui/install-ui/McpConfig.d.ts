interface McpConfigProps {
    enabled: boolean;
    tools: string[];
    projectRoot: string;
    mode: string;
    onEnableChange: (v: boolean) => void;
    onToolsChange: (tools: string[]) => void;
    onRootChange: (root: string) => void;
}
export declare function McpConfig({ enabled, tools, projectRoot, mode, onEnableChange, onToolsChange, onRootChange, }: McpConfigProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=McpConfig.d.ts.map