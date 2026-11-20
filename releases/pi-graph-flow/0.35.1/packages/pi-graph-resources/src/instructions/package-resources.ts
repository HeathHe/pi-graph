import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PackageResourceHost { ownPackageJson(): string | undefined }
let host: PackageResourceHost | undefined;
export function configurePackageResourceHost(value: PackageResourceHost): void { host = Object.freeze({ ...value }); }
export function resolveOwnPackageJson(): string | undefined {
  if (!host) throw new Error("Package resource host is not configured");
  return host.ownPackageJson();
}

function resolveWorkspaceRoot(packageDir: string): string | undefined {
  let current = dirname(packageDir);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      if (Array.isArray(manifest.workspaces)) return current;
    } catch {
      // Keep walking until the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolvePackageOrWorkspaceResource(
  segments: readonly string[],
  packageJsonPath = resolveOwnPackageJson(),
): string | undefined {
  if (!packageJsonPath) return undefined;
  const packageDir = dirname(packageJsonPath);
  const packaged = join(packageDir, ...segments);
  if (existsSync(packaged)) return packaged;

  const workspaceRoot = resolveWorkspaceRoot(packageDir);
  if (!workspaceRoot) return undefined;
  const workspaceResource = join(workspaceRoot, ...segments);
  return existsSync(workspaceResource) ? workspaceResource : undefined;
}

export function configureTeammateAgentsDiscovery(
  packageJsonPath = resolveOwnPackageJson(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.PI_TEAMMATE_PACKAGE_AGENTS_DIR !== undefined) {
    return env.PI_TEAMMATE_PACKAGE_AGENTS_DIR;
  }
  const agentsDir = resolvePackageOrWorkspaceResource([".pi", "agents"], packageJsonPath);
  if (agentsDir) env.PI_TEAMMATE_PACKAGE_AGENTS_DIR = agentsDir;
  return agentsDir;
}

export function resolveBundledAgentsPath(
  packageJsonPath = resolveOwnPackageJson(),
): string | undefined {
  if (!packageJsonPath) return undefined;

  const pkgDir = dirname(packageJsonPath);

  // Prefer .pi/SYSTEM.md (canonical location after packaging);
  // fall back to AGENTS.md at the package root for backward compat.
  const systemMd = join(pkgDir, ".pi", "SYSTEM.md");
  if (existsSync(systemMd)) return systemMd;

  const agentsPath = join(pkgDir, "AGENTS.md");
  return existsSync(agentsPath) ? agentsPath : undefined;
}

export function loadBundledAgentsInstructions(
  agentsPath = resolveBundledAgentsPath(),
): string | undefined {
  if (!agentsPath) return undefined;

  const content = readFileSync(agentsPath, "utf8").trim();
  return content || undefined;
}

