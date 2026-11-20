export interface FrameworkResolver {
    name: string;
    language: string;
    detect(files: string[]): boolean;
    resolve?(nodes: Array<{
        id: string;
        name: string;
        filePath: string;
    }>): Array<{
        source: string;
        target: string;
        kind: string;
    }>;
}
export declare function getRegisteredFrameworks(): FrameworkResolver[];
export declare function detectFrameworks(files: string[]): string[];
export declare function getFrameworkResolver(name: string): FrameworkResolver | null;
//# sourceMappingURL=index.d.ts.map