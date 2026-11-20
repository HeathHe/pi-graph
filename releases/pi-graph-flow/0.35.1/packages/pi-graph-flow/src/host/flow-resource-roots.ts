import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Existing component injection ports. Values supplied by a Host always win. */
export interface FlowResourceRoots {
  lspConfigHomeDir?: string;
  modelFailoverStateHome?: string;
  chineseResponseStateHome?: string;
  notifyStateHome?: string;
  maestroDelegateConfigPath?: string;
}
export interface FlowResourceRootInput {
  /** SDK getAgentDir() result, only when PI_CODING_AGENT_DIR is explicitly nonempty. */
  agentDir?: string;
  maestroHome?: string;
  cwd: string;
  homeDir: string;
}

/** Resolve an explicit Maestro profile path relative to the current working directory. */
export function resolveFlowMaestroHome(
  maestroHome: string,
  cwd: string,
  homeDir: () => string,
): string {
  return resolve(cwd, maestroHome === "~" ? homeDir()
    : /^~[/\\]/.test(maestroHome) ? join(homeDir(), maestroHome.slice(2))
    : maestroHome.startsWith("file://") ? fileURLToPath(maestroHome)
    : maestroHome);
}

/** Pure path selection: no filesystem access, environment mutation or default HOME discovery. */
export function resolveFlowResourceRoots(
  assembly: FlowResourceRoots,
  input: FlowResourceRootInput,
): FlowResourceRoots {
  const profileHome = input.agentDir === undefined
    ? undefined : join(resolve(input.cwd, input.agentDir), "maestro-host-home");
  const maestroHome = input.maestroHome
    ? resolveFlowMaestroHome(input.maestroHome, input.cwd, () => input.homeDir)
    : undefined;
  return {
    lspConfigHomeDir: assembly.lspConfigHomeDir ?? profileHome,
    modelFailoverStateHome: assembly.modelFailoverStateHome ?? profileHome,
    chineseResponseStateHome: assembly.chineseResponseStateHome ?? profileHome,
    notifyStateHome: assembly.notifyStateHome ?? profileHome,
    maestroDelegateConfigPath: assembly.maestroDelegateConfigPath
      ?? (maestroHome === undefined
        ? profileHome === undefined ? undefined : join(profileHome, ".maestro", "cli-tools.json")
        : join(maestroHome, "cli-tools.json")),
  };
}
