import { VERSION, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { type JsonValue, type SettingsSnapshot, type SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { supportsCustomOverlay } from "pi-maestro-settings-core/ui";
import { DecisionPolicySchema, type DecisionPolicy } from "../decision-policy/config.ts";
import { openDecisionPolicyPanel } from "../decision-policy/extension.ts";
import { classifierStatus, listClassifyDomains } from "pi-maestro-teammate/v1/classify";
import { applyHandoffAdvice, listHandoffAdviceTasks, previewHandoffAdvice, type HandoffAdviceSelection } from "../classifier/handoff-advice.ts";
import { businessPolicyDiagnostic, classifierBusinessStatus, diagnosticText, diagnosticWait, DIAGNOSTIC_INPUT_LIMIT, rawClassifierDiagnostic, readClassifierShadow } from "../classifier/diagnostics.ts";
import { configuredPanelValues, refreshClassifierPanelModels, panelChanges, saveClassifierPanel, type PanelModelCatalog } from "../classifier/panel-model.ts";
import type { ClassifierSettingsProvider } from "../classifier/settings-provider.ts";
import { fit, frame, pad, rule, type FrameTheme } from "./ui-primitives.ts";
import { BracketedPasteDecoder, removeLastGrapheme, sanitizeSingleLineInput } from "./input-text.ts";
import { getTuiLocale } from "./locale.ts";
import { classifierText, classifierCatalogNotice } from "./classifier-catalog.ts";

type Group = "engine" | "policy";
type PanelIntent = "close" | "savePolicy" | "diagnostics" | "modelrefresh";
interface Row { key: string; label: string; choices?: JsonValue[]; choiceLabels?: Record<string, string>; numeric?: boolean; min?: number; max?: number; model?: "classifier" | "llm"; readonly?: boolean }
export interface ClassifierPanelState {
  snapshot: SettingsSnapshot;
  engine: Record<string, JsonValue>;
  engineInitial: Record<string, JsonValue>;
  policy: DecisionPolicy;
  policyInitial: DecisionPolicy;
  group: Group;
  selected: number;
  notice: string;
}
export interface ClassifierPanelParams {
  /** Explicit language override; otherwise uses the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
  state: ClassifierPanelState;
  engineRows: () => Row[];
  classifierModels: PanelModelCatalog;
  llmModels: PanelModelCatalog;
  theme: FrameTheme;
  requestRender(): void;
  done(intent: PanelIntent): void;
  saveEngine(changes: ReturnType<typeof panelChanges>): Promise<SettingsSnapshot>;
  signal: AbortSignal;
  onDispose?: () => void;
}
function policyRows(locale?: SupportedSettingsLocale): Row[] {
  const t = (key: Parameters<typeof classifierText>[0]) => classifierText(key, {}, locale);
  return [
    { key: "ask.mode", label: t("ask"), choices: ["off", "shadow", "enforce"] },
    { key: "selfEvolve.mode", label: t("evolve"), choices: ["off", "shadow", "enforce"] },
    { key: "backend", label: t("backend"), choices: ["auto", "classifier", "llm"] },
    { key: "minConfidence", label: t("confidence"), numeric: true, min: 0.5, max: 1 },
    ...(["classification", "advice"] as const).flatMap(stage => [
      { key: `${stage}.model`, label: t(stage === "classification" ? "classificationModel" : "adviceModel"), model: "llm" as const },
      { key: `${stage}.timeoutMs`, label: t(stage === "classification" ? "classificationTimeout" : "adviceTimeout"), numeric: true, min: 100, max: 120_000 },
      { key: `${stage}.maxCallsPerSession`, label: t(stage === "classification" ? "classificationBudget" : "adviceBudget"), numeric: true, min: 1, max: 1000 },
    ]),
    { key: "rules", label: t("rules"), readonly: true },
  ];
}
const copyPolicy = (policy: DecisionPolicy): DecisionPolicy => structuredClone(policy);

/** Fold complete actions before clipping; Esc remains first on narrow terminals. */
function classifierHelpLines(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const action of text.split(" · ")) {
    const next = line ? `${line} · ${action}` : action;
    if (line && visibleWidth(next) > width) { lines.push(fit(line, width)); line = action; }
    else line = next;
  }
  if (line) lines.push(fit(line, width));
  return lines;
}

/** One overlay, independent file drafts, inline confirmation (no nested host UI). */
export class ClassifierSettingsOverlay implements Component, Focusable {
  focused = false;
  private mode: "menu" | "edit" | "pick" | "confirm" = "menu";
  private input = "";
  private cursor = 0;
  private choices: { value: JsonValue; label: string }[] = [];
  private saving = false;
  private closed = false;
  private discardArmed = false;
  private readonly pasteDecoder = new BracketedPasteDecoder();
  constructor(private readonly params: ClassifierPanelParams) {}
  invalidate(): void {}
  dispose(): void { const cancelled = !this.closed; this.closed = true; if (cancelled) this.params.onDispose?.(); }
  private t(key: Parameters<typeof classifierText>[0], vars?: Readonly<Record<string, string | number>>) { return classifierText(key, vars, this.params.locale); }
  private get state() { return this.params.state; }
  private rows() { return this.state.group === "engine" ? this.params.engineRows() : policyRows(this.params.locale); }
  private row(): Row { const rows = this.rows(); this.state.selected = Math.min(this.state.selected, rows.length - 1); return rows[this.state.selected]!; }
  private value(row: Row): JsonValue {
    if (this.state.group === "engine") return this.state.engine[row.key] ?? "off";
    if (row.key === "rules") return this.t("rulesValue", { count: this.state.policy.rules.length });
    const [key, sub] = row.key.split(".");
    const value = this.state.policy[key as keyof DecisionPolicy];
    return (sub ? (value as Record<string, JsonValue>)[sub] : value) as JsonValue;
  }
  private set(row: Row, value: JsonValue): void {
    if (this.state.group === "engine") this.state.engine[row.key] = value;
    else {
      if ((row.key === "ask.mode" || row.key === "selfEvolve.mode") && value !== "off") {
        const domains = row.key === "ask.mode" ? ["ask"] : ["evolve-capture", "evolve-review"];
        if (!this.state.policy.rules.some(rule => domains.includes(rule.domain))) {
          this.state.notice = this.t("needsRules");
          return;
        }
      }
      const [key, sub] = row.key.split(".");
      if (sub) (this.state.policy[key as keyof DecisionPolicy] as Record<string, unknown>)[sub] = value;
      else (this.state.policy as unknown as Record<string, unknown>)[key!] = value;
    }
    this.discardArmed = false;
    this.state.notice = this.t("draftNotice");
  }
  private dirty(group = this.state.group): boolean {
    return group === "engine" ? panelChanges(this.state.engineInitial, this.state.engine).length > 0 : JSON.stringify(this.state.policy) !== JSON.stringify(this.state.policyInitial);
  }
  private filteredChoices() { return this.choices.filter(choice => choice.label.toLowerCase().includes(this.input.toLowerCase())); }
  private displayValue(row: Row, value = this.value(row)): string {
    if (row.choiceLabels?.[String(value)]) return row.choiceLabels[String(value)]!;
    if (row.model) return value === "" ? this.t("autoModel") : value === "inherit" ? this.t("inheritModel") : String(value);
    const keys = { true: "true", false: "false", off: "off", shadow: "shadowMode", enforce: "enforce", auto: "auto", classifier: "classifier", llm: "llm" } as const;
    const key = Object.hasOwn(keys, String(value)) ? keys[String(value) as keyof typeof keys] : undefined;
    return key ? this.t(key) : String(value);
  }
  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, 140));
    const row = this.row();
    if (w < 4) return [fit(this.t("title"), w)];
    const inner = w - 2;
    const theme = this.params.theme;
    const paint = (role: string, text: string, bold = false) => fit(theme.fg(role, bold ? theme.bold(text) : text), inner);
    const help = (text: string) => classifierHelpLines(text, inner).map(line => paint("muted", line));
    const rows = [paint("accent", this.t("title"), true)];
    rows.push(fit((["engine", "policy"] as const).map(group => {
      const label = `${this.t(group)}${this.dirty(group) ? " *" : ""}`;
      return group === this.state.group ? theme.fg("accent", theme.bold(`[ ${label} ]`)) : theme.fg("muted", `  ${label}  `);
    }).join("  "), inner));
    rows.push(paint(this.dirty() ? "warning" : "dim", `${this.saving ? this.t("saving") : this.t(this.dirty() ? "dirty" : "clean")} · .pi/${this.state.group === "engine" ? "classifier" : "decision-policy"}.json`));
    rows.push(paint("dim", rule(inner)));
    if (this.mode === "confirm") {
      rows.push(paint("accent", this.t("saveOnly", { file: this.state.group === "engine" ? "classifier" : "decision-policy" }), true));
      if (this.state.group === "engine") for (const change of panelChanges(this.state.engineInitial, this.state.engine)) rows.push(fit(`${change.key} → ${JSON.stringify(change.operation === "set" ? change.value : this.t("default"))}`, inner));
      else for (const item of policyRows(this.params.locale).filter(item => !item.readonly)) rows.push(fit(`${item.label} → ${this.displayValue(item)}`, inner));
      rows.push(...help(this.t("confirmHelp")));
    } else if (this.mode === "edit") {
      rows.push(paint("accent", row.label, true), paint("accent", `> ${this.input}`), ...help(this.t("editHelp")));
    } else if (this.mode === "pick") {
      rows.push(paint("accent", this.t("search", { label: row.label, query: this.input }), true));
      const choices = this.filteredChoices();
      const start = Math.max(0, this.cursor - 5);
      choices.slice(start, start + 10).forEach((choice, index) => {
        const selected = start + index === this.cursor;
        rows.push(paint(selected ? "accent" : "text", `${selected ? ">" : " "} ${choice.label}`, selected));
      });
      if (!choices.length) rows.push(paint("muted", this.t("noMatch")));
      if (row.model) {
        const catalog = row.model === "classifier" ? this.params.classifierModels : this.params.llmModels;
        if (catalog.unavailable) rows.push(paint("warning", classifierCatalogNotice(catalog.unavailable, this.params.locale)));
        const current = String(this.value(row));
        if (current && current !== "inherit" && !catalog.options.some(option => option.reference === current)) rows.push(paint("warning", this.t("unavailablePin", { model: current })));
      }
      rows.push(...help(this.t("pickHelp")));
    } else {
      const all = this.rows();
      const compact = inner < 40;
      const start = Math.max(0, this.state.selected - (compact ? 3 : 7));
      const visible = all.slice(start, start + (compact ? 7 : 14));
      const labelWidth = Math.min(Math.max(...visible.map(item => visibleWidth(item.label) + 1)), Math.max(1, Math.floor((inner - 4) * 0.55)));
      visible.forEach((item, index) => {
        const selected = start + index === this.state.selected;
        // Narrow screens use stacked fields; wide screens align values by visible cells.
        if (inner < 40) {
          rows.push(paint(selected ? "accent" : "text", `${selected ? ">" : " "} ${item.label}`, selected));
          rows.push(paint(selected ? "accent" : "muted", `  ${this.displayValue(item)}`));
        } else {
          const label = theme.fg(selected ? "accent" : "text", pad(fit(`${item.label}:`, labelWidth), labelWidth));
          const value = theme.fg(selected ? "accent" : "muted", this.displayValue(item));
          rows.push(fit(`${selected ? theme.fg("accent", ">") : " "} ${selected ? theme.bold(label) : label} ${selected ? theme.bold(value) : value}`, inner));
        }
      });
      rows.push(paint("dim", rule(inner)));
      if (this.state.group === "engine") {
        const effective = this.state.snapshot.effective.values.find(value => value.key === row.key);
        const configured = this.state.snapshot.configured.values.find(value => value.key === row.key);
        rows.push(paint("dim", this.t("configured", { configured: configured?.state === "set" ? String(configured.value) : this.t("default"), effective: String(effective?.value) })));
        rows.push(paint("dim", this.t("env", { value: effective?.source === "runtime" ? effective.resource?.id ?? this.t("unknown") : this.t("none") })));
        if (configured?.state === "invalid") rows.push(paint("warning", this.t("invalidConfig", { message: configured.messageKey ?? this.t("unknown") })));
        const status = classifierStatus();
        if (this.params.classifierModels.unavailable) rows.push(paint("warning", classifierCatalogNotice(this.params.classifierModels.unavailable, this.params.locale)));
        rows.push(paint("muted", this.t("runtime", { enabled: this.t(status.enabled ? "enabled" : "disabled"), status: status.runtimeStatus ?? this.t("unknown"), model: diagnosticText(status.effectiveModel) || this.t("none") })));
        rows.push(paint("dim", this.t("reason", { reason: diagnosticText(status.runtimeReason) || this.t("none"), used: status.callsUsed, max: status.maxCalls, cache: status.cacheSize })));
      } else {
        rows.push(paint("dim", this.t("policyHint")));
        rows.push(paint("muted", this.t(this.state.policy.backend === "auto" ? "autoHint" : this.state.policy.backend === "classifier" ? "classifierHint" : "llmHint")));
        rows.push(paint("dim", this.t("revision", { revision: this.state.policyInitial.revision })));
        rows.push(paint("dim", this.t("rulesHint", { rules: this.state.policy.rules.map(rule => `${rule.id} (${rule.domain})`).join(", ") || `${this.t("none")}; /skill:decision-policy` })));
        if (this.params.llmModels.unavailable) rows.push(paint("warning", classifierCatalogNotice(this.params.llmModels.unavailable, this.params.locale)));
      }
      rows.push(...help(this.t("mainHelp")), ...help(this.t("fileHelp")));
      rows.push(...help(this.t(inner < 70 ? "compactToolsHelp" : "toolsHelp")));
    }
    if (this.state.notice) rows.push(paint("warning", `! ${this.state.notice}`));
    return frame(rows, w, theme);
  }
  handleInput(data: string): void {
    if (this.closed || this.params.signal.aborted) return;
    if (data === "\x1b") { this.handleKey(data); return; }
    for (const token of this.pasteDecoder.feed(data)) {
      if (token.kind === "paste") {
        if (!this.saving && (this.mode === "pick" || this.mode === "edit")) {
          this.input = `${this.input}${token.text}`.slice(0, 4096);
          this.cursor = 0;
          this.redraw();
        }
      } else this.handleKey(token.text);
    }
  }
  private handleKey(data: string): void {
    if (this.closed || this.params.signal.aborted) return;
    if (matchesKey(data, Key.escape)) {
      if (this.saving) { this.finish("close"); return; }
      if (this.mode !== "menu") { this.mode = "menu"; this.input = ""; this.redraw(); return; }
      if ((this.dirty("engine") || this.dirty("policy")) && !this.discardArmed) { this.discardArmed = true; this.state.notice = this.t("discard"); this.redraw(); return; }
      this.finish("close"); return;
    }
    if (this.saving) return;
    if (this.mode === "confirm") {
      if (matchesKey(data, Key.enter)) {
        if (this.state.group === "policy") this.finish("savePolicy");
        else void this.save();
      }
      return;
    }
    if (this.mode === "pick" || this.mode === "edit") {
      if (this.mode === "pick" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
        const count = this.filteredChoices().length;
        this.cursor = Math.max(0, Math.min(count - 1, this.cursor + (matchesKey(data, Key.up) ? -1 : 1)));
      } else if (matchesKey(data, Key.enter)) {
        if (this.mode === "pick") {
          const choice = this.filteredChoices()[this.cursor];
          if (choice) { this.set(this.row(), choice.value); this.mode = "menu"; }
        } else {
          const value = Number(this.input);
          const row = this.row();
          if (!this.input.trim() || !Number.isFinite(value) || (row.key !== "minConfidence" && !Number.isSafeInteger(value))
            || value < (row.min ?? 1) || (row.max !== undefined && value > row.max)) {
            this.state.notice = this.t("invalidNumber", { min: row.min ?? 1, max: row.max ?? this.t("safeInteger") });
          } else { this.set(row, value); this.mode = "menu"; }
        }
      } else if (matchesKey(data, Key.ctrl("u"))) { this.input = ""; this.cursor = 0; }
      else if (matchesKey(data, Key.backspace)) { this.input = removeLastGrapheme(this.input); this.cursor = 0; }
      else if (!data.includes("\x1b")) { this.input = `${this.input}${sanitizeSingleLineInput(data)}`.slice(0, 4096); this.cursor = 0; }
      this.redraw(); return;
    }
    if (matchesKey(data, Key.f5)) { this.finish("diagnostics"); return; }
    if (matchesKey(data, Key.f6)) { this.finish("modelrefresh"); return; }
    if (matchesKey(data, Key.tab)) { this.state.group = this.state.group === "engine" ? "policy" : "engine"; this.state.selected = 0; this.discardArmed = false; }
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) { this.state.selected = (this.state.selected + this.rows().length + (matchesKey(data, Key.up) ? -1 : 1)) % this.rows().length; this.discardArmed = false; }
    else if (matchesKey(data, Key.ctrl("r"))) {
      if (this.state.group === "engine") this.state.engine = { ...this.state.engineInitial };
      else this.state.policy = copyPolicy(this.state.policyInitial);
      this.state.notice = this.t("cancelled");
    } else if (matchesKey(data, Key.ctrl("s"))) {
      if (!this.dirty()) this.state.notice = this.t("noChanges");
      else if (this.state.group === "policy" && !DecisionPolicySchema.safeParse(this.state.policy).success) this.state.notice = this.t("invalidPolicy");
      else this.mode = "confirm";
    } else if (matchesKey(data, Key.enter) || data === " ") this.edit();
    this.redraw();
  }
  private edit(): void {
    const row = this.row();
    if (row.readonly) { this.state.notice = this.t("readonly"); return; }
    this.input = ""; this.cursor = 0;
    if (row.numeric) { this.mode = "edit"; this.input = String(this.value(row)); }
    else {
      this.mode = "pick";
      if (row.model) {
        const catalog = row.model === "classifier" ? this.params.classifierModels : this.params.llmModels;
        this.choices = [{ value: row.model === "classifier" ? "" : "inherit", label: row.model === "classifier" ? this.t("autoModel") : this.t("inheritModel") }, ...catalog.options.map(option => ({ value: option.reference, label: option.label }))];
      } else this.choices = (row.choices ?? []).map(value => ({ value, label: this.displayValue(row, value) }));
    }
  }
  private async save(): Promise<void> {
    this.saving = true; this.state.notice = this.t("savingClassifier"); this.redraw();
    try {
      const snapshot = await this.params.saveEngine(panelChanges(this.state.engineInitial, this.state.engine));
      if (this.closed || this.params.signal.aborted) return;
      this.state.snapshot = snapshot;
      this.state.engineInitial = configuredPanelValues(snapshot);
      this.state.engine = { ...this.state.engineInitial };
      this.state.notice = this.t("savedClassifier");
    } catch (error) {
      if (this.closed || this.params.signal.aborted) return;
      this.state.notice = this.t("saveFailed", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!this.closed && !this.params.signal.aborted) { this.saving = false; this.mode = "menu"; this.redraw(); }
    }
  }
  private finish(intent: PanelIntent) { this.closed = true; this.params.done(intent); }
  private redraw() { if (!this.closed) this.params.requestRender(); }
}

