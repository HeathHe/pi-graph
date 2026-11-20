import { getPiHostMode } from "pi-maestro-settings-core/v1";

const controls = new Set([
  "structured_output", "teammate", "teammate-send", "teammate-list", "observe",
  "teammate-watch", "teammate-wait", "teammate-monitor", "monitor",
  "workspace-window", "remote-worker",
]);

/** Never pass new exposure metadata to legacy hosts. */
export function modelOnlyControlTool<T extends { name: string }>(tool: T, version: unknown): T {
  return getPiHostMode(version) === "native" && controls.has(tool.name)
    ? { ...tool, exposure: "model-only" }
    : tool;
}
