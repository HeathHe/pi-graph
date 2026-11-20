import { FabricContractError } from "pi-maestro-fabric-core/v1";
import type { FabricArtifactService } from "../gateway/fabric/artifact-service.ts";

/** URI scheme served by the resource dispatcher for Fabric artifacts. */
export const FABRIC_ARTIFACT_SCHEME = "artifact";

/** Short-lived host lease. Release fences use; it does not claim I/O drained. */
export interface FabricArtifactResourceLease {
  service: FabricArtifactService;
  assertCurrent(): void;
  verify(): Promise<void>;
  release(): void;
}

export function parseArtifactResourceId(uri: string, segments: readonly string[]): string {
  if (segments.length !== 1 || !segments[0] || !/^artifact:\/\/[^/]+$/i.test(uri))
    throw new FabricContractError("invalid_argument", "Expected artifact://<artifactId> as one encoded segment.");
  let id: string;
  try { id = decodeURIComponent(segments[0]); }
  catch { throw new FabricContractError("invalid_argument", "Invalid artifact URI encoding."); }
  if (encodeURIComponent(id) !== segments[0])
    throw new FabricContractError("invalid_argument", "Artifact id must be encoded as one canonical URI segment.");
  return id;
}

export interface FabricArtifactResourceOptions {
  service: FabricArtifactService;
}

/**
 * `artifact://<artifactId>` — the artifact's identity and current state.
 *
 * Deliberately metadata only: an artifact body is large and belongs at its
 * source, so fetching bytes is an explicit-destination download rather than a
 * resource read. This read never mutates anything, and a resume that restores
 * the bytes of an interrupted transfer restores a read, never a mutation.
 */
export async function resolveFabricArtifactResource(
  uri: string,
  segments: readonly string[],
  options: FabricArtifactResourceOptions,
): Promise<{ content: string; title: string; cached: boolean }> {
  const artifactId = parseArtifactResourceId(uri, segments);
  const view = await options.service.inspect(artifactId);
  return {
    content: JSON.stringify(view, null, 2),
    title: `artifact://${encodeURIComponent(artifactId)}`,
    cached: false,
  };
}
