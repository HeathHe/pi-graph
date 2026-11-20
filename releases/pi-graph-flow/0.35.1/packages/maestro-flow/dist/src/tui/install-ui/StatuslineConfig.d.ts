interface StatuslineConfigProps {
    enabled: boolean;
    theme: string;
    /** Currently detected statusline command, or null */
    detected: string | null;
    onToggle: (v: boolean) => void;
    onThemeChange: (v: string) => void;
}
export declare function StatuslineConfig({ enabled, theme, detected, onToggle, onThemeChange, }: StatuslineConfigProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=StatuslineConfig.d.ts.map