export function classifierEngineRows(provider: ClassifierSettingsProvider, explicitLocale?: SupportedSettingsLocale): Row[] {
  const locale = getTuiLocale(explicitLocale);
  // Provider describe is synchronous for this implementation; live domains are read on each render.
  const description = provider.describe({ context: { cwd: "", locale } });
  if (description instanceof Promise) throw new Error("Classifier settings description unexpectedly asynchronous");
  return description.settings.map(setting => ({
    key: setting.key,
    label: (description.catalogs?.[locale]?.[setting.labelKey] ?? description.catalogs?.en?.[setting.labelKey]) ?? setting.key,
    ...(setting.key === "classifier.model" ? { model: "classifier" as const } : {}),
    ...(setting.editor.kind === "integer" ? { numeric: true, min: setting.editor.min, max: setting.editor.max } : {}),
    ...(setting.editor.kind === "boolean" ? { choices: [false, true] } : {}),
    ...(setting.editor.kind === "enum" ? {
      choices: setting.editor.options?.map(option => option.value),
      choiceLabels: Object.fromEntries((setting.editor.options ?? []).map(option => [String(option.value),
        locale === "en" ? String(option.value) : `${description.catalogs?.[locale]?.[option.labelKey] ?? String(option.value)} · ${option.value}`])),
    } : {}),
  }));
}

