import type { ToolRegistry } from './tool-registry.js';
export declare class ExtensionLoader {
    private registry;
    private loaded;
    constructor(registry: ToolRegistry);
    loadFromDir(dir: string): Promise<void>;
    loadExtension(extPath: string): Promise<void>;
    unloadAll(): Promise<void>;
    listLoaded(): string[];
}
//# sourceMappingURL=extension-loader.d.ts.map