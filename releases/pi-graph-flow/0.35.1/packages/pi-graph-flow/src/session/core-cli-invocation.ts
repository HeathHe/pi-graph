import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export interface CoreCliInvocation {
  executable: string;
  args: string[];
  kind: "explicit" | "legacy" | "bundled-compatible";
}
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, file: string): boolean => file.startsWith(root + sep);

/** Public CLI args remain untouched; only the physical executable/argv is selected here. */
export function resolveCoreCliInvocation(
  args: readonly string[], packageRoot: string, explicitExecutable?: string,
): CoreCliInvocation {
  if (explicitExecutable !== undefined) return { executable: explicitExecutable, args: [...args], kind: "explicit" };
  const legacy = (): CoreCliInvocation => ({ executable: process.platform === "win32" ? "maestro.cmd" : "maestro", args: [...args], kind: "legacy" });
  const recordPath = resolve(packageRoot, "node_modules/maestro-flow/dist/compatibility-patches.json");
  try { lstatSync(recordPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return legacy();
    throw error;
  }
  // A present record commits to local compatibility: never silently run a global CLI.
  const root = realpathSync(packageRoot);
  const core = realpathSync(resolve(packageRoot, "node_modules/maestro-flow"));
  if (!inside(root, core)) throw new Error("Compatible Core escapes the Pi package");
  const checked = (relative: string): string => {
    const lexical = resolve(core, relative), actual = realpathSync(lexical);
    if (!inside(core, lexical) || !inside(core, actual) || !lstatSync(actual).isFile()) throw new Error("Compatible Core file escapes its package");
    return actual;
  };
  const manifestPath = realpathSync(resolve(root, "scripts/core-compatibility-manifest.json"));
  if (!inside(root, manifestPath) || !lstatSync(manifestPath).isFile()) throw new Error("Core compatibility manifest escapes the Pi package");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema !== 1 || manifest.packageName !== "maestro-flow" || typeof manifest.patchId !== "string" || !manifest.patchId || manifest.runtimePath !== "dist/src/run/runtime.js" || manifest.binPath !== "bin/maestro.js") throw new Error("Unknown Core compatibility manifest");
  const identity = {
    patchId: manifest.patchId, originalVersion: manifest.originalVersion,
    metadataSHA256: manifest.metadataSHA256, beforeSHA256: manifest.beforeSHA256,
    afterSHA256: manifest.afterSHA256, runtimePath: manifest.runtimePath,
    manifestSHA256: hash(manifestBytes), license: manifest.license,
    binPath: manifest.binPath, binSHA256: manifest.binSHA256,
  };
  const expectedRecord = JSON.stringify({ schema: 1, patches: [identity] }, null, 2) + "\n";
  if (readFileSync(checked("dist/compatibility-patches.json"), "utf8") !== expectedRecord) throw new Error("Unknown Core compatibility identity");
  const metadataBytes = readFileSync(checked("package.json"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const bin = checked(manifest.binPath);
  if (metadata.name !== manifest.packageName || metadata.version !== manifest.originalVersion || metadata.bin?.maestro !== manifest.binPath || hash(metadataBytes) !== manifest.metadataSHA256 || hash(readFileSync(checked(manifest.runtimePath))) !== manifest.afterSHA256 || hash(readFileSync(bin)) !== manifest.binSHA256) throw new Error("Core compatibility content mismatch");
  return { executable: process.execPath, args: [bin, ...args], kind: "bundled-compatible" };
}
