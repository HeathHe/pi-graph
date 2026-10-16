import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import captureNativeUi from "./native-ui-capture.ts";

/** Test-only public parent lifecycle evidence; no provider or execution hooks. */
export default function captureEscapeUi(pi: ExtensionAPI): void {
 captureNativeUi(pi);
 const dir = process.env.PI_GRAPH_UI_CAPTURE_DIR;
 if (!dir) return;
 let starts = 0, ends = 0;
 const activeTools = new Map<string,string>();
 let timer: ReturnType<typeof setInterval> | undefined;
 const record = (ctx: ExtensionContext): void => {
  try {
   writeFileSync(join(dir, "parent-agent.json"), JSON.stringify({
    starts, ends, activeTools: [...activeTools.values()], isIdle: ctx.isIdle(), hasSignal: !!ctx.signal, updatedAt: Date.now(),
   }));
  } catch { /* A reload can invalidate the previous extension context. */ }
 };
 pi.on("session_start", (_event, ctx) => {
  record(ctx);
  timer = setInterval(() => record(ctx), 50); timer.unref?.();
 });
 pi.on("agent_start", (_event, ctx) => { starts += 1; activeTools.clear(); record(ctx); });
 pi.on("tool_execution_start", (event, ctx) => { activeTools.set(event.toolCallId,event.toolName); record(ctx); });
 pi.on("tool_execution_end", (event, ctx) => { activeTools.delete(event.toolCallId); record(ctx); });
 pi.on("agent_end", (_event, ctx) => { ends += 1; activeTools.clear(); record(ctx); });
 pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; });
}
