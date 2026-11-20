/** Per-operation adapter; the original Plan owner remains the only authority. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FabricArtifactService, type FabricArtifactReader } from "./artifact-service.ts";
import { acquireCurrentPlanArtifact } from "../../tools/plan.ts";
import type { FabricArtifactResourceLease } from "../../tools/artifact-resource.ts";

export async function acquirePlanArtifactResource(ctx: ExtensionContext, artifactId: string, signal?: AbortSignal): Promise<FabricArtifactResourceLease> {
  const read = await acquireCurrentPlanArtifact(ctx, artifactId, signal);
  try {
    read.assertCurrent();
    // path is an opaque identifier required by the old Reader contract, never a
    // filesystem path. This adapter never feeds it to a file source.
    const entry = Object.freeze({ artifactId: read.artifactId, path: read.artifactId });
    const source: FabricArtifactReader = {
      async manifestOf(requested) {
        read.assertCurrent();
        if (requested !== entry) throw new Error("Artifact entry is outside this Plan read.");
        const metadata = await read.metadata();
        read.assertCurrent();
        return metadata;
      },
      async read() { throw new Error("Current Plan resource capability serves metadata only."); },
    };
    return Object.freeze({
      service: new FabricArtifactService({ source, entries: [entry] }),
      assertCurrent: read.assertCurrent,
      verify: read.verify,
      release: read.release,
    });
  } catch (error) { read.release(); throw error; }
}
