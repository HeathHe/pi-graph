/** Host composition facade. M11 owns discovery; anchors remain this original package's. */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { configureAgentResourceHost } from "pi-graph-resources/agents";
import { resolvePiAgentDirectory } from "../shared/agent-directory.ts";
import { parseTeammateTaskType } from "../shared/task-types.ts";
configureAgentResourceHost({
  builtinAgentsDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents"),
  packageSearchStart: path.dirname(fileURLToPath(import.meta.url)),
  homeDir: () => os.homedir(),
  profileAgentDir(homeDir) {
    // Existing host-provided home roots and the standard profile retain the legacy catalog.
    if (path.resolve(homeDir) !== path.resolve(os.homedir()) || !process.env.PI_CODING_AGENT_DIR?.trim()) return;
    const agentDir = resolvePiAgentDirectory(process.env, homeDir);
    if (agentDir !== path.resolve(homeDir, ".pi", "agent")) return agentDir;
  },
  packageAgentsOverride: () => process.env.PI_TEAMMATE_PACKAGE_AGENTS_DIR,
  parseTaskType: parseTeammateTaskType,
});
export * from "pi-graph-resources/agents";
