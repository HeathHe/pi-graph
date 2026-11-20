/** Shared original UiSession policies, without a connection manager or global viewer state. */
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletedUiSession, SendMessageFn } from "./state.ts";
import { parseUiPromptHandoff, extractUiPromptText, type UiMessageParams, type UiModelContextParams } from "./types.ts";
import type { UiServerHandle } from "./ui-server.ts";
import { isGlimpseAvailable, openGlimpseWindow } from "./glimpse-ui.ts";
import { logger } from "./logger.ts";

export interface UiSessionPolicyHost {
  sendMessage?: SendMessageFn;
  ui?: Pick<ExtensionContext["ui"], "notify">;
  completedUiSessions: CompletedUiSession[];
}
export interface UiSessionPolicyRequest { serverName: string; toolName: string }
const MAX_COMPLETED_SESSIONS = 10;
export function onUiSessionMessage(state: UiSessionPolicyHost, request: UiSessionPolicyRequest, params: UiMessageParams): void {
  const log = logger.child({ component: "UiSession", server: request.serverName, tool: request.toolName });
        const prompt = extractUiPromptText(params);
        if (prompt) {
          if (state.sendMessage) {
            state.sendMessage(
              {
                customType: "mcp-ui-prompt",
                content: [{ type: "text", text: `User sent prompt from ${request.serverName} UI: "${prompt}"` }],
                display: `💬 UI Prompt: ${prompt}`,
                details: { server: request.serverName, tool: request.toolName, prompt },
              },
              { triggerTurn: true },
            );
            log.debug("Triggered agent turn for UI prompt", { prompt: prompt.slice(0, 50) });
          }
        } else if (params.type === "intent" || params.intent) {
          const intent = params.intent ?? "";
          const intentParams = params.params;
          if (intent && state.sendMessage) {
            const paramsStr = intentParams ? ` ${JSON.stringify(intentParams)}` : "";
            state.sendMessage(
              {
                customType: "mcp-ui-intent",
                content: [{ type: "text", text: `User triggered intent from ${request.serverName} UI: ${intent}${paramsStr}` }],
                display: `🎯 UI Intent: ${intent}`,
                details: { server: request.serverName, tool: request.toolName, intent, params: intentParams },
              },
              { triggerTurn: true },
            );
            log.debug("Triggered agent turn for UI intent", { intent });
          }
        } else if (params.type === "notify" || params.message) {
          const text = params.message ?? "";
          if (text && state.ui) {
            state.ui.notify(`[${request.serverName}] ${text}`, "info");
          }
        }
}
export function onUiSessionContext(request: UiSessionPolicyRequest, params: UiModelContextParams): void {
  const log = logger.child({ component: "UiSession", server: request.serverName, tool: request.toolName });
        log.debug("Model context update from UI", {
          hasContent: !!params.content,
          hasStructured: !!params.structuredContent,
        });
}
export function retainCompletedUiSession(state: UiSessionPolicyHost, completedHandle: UiServerHandle, reason: string): void {
  const log = logger.child({ component: "UiSession", server: completedHandle.serverName, tool: completedHandle.toolName });
          const messages = completedHandle.getSessionMessages();
          const stream = completedHandle.getStreamSummary();
          const hasContent =
            messages.prompts.length > 0 ||
            messages.intents.length > 0 ||
            messages.notifications.length > 0 ||
            !!stream;

          if (hasContent) {
            state.completedUiSessions.push({
              serverName: completedHandle.serverName,
              toolName: completedHandle.toolName,
              completedAt: new Date(),
              reason,
              messages,
              stream,
            });

            while (state.completedUiSessions.length > MAX_COMPLETED_SESSIONS) {
              state.completedUiSessions.shift();
            }

            log.debug("Session completed", {
              reason,
              prompts: messages.prompts.length,
              intents: messages.intents.length,
              notifications: messages.notifications.length,
              retainedBytes: messages.retention?.retainedBytes ?? 0,
              droppedItems: messages.retention?.droppedItems ?? 0,
              truncatedItems: messages.retention?.truncatedItems ?? 0,
              streamFrames: stream?.frames ?? 0,
            });
          }

}

