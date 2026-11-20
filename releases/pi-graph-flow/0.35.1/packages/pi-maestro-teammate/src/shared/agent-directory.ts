import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolvePiAgentDirectory(
  env: { PI_CODING_AGENT_DIR?: string } = process.env,
  homeDirectory = homedir(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homeDirectory, ".pi", "agent");
  if (configured === "~") return homeDirectory;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homeDirectory, configured.slice(2));
  }
  return resolve(configured);
}

/** Explicit agent profiles own their Teammate state; default profiles retain the legacy layout. */
export function resolveTeammateStateRoot(
  env: { PI_CODING_AGENT_DIR?: string } = process.env,
  homeDirectory = homedir(),
): string {
  if (!env.PI_CODING_AGENT_DIR?.trim()) return join(homeDirectory, ".pi", "teammate");
  return join(resolvePiAgentDirectory(env, homeDirectory), "teammate");
}