export async function showClassifierSettings(ctx: ExtensionCommandContext, provider: ClassifierSettingsProvider, controller: AbortController, assertFresh: () => void, explicitLocale?: SupportedSettingsLocale): Promise<void> {
  const locale = getTuiLocale(explicitLocale);
  const t = (key: Parameters<typeof classifierText>[0], vars?: Readonly<Record<string, string | number>>) => classifierText(key, vars, locale);
  if (!supportsCustomOverlay(ctx)) throw new Error("Classifier settings require an interactive TUI");
  const context = { cwd: ctx.cwd, locale };
  const ui = ctx.ui;
  let policyHandle: Awaited<ReturnType<typeof openDecisionPolicyPanel>> | undefined;
  let closeOverlay: (() => void) | undefined;
  const abort = () => { closeOverlay?.(); policyHandle?.close(); };
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    policyHandle = await openDecisionPolicyPanel(ctx);
    assertFresh();
    const snapshot = await provider.read({ context });
    const engine = configuredPanelValues(snapshot);
    let { classifierModels, llmModels } = await diagnosticWait(refreshClassifierPanelModels(VERSION, ctx.modelRegistry, controller.signal, false), controller.signal);
    assertFresh();
    const state: ClassifierPanelState = { snapshot, engine, engineInitial: { ...engine }, policy: copyPolicy(policyHandle.policy), policyInitial: copyPolicy(policyHandle.policy), group: "engine", selected: 0, notice: t("separateFiles") };
    while (true) {
      assertFresh();
      const intent = await ctx.ui.custom<PanelIntent>((tui, theme, _keys, done) => {
        closeOverlay = () => done("close");
        return new ClassifierSettingsOverlay({ locale, state, classifierModels, llmModels, theme, signal: controller.signal,
          engineRows: () => classifierEngineRows(provider, locale), requestRender: () => tui.requestRender(),
          done: value => { closeOverlay = undefined; if (value === "close") controller.abort(); done(value); },
          onDispose: () => controller.abort(),
          saveEngine: async changes => {
            const committed = await saveClassifierPanel(provider, context, state.snapshot, changes, assertFresh);
            if (controller.signal.aborted) ui.notify(t("committedClassifier", { cwd: context.cwd }), "info");
            return committed;
          },
        });
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
      closeOverlay = undefined;
      if (intent === "close") break;
      assertFresh();
      if (intent === "diagnostics" || intent === "modelrefresh") {
        try {
          if (intent === "diagnostics") await showClassifierDiagnostics(ctx, controller, assertFresh, undefined, locale);
          else {
            const refreshed = await diagnosticWait(refreshClassifierPanelModels(VERSION, ctx.modelRegistry, controller.signal), controller.signal);
            assertFresh();
            classifierModels = refreshed.classifierModels; llmModels = refreshed.llmModels;
            state.notice = t("refreshed", { status: refreshed.readiness.status, model: diagnosticText(refreshed.readiness.model) || t("none"), reason: diagnosticText(refreshed.readiness.reason) || t("ready"), classifier: classifierCatalogNotice(classifierModels.unavailable ?? "", locale), llm: classifierCatalogNotice(llmModels.unavailable ?? "", locale) });
          }
        } catch (error) { assertFresh(); state.notice = t("refreshFailed", { message: diagnosticText(error) }); }
        continue;
      }
      // The custom overlay has settled; host confirmation cannot nest/deadlock here.
      try {
        const saved = await policyHandle.save(copyPolicy(state.policy), state.policyInitial.revision, controller.signal);
        try { assertFresh(); }
        catch (error) {
          if (!saved) throw error;
          ui.notify(t("committedPolicy", { cwd: context.cwd }), "info");
          break;
        }
        if (saved) { state.policy = copyPolicy(saved); state.policyInitial = copyPolicy(saved); state.notice = t("savedPolicy"); }
        else state.notice = t("cancelledPolicy");
      } catch (error) {
        assertFresh();
        policyHandle.close();
        policyHandle = await openDecisionPolicyPanel(ctx);
        assertFresh();
        state.policy = copyPolicy(policyHandle.policy);
        state.policyInitial = copyPolicy(policyHandle.policy);
        state.notice = t("failedPolicy", { message: String(error) });
      }
    }
  } finally {
    controller.signal.removeEventListener("abort", abort);
    policyHandle?.close();
    controller.abort();
  }
}

interface DiagnosticPrompt {
  title: string;
  lines?: string[];
  choices?: { value: string; label: string }[];
  input?: boolean;
  initial?: string;
}
/** Bounded read-only diagnostic overlay; no network or host UI is invoked inside it. */
export class ClassifierDiagnosticOverlay implements Component, Focusable {
  focused = false;
  private closed = false;
  private cursor = 0;
  private text: string;
  private readonly paste = new BracketedPasteDecoder();
  constructor(private readonly prompt: DiagnosticPrompt, private readonly theme: FrameTheme,
    private readonly signal: AbortSignal, private readonly done: (value: string | undefined) => void,
    private readonly redraw: () => void, private readonly onDispose: () => void, private readonly locale?: SupportedSettingsLocale) { this.text = prompt.initial ?? ""; }
  invalidate(): void {}
  dispose(): void { if (!this.closed) { this.closed = true; this.onDispose(); } }
  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, 140));
    const t = (key: Parameters<typeof classifierText>[0], vars?: Readonly<Record<string, string | number>>) => classifierText(key, vars, this.locale);
    if (w < 4) return [fit(t("diagnostics"), w)];
    const inner = w - 2;
    // Sanitize machine/host data before applying the trusted theme's ANSI styling.
    const paint = (role: string, text: string, bold = false) => fit(this.theme.fg(role, bold ? this.theme.bold(diagnosticText(text, 3000)) : diagnosticText(text, 3000)), inner);
    const help = (text: string) => classifierHelpLines(text, inner).map(line => paint("muted", line));
    const lines = [paint("accent", this.prompt.title, true), paint("dim", rule(inner))];
    if (this.prompt.input) lines.push(paint("accent", `> ${this.text}`), ...help(t("inputHelp", { count: this.text.length, max: DIAGNOSTIC_INPUT_LIMIT })));
    else {
      const choices = this.prompt.choices;
      const start = choices ? Math.max(0, this.cursor - 5) : this.cursor;
      if (choices) choices.slice(start, start + 14).forEach((choice, index) => {
        const selected = start + index === this.cursor;
        lines.push(paint(selected ? "accent" : "text", `${selected ? ">" : " "} ${choice.label}`, selected));
      });
      else lines.push(...(this.prompt.lines ?? []).slice(start, start + 14).map(line => paint("text", line)));
      lines.push(...help(t(choices ? "pickHelp" : "viewHelp")));
    }
    return frame(lines, w, this.theme);
  }
  handleInput(data: string): void {
    if (this.closed || this.signal.aborted) return;
    if (data === "\x1b") { this.finish(undefined); return; }
    for (const token of this.paste.feed(data)) {
      const value = token.text;
      if (token.kind === "input" && matchesKey(value, Key.escape)) { this.finish(undefined); return; }
      if (token.kind === "input" && matchesKey(value, Key.enter)) {
        if (this.prompt.input) { if (this.text.trim()) this.finish(this.text); }
        else this.finish(this.prompt.choices?.[this.cursor]?.value);
      } else if (!this.prompt.input && token.kind === "input" && (matchesKey(value, Key.up) || matchesKey(value, Key.down))) {
        const max = this.prompt.choices ? this.prompt.choices.length - 1 : Math.max(0, (this.prompt.lines?.length ?? 0) - 14);
        this.cursor = Math.max(0, Math.min(max, this.cursor + (matchesKey(value, Key.up) ? -1 : 1)));
      } else if (this.prompt.input) {
        if (token.kind === "input" && matchesKey(value, Key.ctrl("u"))) this.text = "";
        else if (token.kind === "input" && matchesKey(value, Key.backspace)) this.text = removeLastGrapheme(this.text);
        else if (!value.includes("\x1b")) this.text = `${this.text}${sanitizeSingleLineInput(value)}`.slice(0, DIAGNOSTIC_INPUT_LIMIT);
      }
      if (!this.closed) this.redraw();
    }
  }
  private finish(value: string | undefined) { this.closed = true; this.done(value); }
}

