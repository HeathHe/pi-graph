export interface WorkflowsInstallResult {
    sourceDir: string;
    targetDir: string;
    filesInstalled: number;
    dirsCreated: number;
    installedFiles: string[];
}
export declare function installWorkflowsOnly(packageRoot: string, targetDir?: string): WorkflowsInstallResult;
export declare function installPrepareFiles(packageRoot: string, targetDir?: string): WorkflowsInstallResult;
export declare function installRefFiles(packageRoot: string, targetDir?: string): WorkflowsInstallResult;
export declare function installArchKb(packageRoot: string, targetDir?: string): WorkflowsInstallResult;
export declare function installAllStepContent(packageRoot: string): {
    workflows: WorkflowsInstallResult;
    prepare: WorkflowsInstallResult;
    ref: WorkflowsInstallResult;
    archKb: WorkflowsInstallResult;
};
//# sourceMappingURL=workflows-installer.d.ts.map