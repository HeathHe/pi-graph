import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalJson } from "../src/v3/digests.ts";
import { captureTrustedDirectoryAnchor, unsafeDirectoryComponent } from "../src/v3/path-safety.ts";
import { resolveSourceIdentityV3 } from "../src/v3/source-identity.ts";

export interface GraphProjectScopeV3 {
 readonly cwd: string;
 readonly explicit: boolean;
 assertUnchanged(): Promise<void>;
}

/** Explicit selection chooses one source root; it never changes the parent context or permissions. */
export async function graphProjectScopeV3(requested: unknown, parentCwd: string): Promise<GraphProjectScopeV3> {
 if (requested === undefined) return { cwd: parentCwd, explicit: false, async assertUnchanged() {} };
 if (typeof requested !== "string" || !requested.trim()) throw new Error("projectRoot must be a non-empty directory path.");
 const selected = resolve(parentCwd, requested);
 const identity = await resolveSourceIdentityV3(selected);
 const anchor = await captureTrustedDirectoryAnchor(identity.sourceCwd);
 const assertUnchanged = async (): Promise<void> => {
  if (await unsafeDirectoryComponent(identity.sourceCwd, anchor)) throw new Error("projectRoot directory identity changed during Graph admission.");
  const current = await resolveSourceIdentityV3(selected);
  if (canonicalJson(current) !== canonicalJson(identity) || await unsafeDirectoryComponent(identity.sourceCwd, anchor)) {
   throw new Error("projectRoot source identity changed during Graph admission.");
  }
 };
 await assertUnchanged();
 return Object.freeze({ cwd: identity.sourceCwd, explicit: true, assertUnchanged });
}

/** Keep canonical project identity in bounded receipts, even when a large snapshot is projected away. */
export function graphProjectReceiptV3(projectRoot?: string): Record<string, unknown> {
 if (projectRoot === undefined) return {};
 if (Buffer.byteLength(JSON.stringify(projectRoot)) <= 768) return { projectRoot };
 let prefix = "";
 for (const codepoint of projectRoot) {
  if (Buffer.byteLength(JSON.stringify(prefix + codepoint)) > 768) break;
  prefix += codepoint;
 }
 return { projectRoot: prefix + "…", projectRootTruncated: true, projectRootSha256: createHash("sha256").update(projectRoot).digest("hex") };
}