export async function showClassifierDiagnostics(ctx: ExtensionCommandContext, controller: AbortController, assertFresh: () => void, action?: string, explicitLocale?: SupportedSettingsLocale): Promise<void> {
  const locale = getTuiLocale(explicitLocale);
  const t = (key: Parameters<typeof classifierText>[0], vars?: Readonly<Record<string, string | number>>) => classifierText(key, vars, locale);
  const signal = controller.signal;
  const prompt = async (params: DiagnosticPrompt): Promise<string | undefined> => {
    assertFresh();
    let close: (() => void) | undefined;
    const abort = () => close?.();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const value = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        const overlay = new ClassifierDiagnosticOverlay(params, theme, signal, result => { close = undefined; done(result); }, () => tui.requestRender(), () => controller.abort(), locale);
        close = () => { overlay.handleInput("\x1b"); done(undefined); };
        return overlay;
      }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
      assertFresh();
      return value;
    } finally { signal.removeEventListener("abort", abort); }
  };
  const view = async (title: string, lines: string[]) => { await prompt({ title, lines }); };
  const choose = (title: string, values: string[]) => prompt({ title, choices: values.map(value => ({ value,
    label: value === "Back" ? t("back") : ["test", "businessdiagnose", "business", "shadow", "handoff"].includes(value)
      ? `${t(value === "handoff" ? "handoffAction" : value as "test" | "businessdiagnose" | "business" | "shadow")} · ${value}` : value,
  })) });
  const handoff = async () => {
    const tasks = listHandoffAdviceTasks(ctx);
    if (!tasks.length) { await view(t("handoff"), [t("noTodo")]); return; }
    const taskId = await prompt({ title: `${tasks.some(task => task.status === "in_progress") ? t("chooseTodo") : t("chooseTodoInactive")} · ${t("notAuthorization")}`,  choices: tasks.map(task => ({ value: task.taskId, label: t("todoChoice", { id: task.taskId, subject: task.subject, status: task.status, count: task.unknownFiles, next: t(task.nextAction ? "nextPresent" : "nextMissing") }) })) });
    if (!taskId) return;
    assertFresh();
    // Original process-local preview object MUST survive to apply; never clone/serialize it.
    const preview = await diagnosticWait(previewHandoffAdvice(ctx, taskId, signal), signal);
    assertFresh();
    if (preview.status !== "ready") { await view(t("handoffBlocked"), [preview.error ?? t("noAdvice")]); return; }
    await view(t("handoffPreview"), preview.rows.flatMap(row => [
      `${row.path}: ${row.label} · confidence=${row.confidence.toFixed(2)} · layer=${row.layer} · model=${row.model ?? "none"}`,
      t("adviceReason", { reason: row.reason, error: row.error ?? t("eligible") }),
    ]));
    const selections = new Map<string, HandoffAdviceSelection>();
    while (true) {
      const choice = await prompt({ title: t("selection", { count: selections.size }), choices: [
        ...preview.rows.filter(row => row.eligible || row.needsWhen).map(row => ({ value: row.path, label: `${selections.has(row.path) ? "[x]" : "[ ]"} ${row.path} → ${row.label} · ${row.confidence.toFixed(2)} · ${row.model ?? "none"}${row.needsWhen ? t("needsWhen") : ""}` })),
        { value: "\0apply", label: t("confirmAdvice") },
      ] });
      if (!choice) return;
      if (choice === "\0apply") {
        if (!selections.size) { await view(t("handoff"), [t("selectFirst")]); continue; }
        assertFresh();
        // prompt/custom has fully settled: B owns actual host confirmation and in-queue CAS.
        const applied = await applyHandoffAdvice(ctx, preview, [...selections.values()], signal);
        assertFresh();
        await view(t("handoffResult"), [`${applied.status}: ${applied.appliedPaths.map(path => diagnosticText(path)).join(", ") || t("noAppliedChanges")}`, applied.error ?? t("appliedHuman")]);
        return;
      }
      if (selections.has(choice)) { selections.delete(choice); continue; }
      const row = preview.rows.find(row => row.path === choice)!;
      let when = row.when;
      if (row.needsWhen) {
        when = await prompt({ title: t("when"), input: true });
        if (!when?.trim()) continue;
      }
      selections.set(choice, { path: choice, ...(when ? { when } : {}) });
    }
  };
  while (true) {
    const selected = action ?? await choose(t("diagnosticTitle"), ["test", "businessdiagnose", "business", "shadow", "handoff"]);
    if (!selected) return;
    try {
      if (selected === "handoff") await handoff();
      else if (selected === "business") {
        const lines = await classifierBusinessStatus(ctx); assertFresh();
        await view(t("businessTitle"), lines);
        const entry = await choose(t("copyEntry"), ["Back", "/self-evolve", "/classifier handoff", "/enhance", "/api-manager prompt-enhance", "/skill:decision-policy"]);
        assertFresh();
        if (entry && entry !== "Back") { ctx.ui.setEditorText(entry); ctx.ui.notify(t("entryCopied"), "info"); return; }
      }
      else if (selected === "shadow") { const summary = await readClassifierShadow(); assertFresh(); await view(t("shadowTitle"), summary.lines); }
      else {
        const domain = await choose(selected === "test" ? t("rawDomain") : t("businessDomain"), selected === "test" ? listClassifyDomains() : ["ask", "evolve-capture", "evolve-review"]);
        if (!domain) { if (action) return; continue; }
        const text = await prompt({ title: t("testTitle", { domain }), input: true });
        if (!text) { if (action) return; continue; }
        assertFresh();
        ctx.ui.notify(t("running"), "info");
        const lines = selected === "test" ? await rawClassifierDiagnostic(ctx, domain, text, signal) : await businessPolicyDiagnostic(ctx, domain as "ask" | "evolve-capture" | "evolve-review", text, signal);
        assertFresh();
        await view(t("result"), lines);
      }
    } catch (error) { assertFresh(); await view(t("diagnosticUnavailable"), [diagnosticText(error, 2000)]); }
    if (action) return;
  }
}