export interface UiViewerHandle { close(): void }
export interface UiViewerContext {
  serverName: string;
  toolName: string;
  current(): boolean;
  onClosed(): void;
  notify(message: string, type: "warning" | "info"): void;
}
/** Original Glimpse preference/browser fallback, with state owned by the calling Host. */
export async function openUiSessionViewer(url: string, context: UiViewerContext, openBrowser: (url: string) => Promise<void>): Promise<UiViewerHandle | undefined> {
  const log = logger.child({ component: "UiSession", server: context.serverName, tool: context.toolName });
  const assertCurrent = () => { if (!context.current()) throw new Error("UI viewer is retired"); };
  const browser = async () => {
    assertCurrent();
    try { await openBrowser(url); assertCurrent(); }
    catch (error) {
      assertCurrent();
      const message = error instanceof Error ? error.message : String(error);
      context.notify(`MCP UI browser open failed: ${message}`, "warning");
      assertCurrent(); context.notify(`Open manually: ${url}`, "info");
    }
  };
  assertCurrent();
  const glimpseDetected = isGlimpseAvailable();
  const viewerPref = process.env.MCP_UI_VIEWER?.toLowerCase();
  const useGlimpse = viewerPref === "glimpse" || (viewerPref !== "browser" && glimpseDetected);
  if (useGlimpse) {
    try {
      const glimpseHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;width:100vw;height:100vh;overflow:hidden}iframe{width:100%;height:100%;border:none}</style></head><body><iframe src="${url}"></iframe></body></html>`;
      assertCurrent();
      const viewer = await openGlimpseWindow(glimpseHtml, {
        title: `MCP · ${context.serverName} · ${context.toolName}`, width: 1000, height: 800,
        onClosed: () => { if (context.current()) context.onClosed(); },
      });
      if (!context.current()) { viewer.close(); throw new Error("UI viewer is retired"); }
      return viewer;
    } catch (error) {
      assertCurrent();
      log.debug("Glimpse unavailable, using browser", { error: error instanceof Error ? error.message : String(error) });
      await browser(); assertCurrent();
    }
  } else { await browser(); assertCurrent(); }
  return undefined;
}

/** Original mcp({action:"ui-messages"}) formatter and drain; no manager dependency. */
export function executeUiMessages(state: Pick<UiSessionPolicyHost, "completedUiSessions">): AgentToolResult<Record<string, unknown>> {
  const sessions = state.completedUiSessions;

  if (sessions.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No UI session messages available." }],
      details: { sessions: 0 },
    };
  }

  const output: string[] = [];
  output.push(`UI Session Messages (${sessions.length} session${sessions.length > 1 ? "s" : ""}):\n`);

  const allPrompts: string[] = [];
  const allIntents = sessions.flatMap((session) => session.messages.intents);
  const parsedHandoffs: Array<{ intent: string; params: Record<string, unknown>; raw: string }> = [];

  for (const session of sessions) {
    const timestamp = session.completedAt.toLocaleTimeString();
    output.push(`\n## ${session.serverName} / ${session.toolName} (${timestamp}, ${session.reason})`);

    const plainPrompts: string[] = [];
    for (const prompt of session.messages.prompts) {
      allPrompts.push(prompt);
      const handoff = parseUiPromptHandoff(prompt);
      if (handoff) {
        parsedHandoffs.push(handoff);
      } else {
        plainPrompts.push(prompt);
      }
    }

    if (plainPrompts.length > 0) {
      output.push("\n### Prompts:");
      for (const prompt of plainPrompts) {
        output.push(`- ${prompt}`);
      }
    }

    const intentsForSession = [
      ...session.messages.intents,
      ...session.messages.prompts
        .map((prompt) => parseUiPromptHandoff(prompt))
        .filter((handoff): handoff is NonNullable<typeof handoff> => !!handoff)
        .map((handoff) => ({ intent: handoff.intent, params: handoff.params })),
    ];

    if (intentsForSession.length > 0) {
      output.push("\n### Intents:");
      for (const intent of intentsForSession) {
        const params = intent.params ? ` (${JSON.stringify(intent.params)})` : "";
        output.push(`- ${intent.intent}${params}`);
      }
    }

    if (session.messages.notifications.length > 0) {
      output.push("\n### Notifications:");
      for (const notification of session.messages.notifications) {
        output.push(`- ${notification}`);
      }
    }
  }

  const count = sessions.length;
  state.completedUiSessions = [];

  return {
    content: [{ type: "text" as const, text: output.join("\n") }],
    details: {
      sessions: count,
      prompts: allPrompts,
      intents: [...allIntents, ...parsedHandoffs.map(({ intent, params }) => ({ intent, params }))],
      handoffs: parsedHandoffs,
      cleared: true,
    },
  };
}
