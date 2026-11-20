import * as fs from "node:fs";
import * as path from "node:path";
import crossSpawn from "cross-spawn";
import { getPiHostMode } from "pi-maestro-settings-core/v1";
import { resolvePiAgentDirectory } from "../shared/agent-directory.ts";
import { getTeammateChildExtensions } from "./child-extensions.ts";
import { terminateProcessTreeByPid } from "./execution-infra.ts";

export interface NativeChildOptions {
  version?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  tools?: readonly string[];
  model?: string;
}

/** Probe the chosen executable, never the parent's imported SDK version. */
export async function probePiChildVersion(command: string, argsPrefix: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<string | undefined> {
  return await new Promise((resolve) => {
    let output = "";
    let settled = false;
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(command, [...argsPrefix, "--version"], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let reclaiming = false;
    const settle = (version?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stdout?.destroy();
      resolve(version && getPiHostMode(version) !== "unknown" ? version : undefined);
    };
    const reclaim = (): void => {
      if (settled || reclaiming) return;
      reclaiming = true;
      output = "";
      child.stdout?.removeAllListeners("data");
      child.stdout?.destroy();
      const pid = child.pid;
      if (!pid) {
        try { child.kill("SIGKILL"); } catch { /* process never started or already exited */ }
        settle();
        return;
      }
      void terminateProcessTreeByPid(pid, { graceMs: 1000, pollMs: 25 })
        .catch(() => {
          try { child.kill("SIGKILL"); } catch { /* bounded reclamation already exhausted */ }
        })
        .finally(() => settle());
    };
    const timer = setTimeout(reclaim, timeoutMs);
    timer.unref?.();
    child.once("error", () => settle());
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled || reclaiming) return;
      output += String(chunk);
      if (Buffer.byteLength(output) > 4096) reclaim();
    });
    child.once("close", (code) => {
      if (!reclaiming) settle(code === 0 ? output.trim() : undefined);
    });
  });
}

export function assertVirtualChildExtensionRegistered(selection: string | undefined, virtualModels: readonly string[] | undefined): boolean {
  if (!selection || !virtualModels?.includes(selection)) return false;
  const router = getTeammateChildExtensions().find((registration) => registration.virtualModels?.includes(selection));
  if (!router || !fs.existsSync(router.path)) {
    throw new Error(`Virtual model ${selection} cannot launch: no child-inheritable router extension. Register the router path and exact virtualModels in the child-extension registry.`);
  }
  return true;
}

export function assertVirtualChildRouter(selection: string | undefined, virtualModels: readonly string[] | undefined, childVersion: unknown): void {
  if (!assertVirtualChildExtensionRegistered(selection, virtualModels)) return;
  if (getPiHostMode(childVersion) !== "native") {
    throw new Error(`Virtual model ${selection} cannot launch: the selected child executable has no verified native virtual-router capability.`);
  }
}

function extensionSettings(file: string): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value.extensions) ? value.extensions.filter((item: unknown): item is string => typeof item === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read child extension settings ${file}`, { cause: error });
  }
}

/** Explicit opt-in compensates --no-extensions without overriding operator disables. */
export function nativeChildBuiltinArgs(options: NativeChildOptions): string[] {
  if (getPiHostMode(options.version) !== "native") return [];
  const agentDir = resolvePiAgentDirectory(options.env);
  const projectDir = path.join(options.cwd, ".pi");
  const globalSettings = extensionSettings(path.join(agentDir, "settings.json"));
  const projectSettings = extensionSettings(path.join(projectDir, "settings.json"));
  const overrides = (settings: readonly string[]) => settings.filter((value) => /^[!+-]/.test(value));
  const matches = (resource: string, pattern: string, base: string, exact: boolean) => {
    const normalized = pattern.replace(/^\.\//, "").replaceAll("\\", "/");
    const targets = [resource, path.relative(base, resource).replaceAll("\\", "/")];
    return exact ? targets.includes(normalized) : targets.some((target) => path.matchesGlob(target, normalized));
  };
  const enabled = (resource: string) => {
    // Pi project overrides are ordered; global force-exclude wins force-include.
    let projectEnabled: boolean | undefined;
    for (const entry of overrides(projectSettings)) {
      if (matches(resource, entry.slice(1), projectDir, entry[0] !== "!")) projectEnabled = entry[0] === "+";
    }
    if (projectEnabled !== undefined) return projectEnabled;
    const entries = overrides(globalSettings);
    if (entries.some((entry) => entry[0] === "-" && matches(resource, entry.slice(1), agentDir, true))) return false;
    if (entries.some((entry) => entry[0] === "+" && matches(resource, entry.slice(1), agentDir, true))) return true;
    return !entries.some((entry) => entry[0] === "!" && matches(resource, entry.slice(1), agentDir, false));
  };
  const allows = (tool: string) => !options.tools?.length || options.tools.includes(tool);
  const candidates = [
    ...(allows("codemode") ? ["codemode"] : []),
    ...(allows("tool_search") ? ["tool-search"] : []),
    ...(!options.tools?.length || options.tools.some((tool) => tool.startsWith("mcp__") || tool === "mcp") || allows("codemode") ? ["mcp"] : []),
    ...(options.model?.startsWith("llama.cpp/") ? ["llama.cpp"] : []),
  ];
  return candidates.filter((name) => enabled(`builtin:${name}`)).flatMap((name) => ["--extension", `builtin:${name}`]);
}
