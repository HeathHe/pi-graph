interface BackupConfigProps {
    backupClaudeMd: boolean;
    backupAll: boolean;
    existingFileCount: number;
    onClaudeMdChange: (v: boolean) => void;
    onAllChange: (v: boolean) => void;
}
export declare function BackupConfig({ backupClaudeMd, backupAll, existingFileCount, onClaudeMdChange, onAllChange, }: BackupConfigProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=BackupConfig.d.ts.map