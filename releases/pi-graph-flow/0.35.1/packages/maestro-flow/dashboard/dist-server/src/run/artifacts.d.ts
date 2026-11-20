import { type Artifact } from './schemas.js';
import type { CommandContract } from './contract.js';
export interface DiscoveredArtifact {
    absolutePath: string;
    relativePath: string;
    kind: string;
    schemaVersion: string;
    role: Artifact['role'];
    alias?: string;
    mediaType: string;
    contentHash: string;
    size: number;
    warning?: string;
}
export interface ArtifactScanResult {
    artifacts: DiscoveredArtifact[];
    warnings: string[];
    errors: string[];
}
export interface ArtifactScanHooks {
    afterFileInspection?: (path: string) => void;
}
export interface StrictArtifactValidationOptions {
    skipArtifactMetadataValidation?: boolean;
}
export interface ArtifactContractReport {
    declared: Array<{
        path: string | null;
        kind: string;
        schema: string | null;
        role: string;
        required: boolean;
        alias: string | null;
    }>;
    observed: Array<{
        path: string;
        kind: string;
        schema: string;
        role: string;
        alias: string | null;
    }>;
    missing: string[];
    mismatches: string[];
    unexpected: string[];
    errors: string[];
    warnings: string[];
}
export interface VerifiedContainedFile {
    data: Buffer;
    canonicalPath: string;
    contentHash: string;
    size: number;
}
/**
 * Read one regular file through the same descriptor and containment fences used
 * by artifact scanning. Relative inputs are resolved from `root`; absolute
 * inputs are accepted only when their canonical path remains inside `root`.
 */
export declare function readVerifiedContainedFile(root: string, inputPath: string, hooks?: ArtifactScanHooks): VerifiedContainedFile;
export declare function hashFile(path: string): {
    hash: string;
    size: number;
};
/**
 * Read one file with the same verified fd/fstat/realpath containment fence as
 * artifact scans: the path must resolve to a regular file directly inside its
 * canonical parent, the opened descriptor must match the inspected identity,
 * and the bytes must be stable across the read. Returns the content plus its
 * plain sha256 hex digest.
 */
export declare function readContainedFile(path: string): {
    data: Buffer;
    hash: string;
};
export declare function hashDirectory(path: string): {
    hash: string;
    size: number;
};
export declare function declaredPathMatches(declaredPath: string, outputRelative: string): boolean;
export declare function defaultArtifactAlias(kind: string, command: string): string | undefined;
export declare function evaluateArtifactContract(runDir: string, contract: CommandContract, scan: ArtifactScanResult, options?: StrictArtifactValidationOptions): ArtifactContractReport;
export declare function validateStrictArtifactContract(runDir: string, contract: CommandContract, scan: ArtifactScanResult, options?: StrictArtifactValidationOptions): void;
export declare function scanOutputs(runDir: string, sessionDir: string, contract: CommandContract, hooks?: ArtifactScanHooks): ArtifactScanResult;
