/**
 * Prompt-optimize wiring.
 *
 * On demand (/prompt-enhance or Alt+Shift+P), the editor's draft prompt is routed
 * by the classifier (`prompt-route` domain: translate / format / polish),
 * rewritten by the configured model into an always-English optimized prompt
 * with codebase + knowledge context, then written back for review. Nothing
 * is submitted automatically; /prompt-enhance revert restores the pre-optimize
 * text.
 *
 * The `prompt-route` domain is registered here — its mode is governed by the
 * classifier extension (`/classifier mode prompt-route off|shadow|jev`), so
 * L0 rules decide by default and JEV adjudication is opt-in.
 *
 * Feature switch, optimize/translate models, thinking level, length cap and
 * context depth are configured independently through the API manager
 * (`/api-manager prompt-enhance` or the settings shell action `api.prompt-enhance`),
 * persisted in `api-manager.json` under the `optimize` section;
 * /prompt-enhance on|off toggles the feature.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, registerClassifyDomain } from "pi-maestro-teammate/v1/classify";
import { gatherEnhancerContext } from "../prompt-enhance/context.ts";
import { loadOptimizeConfig, saveOptimizeConfig, type OptimizeConfig } from "./config.ts";
import { promptRouteDomain, type PromptRoute } from "./domain.ts";
import { effectiveOptimizeModelRef, generateOptimizedPrompt } from "./engine.ts";

export interface PromptOptimizeOptions {
  /** api-manager.json path; the `optimize` section holds the config. */
  defaultsPath: string;
}

export function registerPromptOptimize(
  pi: ExtensionAPI,
  options: PromptOptimizeOptions,
): () => void {
  // lastOriginal = the editor snapshot captured right before optimization.
  // The empty-string sentinel distinguishes "optimized from inline arg,
  // editor was empty" from "nothing to revert" (undefined).
  let lastOriginal: string | undefined;

  registerClassifyDomain(promptRouteDomain);

  const runOptimize = async (ctx: ExtensionContext, providedText: string | undefined): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("提示词优化需要交互模式（它读写编辑器）。", "warning");
      return;
    }
    const config = await loadOptimizeConfig(options.defaultsPath);
    if (!config.enabled) {
      ctx.ui.notify("提示词优化已关闭（/prompt-enhance on 开启）。", "info");
      return;
    }

    const editorText = ctx.ui.getEditorText();
    const original = (providedText ?? editorText).trim();
    if (!original) {
      ctx.ui.notify("输入框为空，没有可优化的内容。", "info");
      return;
    }

    const route = await classify(promptRouteDomain, { text: original });
    const wantedRef = effectiveOptimizeModelRef(config, route.label);
    const resolved = resolveOptimizeModelForNotify(wantedRef, ctx);
    const usingFallback = wantedRef !== "session" && resolved !== wantedRef;
    ctx.ui.notify(
      `路由 ${route.label}（${route.layer}）· 正在用 ${modelLabelOf(resolved)} 优化提示词${usingFallback ? "（钉选模型未找到，已回退会话模型）" : ""}…`,
      "info",
    );
    const context = await gatherEnhancerContext(original, ctx.cwd, config, ctx.sessionManager);
    const result = await generateOptimizedPrompt(pi, ctx, config, original, route.label, context);
    if (result.kind !== "optimized") {
      ctx.ui.notify(`优化失败：${result.error ?? "未知错误"}`, "error");
      return;
    }

    // If the user typed while the LLM was working, the editor no longer
    // holds the snapshot we optimized from — abort the write rather than
    // clobber their new input (which revert could not restore).
    const nowEditor = ctx.ui.getEditorText();
    if (nowEditor !== editorText) {
      ctx.ui.notify("编辑器内容已变更，已放弃写入优化结果（未覆盖你的输入）。", "warning");
      return;
    }

    lastOriginal = editorText;
    ctx.ui.setEditorText(result.text);
    ctx.ui.notify("提示词已优化（/prompt-enhance revert 回退）。", "info");
  };

  pi.registerShortcut("alt+shift+p" as Parameters<ExtensionAPI["registerShortcut"]>[0], {
    description: "Optimize the current editor prompt (classify → translate/format → English output)",
    handler: async (ctx) => {
      await runOptimize(ctx, undefined);
    },
  });

  const commandHandler = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const [sub, ...rest] = args.trim().split(/\s+/);
    if (sub === "revert") {
      if (lastOriginal === undefined) {
        ctx.ui.notify("没有可回退的原文。", "info");
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.setEditorText(lastOriginal);
        ctx.ui.notify("已回退到优化前的提示词。", "info");
      }
      lastOriginal = undefined;
      return;
    }
    if (sub === "status") {
      const config = await loadOptimizeConfig(options.defaultsPath);
      ctx.ui.notify(
        `提示词优化：${config.enabled ? "已启用" : "已停用"} · 模型：${modelLabelOf(config.modelRef)} · 翻译模型：${translateModelLabel(config)} · 上下文：${config.contextDepth}（设置：/api-manager prompt-enhance）`,
        "info",
      );
      return;
    }
    if (sub === "on" || sub === "off") {
      const config = await loadOptimizeConfig(options.defaultsPath);
      config.enabled = sub === "on";
      await saveOptimizeConfig(config, options.defaultsPath);
      ctx.ui.notify(`提示词优化已${sub === "on" ? "启用" : "停用"}。`, "info");
      return;
    }
    if (sub === "route") {
      const text = rest.join(" ").trim();
      if (!text) {
        ctx.ui.notify("用法：/prompt-enhance route <文本>", "error");
        return;
      }
      const result = await classify(promptRouteDomain, { text });
      ctx.ui.notify(
        `[prompt-route] ${result.label} (layer=${result.layer}, confidence=${result.confidence.toFixed(2)}${result.model ? `, model=${result.model}` : ""}${result.degradedReason ? `, degraded=${result.degradedReason}` : ""})`,
        "info",
      );
      return;
    }
    // Default: optimize. Args may carry inline text; otherwise read the editor.
    const provided = args.trim() || undefined;
    await runOptimize(ctx, provided);
  };

  pi.registerCommand("prompt-enhance", {
    description: "Optimize the prompt in the editor (or supplied text) — always English output. Subcommands: revert | status | on | off | route <text>",
    handler: commandHandler,
  });
  // Backward-compat alias for the original /optimize spelling.
  pi.registerCommand("optimize", {
    description: "Alias of /prompt-enhance.",
    handler: commandHandler,
  });

  pi.on("session_shutdown", () => {
    lastOriginal = undefined;
  });

  return () => undefined;
}

/** Display label for the translate-route model setting. */
function translateModelLabel(config: OptimizeConfig): string {
  return config.translateModelRef === "same" ? "同优化模型" : modelLabelOf(config.translateModelRef);
}

function modelLabelOf(ref: string): string {
  return ref === "session" || !ref ? "会话模型" : ref;
}

/** Resolve the modelRef that will actually be used, for notify purposes. */
function resolveOptimizeModelForNotify(modelRef: string, ctx: ExtensionContext): string {
  const wanted = (modelRef ?? "session").trim();
  if (!wanted || wanted === "session") return "session";
  const allModels = typeof ctx.modelRegistry?.getAll === "function" ? ctx.modelRegistry.getAll() : [];
  const [provider, ...rest] = wanted.split("/");
  const modelId = rest.join("/");
  const exact = allModels.find((entry) => entry.provider === provider && entry.id === modelId);
  return exact ? wanted : "session";
}
