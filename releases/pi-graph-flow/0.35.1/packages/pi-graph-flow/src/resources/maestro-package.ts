/** Host registration remains here; package/instruction resolution has one M11 owner. */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configurePackageResourceHost, configureTeammateAgentsDiscovery, resolveBundledAgentsPath, loadBundledAgentsInstructions, resolveOwnPackageJson } from "pi-graph-resources/instructions";
const require = createRequire(import.meta.url);
configurePackageResourceHost({ ownPackageJson: () => {
  try { return require.resolve("../../package.json"); } catch { return undefined; }
} });
export * from "pi-graph-resources/instructions";

export function registerMaestroPackageResources(
  pi: ExtensionAPI,
  packageJsonPath = resolveOwnPackageJson(),
): void {
  configureTeammateAgentsDiscovery(packageJsonPath);
  const agentsPath = resolveBundledAgentsPath(packageJsonPath);
  const agentsInstructions = loadBundledAgentsInstructions(agentsPath);

  if (agentsPath && agentsInstructions) {
    const path = agentsPath.replaceAll("\\", "/");
    const directory = dirname(agentsPath).replaceAll("\\", "/");
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n<project_instructions path="${path}" directory="${directory}">\n${agentsInstructions}\n</project_instructions>`,
    }));
  }
}
