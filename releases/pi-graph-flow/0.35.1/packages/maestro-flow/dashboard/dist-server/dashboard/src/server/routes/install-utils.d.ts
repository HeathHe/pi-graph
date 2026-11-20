import { createManifest, saveManifest, findManifest, getAllManifests, type Manifest, type ManifestEntry } from '../../../../src/core/manifest.js';
import { injectDocFile } from '../../../../src/core/tag-injector.js';
import { COMPONENT_DEFS, type ComponentDef } from '../../../../src/core/component-defs.js';
import { scanDisabledItems, restoreDisabledState, type DisabledItem } from '../../../../src/commands/install-backend.js';
export { createManifest, saveManifest, findManifest, getAllManifests, injectDocFile };
export { scanDisabledItems, restoreDisabledState };
export type { Manifest, ManifestEntry, DisabledItem };
export interface ComponentInfo {
    id: string;
    label: string;
    sourceDir: string;
    targetDir: string;
    fileCount: number;
    available: boolean;
}
export interface DetectionResult {
    sourceDir: string;
    components: ComponentInfo[];
    existingManifest: Manifest | null;
    disabledItems: DisabledItem[];
}
export interface InstallResult {
    success: boolean;
    filesInstalled: number;
    dirsCreated: number;
    manifestPath: string;
    disabledItemsRestored: number;
    mcpRegistered: boolean;
    components: string[];
    error?: string;
    migrationWarnings?: string[];
}
declare const MAESTRO_HOME: string;
export declare function resolveSourceDir(startDir: string): string | null;
export declare function scanAvailableSources(sourceDir: string, mode: 'global' | 'project', projectPath?: string): ComponentInfo[];
export declare function copyDirectory(src: string, dest: string, manifest: Manifest, fileFilter?: (name: string) => boolean): {
    files: number;
    dirs: number;
};
export declare function createBackup(manifest: Manifest): string | null;
export declare function getPackageVersion(sourceDir: string): string;
export declare function writeVersionFile(targetDir: string, version: string): void;
export { COMPONENT_DEFS, MAESTRO_HOME };
export type { ComponentDef };
