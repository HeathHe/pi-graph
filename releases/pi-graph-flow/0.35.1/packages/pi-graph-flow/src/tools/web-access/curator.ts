import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCuratorHost, type CuratorHost, type CuratorHostOptions } from "./curator-host.ts";

/** One controller per Root registration; no process-global Curator session. */
export function registerCuratorCommands(pi: ExtensionAPI, options?: CuratorHostOptions): CuratorHost | undefined {
  const host = options ? createCuratorHost(pi, options) : undefined;
  const requireHost = (): CuratorHost => { if (!host) throw new Error("Curator Root Host is not configured"); return host; };
  pi.registerCommand("websearch", {
    description: "Open Curator or read sealed source history: /websearch history [collection-id]",
    async handler(args, ctx) {
      const value = args.trim();
      if (value === "history" || value.startsWith("history ")) {
        ctx.ui.notify(JSON.stringify(requireHost().history(ctx, value.slice(7).trim() || undefined), null, 2), "info");
        return;
      }
      await requireHost().open(ctx, value || undefined);
    },
  });
  pi.registerCommand("curator", {
    description: "Open or close the Root's Curator (on/off)",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action === "off") { requireHost().close(); ctx.ui.notify("Curator closed; no partial results were sent", "info"); }
      else if (action === "on" || action === "") await requireHost().open(ctx);
      else ctx.ui.notify("Usage: /curator [on|off]", "warning");
    },
  });
  return host;
}
