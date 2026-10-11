import { lstat, readFile } from "node:fs/promises";

export async function readSupervisionJson(file: string, cap = 4 * 1024 * 1024): Promise<Record<string, unknown> | undefined> {
 try {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > cap) return undefined;
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
 } catch { return undefined; }
}
export function confirmedProcessExit(raw: Record<string, unknown> | undefined, id: string, runner?: string): boolean {
 if (!raw || raw.version !== 1 || raw.state !== "observed" || raw.runId !== id || typeof raw.runnerProcessInstanceId !== "string" || (runner && raw.runnerProcessInstanceId !== runner) || !Number.isFinite(raw.observedAt)) return false;
 const instances = raw.instances;
 if (!Array.isArray(instances)) return false;
 const parent = instances.find(v => v?.kind === "runner" && v.processInstanceId === raw.runnerProcessInstanceId);
 if (!parent || !Number.isFinite(parent.closeObservedAt) || (typeof parent.exitCode !== "number" && parent.exitCode !== null) || (typeof parent.signal !== "string" && parent.signal !== null)) return false;
 return instances.every(v => v.kind === "runner" || (v.kind === "pi-writer" && Number.isFinite(v.closeObservedAt) && v.processTree?.state === "observed"));
}
