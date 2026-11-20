/** Selected-entry capability owned by the original Plan coordinator, never a store grant. */
import { createHash } from "node:crypto";
import type { PlanArtifactEntry } from "../tools/plan-store.ts";
import type { PlanState } from "./state.ts";
import type { PlanContext } from "./types.ts";

export interface PlanArtifactMetadata {
  artifactId: string;
  byteLength: number;
  digest: string;
  contentIdentity: string;
}
export interface PlanArtifactRead {
  readonly artifactId: string;
  assertCurrent(): void;
  metadata(): Promise<PlanArtifactMetadata>;
  verify(): Promise<void>;
  release(): void;
}
const fingerprint = (entry: PlanArtifactEntry) => JSON.stringify([entry.id, entry.kind, entry.revision, entry.checksum, entry.createdAt, entry.path]);

export async function acquirePlanArtifactRead(state: PlanState, ctx: PlanContext, artifactId: string, signal?: AbortSignal): Promise<PlanArtifactRead> {
  const read = state.captureArtifactRead(ctx);
  const contextSignal = ctx.signal;
  let released = false;
  const assertCurrent = () => {
    if (released || signal?.aborted || contextSignal?.aborted || ctx.signal !== contextSignal || !state.isCurrentArtifactRead(ctx, read))
      throw new Error("Current Plan artifact read was cancelled or superseded.");
  };
  const release = () => { released = true; };
  try {
    assertCurrent();
    const initial = await read.identity.store.readArtifactSnapshotReadOnly(artifactId, assertCurrent);
    assertCurrent();
    const selected = initial.entry;
    const sourceIdentity = initial.sourceIdentity;
    const selectedIdentity = fingerprint(selected);
    const snapshot = async () => {
      assertCurrent();
      const current = await read.identity.store.readArtifactSnapshotReadOnly(artifactId, assertCurrent, sourceIdentity);
      assertCurrent();
      if (current.sourceIdentity !== sourceIdentity || fingerprint(current.entry) !== selectedIdentity)
        throw new Error("Current Plan artifact entry changed.");
      return current;
    };
    const verify = async () => { await snapshot(); assertCurrent(); };
    return Object.freeze({ artifactId: selected.id, assertCurrent, release, verify,
      async metadata() {
        try {
          // This original-owner method is pure read: no recovering load/list or
          // chmod-bearing legacy readArtifact. Its callback fences each await.
          const { markdown } = await snapshot();
          assertCurrent();
          const byteLength = Buffer.byteLength(markdown, "utf8");
          const digest = createHash("sha256").update(markdown, "utf8").digest("hex");
          if (digest !== selected.checksum) throw new Error("Current Plan artifact checksum changed.");
          // Opaque source+generation+entry binding. Ordinary journal appends
          // do not change content identity; branch authority is checked separately.
          const contentIdentity = createHash("sha256").update(JSON.stringify([
            read.identity.storeKey, read.identity.lifecycleGeneration, read.epoch,
            sourceIdentity, selectedIdentity, byteLength, digest,
          ])).digest("hex");
          assertCurrent();
          return { artifactId: selected.id, byteLength, digest, contentIdentity };
        } catch {
          // Filesystem errors can contain absolute paths. Never publish them.
          throw new Error("Current Plan artifact metadata is unavailable or superseded.");
        }
      },
    });
  } catch {
    release();
    throw new Error("Current Plan artifact source is unavailable or superseded.");
  }
}
