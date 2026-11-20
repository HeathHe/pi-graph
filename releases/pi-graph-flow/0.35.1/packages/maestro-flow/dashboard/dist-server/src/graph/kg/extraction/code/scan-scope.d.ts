export declare const MAESTRO_IGNORE_FILE = ".maestroignore";
export interface ScanScopeOptions {
    projectRoot: string;
    srcDir: string;
    excludeDirs?: string[];
    excludeFiles?: string[];
    createMaestroIgnore?: boolean;
}
export interface ScanScope {
    projectRoot: string;
    srcDir: string;
    ignores(absPath: string, isDirectory?: boolean): boolean;
}
export declare function buildScanScope(options: ScanScopeOptions): ScanScope;
