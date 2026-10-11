import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
/** Test-only recorder of Pi's actual composed TUI tree. No provider or execution hooks. */
export default function(pi: ExtensionAPI) {
 let screen: any; let timer: ReturnType<typeof setInterval> | undefined;
 const dir = process.env.PI_GRAPH_UI_CAPTURE_DIR;
 if (!dir) return;
 pi.on("session_start", (_event,ctx) => {
  ctx.ui.setWidget("graph-test-capture", (tui) => { screen=tui; return {render:()=>[],invalidate(){}}; });
  timer = setInterval(() => {
   if (!screen) return;
   // SDK 1.0.4 uses AltScreenTUI; its public frame includes active overlays.
   const lines = typeof screen.getScreenLines === "function" ? screen.getScreenLines() : screen.previousLines?.length ? screen.previousLines : screen.render(screen.terminal.columns);
   const text = lines.join("\n").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"");
   writeFileSync(join(dir,"screen.txt"),text);
   const registry=(globalThis as any)[Symbol.for("pi-graph.native-ui.v1")];
   writeFileSync(join(dir,"ownership.json"),JSON.stringify([...(registry?.values() ?? [])].map((o:any)=>({...o,asyncIds:[...o.asyncIds]}))));
  },250); timer.unref?.();
 });
 pi.on("session_shutdown",()=>{if(timer)clearInterval(timer);});
}
