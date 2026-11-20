import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { getTuiLocale } from "./locale.ts";

const en = {
  title: "Classifier / Decision policy", engine: "Engine", policy: "Policy", diagnostics: "Classifier diagnostics",
  clean: "Saved state", dirty: "Unsaved draft", saving: "Saving…",
  ask: "Ask mode", evolve: "Self-evolve mode", backend: "Classification backend", confidence: "Minimum confidence (0.5–1)",
  classificationModel: "classification LLM", classificationTimeout: "classification timeout (ms)", classificationBudget: "classification budget",
  adviceModel: "advice LLM", adviceTimeout: "advice timeout (ms)", adviceBudget: "advice budget", rules: "Confirmed rules (read-only)",
  rulesValue: "{count} confirmed · /skill:decision-policy to edit",
  needsRules: "Cannot enable policy without confirmed rules. Run /skill:decision-policy.",
  draftNotice: "Unsaved draft; Ctrl+S saves only this file.",
  saveOnly: "Save only .pi/{file}.json?", confirmHelp: "Esc back · Enter confirm", editHelp: "Esc back · Enter accept · Ctrl+U clear",
  search: "{label} · search: {query}", noMatch: "No matching candidates", unavailablePin: "Configured unavailable (preserved): {model}",
  pickHelp: "Esc back · Enter choose · ↑↓ select", mainHelp: "Esc close · Enter edit · ↑↓ select · Tab file",
  fileHelp: "Ctrl+S save · Ctrl+R cancel file", toolsHelp: "F5 diagnostics/business/shadow/handoff · F6 model refresh (preserves drafts/pins)",
  compactToolsHelp: "F5 diagnostics · F6 models",
  configured: "configured: {configured} · effective: {effective}", env: "envOverride: {value}",
  invalidConfig: "Configuration unavailable: {message}; repair before saving.",
  runtime: "Runtime: {enabled} · {status} · model {model}", reason: "Reason: {reason} · calls {used}/{max} · cache {cache}",
  policyHint: "Policy modes are independent of classifier/domain modes; advice always needs an LLM.",
  autoHint: "auto: usable classifier first, then classification LLM fallback.",
  classifierHint: "classifier-only: no classification LLM fallback; unavailable means human.", llmHint: "llm: bypass classifier for classification.",
  revision: "Configured/effective: saved revision {revision} · envOverride: none", rulesHint: "Rules read-only: {rules}",
  discard: "Unsaved drafts · Esc again discards both files.", invalidNumber: "Invalid numeric value; allowed {min}–{max}.", safeInteger: "safe integer",
  cancelled: "Current file draft cancelled; other file unchanged.", noChanges: "No changes in this file.",
  invalidPolicy: "Invalid policy draft; confidence 0.5–1, timeout 100–120000, budget 1–1000; enabling needs confirmed rules (/skill:decision-policy).",
  readonly: "Rules are read-only. Run /skill:decision-policy.", autoModel: "Auto (classifier runtime)", inheritModel: "inherit (session LLM)",
  savingClassifier: "Saving classifier.json…", savedClassifier: "classifier.json saved; policy draft untouched.", saveFailed: "Save failed: {message}",
  separateFiles: "Separate files: save/cancel each group independently.", committedClassifier: "Classifier settings committed to {cwd}/.pi/classifier.json before the panel closed.",
  refreshed: "Models refreshed: {status} · {model} · {reason}; drafts and pins preserved. {classifier} {llm}",
  refreshFailed: "Diagnostic/refresh failed: {message}; drafts and pins preserved.",
  committedPolicy: "Decision policy settings committed to {cwd}/.pi/decision-policy.json before the panel closed.",
  savedPolicy: "decision-policy.json saved; classifier draft untouched.", cancelledPolicy: "Policy save cancelled; draft preserved.",
  failedPolicy: "Policy save failed: {message}; policy reloaded, engine draft preserved.",
  inputHelp: "Esc cancel · Enter run · Ctrl+U clear · {count}/{max} chars", viewHelp: "Esc/Enter back · ↑↓ scroll",
  handoff: "Handoff", noTodo: "No active/owned Todo available in this canonical root session.",
  chooseTodo: "Choose owned Todo", chooseTodoInactive: "Choose owned Todo (no active Todo; explicit choice required)",
  notAuthorization: "machine advice is not authorization", todoChoice: "#{id} {subject} · {status} · unknown={count} · {next}",
  nextPresent: "next step present", nextMissing: "no explicit next step", handoffBlocked: "Handoff blocked", noAdvice: "No advice.",
  handoffPreview: "Handoff machine advice (no changes yet)", adviceReason: "Reason: {reason} · {error}", eligible: "eligible",
  selection: "Human selection · {count} selected · real host confirmation follows", needsWhen: " · needs human when",
  confirmAdvice: "Confirm selected advice with host (does not auto-apply)", selectFirst: "Select eligible advice first; no automatic Todo change.",
  handoffResult: "Handoff result", noAppliedChanges: "no changes", appliedHuman: "Machine advice was applied only after real human confirmation.",
  when: "Concrete human conditional trigger (when)", diagnosticTitle: "Classifier diagnostics (saved state; drafts untouched)",
  test: "Raw domain test", businessdiagnose: "Business policy test", business: "Business status / entries", shadow: "Recent shadow samples", handoffAction: "Handoff advice",
  businessTitle: "Business status / entry commands (read-only)", copyEntry: "Copy entry to editor only (never executes a switch/command)", back: "Back",
  entryCopied: "Entry copied to editor; close settings and explicitly submit it if wanted. No business configuration was changed.",
  shadowTitle: "Recent shadow sample", rawDomain: "Raw registered domain", businessDomain: "Business policy domain (advice:false)",
  testTitle: "Test {domain} (uses existing budget; no force enable)", running: "Classifier diagnostic running outside custom UI; /classifier cancel or host cancellation aborts the consumer.",
  result: "Diagnostic result", diagnosticUnavailable: "Diagnostic unavailable",
  none: "none", default: "default", enabled: "enabled", disabled: "disabled", unknown: "unknown", ready: "ready",
  true: "true", false: "false", off: "off", shadowMode: "shadow", enforce: "enforce", auto: "auto", classifier: "classifier", llm: "llm",
  nativeUnavailable: "Classifier model picker unavailable: host lacks the native authenticated classifier API (requires Pi >=0.99). Existing configuration is preserved.",
  noClassifierModels: "No authenticated classifier models available.", noLlmModels: "No authenticated LLM models available.",
  classifierCatalog: "Classifier model catalog unavailable: {message}", llmCatalog: "LLM catalog unavailable: {message}",
} as const;
type Key = keyof typeof en;
const zh: Record<Key, string> = {
  title: "分类器 / 决策策略", engine: "引擎", policy: "策略", diagnostics: "分类器诊断",
  clean: "已保存状态", dirty: "未保存草稿", saving: "保存中…",
  ask: "提问模式", evolve: "自进化模式", backend: "分类后端", confidence: "最低置信度（0.5–1）",
  classificationModel: "分类 LLM", classificationTimeout: "分类超时（毫秒）", classificationBudget: "分类调用预算",
  adviceModel: "建议 LLM", adviceTimeout: "建议超时（毫秒）", adviceBudget: "建议调用预算", rules: "已确认规则（只读）",
  rulesValue: "{count} 条已确认 · /skill:decision-policy 编辑",
  needsRules: "缺少已确认规则，无法启用策略。请运行 /skill:decision-policy。", draftNotice: "草稿未保存；Ctrl+S 仅保存当前文件。",
  saveOnly: "仅保存 .pi/{file}.json？", confirmHelp: "Esc 返回 · Enter 确认", editHelp: "Esc 返回 · Enter 接受 · Ctrl+U 清空",
  search: "{label} · 搜索：{query}", noMatch: "没有匹配的候选项", unavailablePin: "已配置模型不可用（已保留）：{model}",
  pickHelp: "Esc 返回 · Enter 选择 · ↑↓ 导航", mainHelp: "Esc 关闭 · Enter 编辑 · ↑↓ 选择 · Tab 文件",
  fileHelp: "Ctrl+S 保存 · Ctrl+R 撤销当前文件", toolsHelp: "F5 诊断/业务/影子/交接 · F6 刷新模型（保留草稿与固定模型）", compactToolsHelp: "F5 诊断 · F6 模型",
  configured: "配置值：{configured} · 生效值：{effective}", env: "环境变量覆盖：{value}", invalidConfig: "配置不可用：{message}；请修复后再保存。",
  runtime: "运行时：{enabled} · {status} · 模型 {model}", reason: "原因：{reason} · 调用 {used}/{max} · 缓存 {cache}",
  policyHint: "策略模式独立于分类器/域模式；建议始终需要 LLM。", autoHint: "auto：优先使用可用分类器，再回退到分类 LLM。",
  classifierHint: "classifier：不回退到分类 LLM；不可用时交由人工。", llmHint: "llm：分类时跳过分类器。",
  revision: "配置/生效：已保存版本 {revision} · 无环境变量覆盖", rulesHint: "规则只读：{rules}",
  discard: "有未保存草稿 · 再按 Esc 放弃两个文件的修改。", invalidNumber: "数值无效；允许范围 {min}–{max}。", safeInteger: "安全整数",
  cancelled: "已撤销当前文件草稿；另一文件未变更。", noChanges: "当前文件没有修改。",
  invalidPolicy: "策略草稿无效；置信度 0.5–1，超时 100–120000，预算 1–1000；启用需确认规则（/skill:decision-policy）。",
  readonly: "规则只读。请运行 /skill:decision-policy。", autoModel: "自动（分类器运行时）", inheritModel: "继承会话 LLM（inherit）",
  savingClassifier: "正在保存 classifier.json…", savedClassifier: "classifier.json 已保存；策略草稿未变更。", saveFailed: "保存失败：{message}",
  separateFiles: "独立文件：分别保存或撤销引擎与策略草稿。", committedClassifier: "面板关闭前，分类器设置已提交至 {cwd}/.pi/classifier.json。",
  refreshed: "模型已刷新：{status} · {model} · {reason}；草稿与固定模型已保留。{classifier} {llm}", refreshFailed: "诊断/刷新失败：{message}；草稿与固定模型已保留。",
  committedPolicy: "面板关闭前，决策策略设置已提交至 {cwd}/.pi/decision-policy.json。", savedPolicy: "decision-policy.json 已保存；分类器草稿未变更。",
  cancelledPolicy: "策略保存已取消；草稿已保留。", failedPolicy: "策略保存失败：{message}；已重新加载策略，引擎草稿已保留。",
  inputHelp: "Esc 取消 · Enter 运行 · Ctrl+U 清空 · {count}/{max} 字符", viewHelp: "Esc/Enter 返回 · ↑↓ 滚动",
  handoff: "交接", noTodo: "当前规范根会话没有活跃或归属自己的 Todo。", chooseTodo: "选择自己拥有的 Todo", chooseTodoInactive: "选择自己拥有的 Todo（无活跃 Todo，需明确选择）",
  notAuthorization: "机器建议不代表授权", todoChoice: "#{id} {subject} · {status} · 未知文件={count} · {next}", nextPresent: "已有下一步", nextMissing: "无明确下一步",
  handoffBlocked: "交接受阻", noAdvice: "没有建议。", handoffPreview: "交接机器建议（尚未修改）", adviceReason: "原因：{reason} · {error}", eligible: "可选择",
  selection: "人工选择 · 已选 {count} 项 · 接下来需宿主确认", needsWhen: " · 需人工填写 when", confirmAdvice: "通过宿主确认所选建议（不会自动应用）",
  selectFirst: "请先选择可用建议；不会自动修改 Todo。", handoffResult: "交接结果", noAppliedChanges: "无修改", appliedHuman: "机器建议仅在真实人工确认后应用。",
  when: "人工填写具体条件触发器（when）", diagnosticTitle: "分类器诊断（已保存状态；不改变草稿）",
  test: "原始域测试", businessdiagnose: "业务策略测试", business: "业务状态 / 入口", shadow: "近期影子样本", handoffAction: "交接建议",
  businessTitle: "业务状态 / 入口命令（只读）", copyEntry: "仅复制入口到编辑器（不执行开关或命令）", back: "返回",
  entryCopied: "入口已复制到编辑器；如需执行，请关闭设置并明确提交。未修改业务配置。", shadowTitle: "近期影子样本",
  rawDomain: "已注册的原始域", businessDomain: "业务策略域（advice:false）", testTitle: "测试 {domain}（使用现有预算；不强制启用）",
  running: "分类器诊断在自定义界面外运行；/classifier cancel 或宿主取消可中止调用。", result: "诊断结果", diagnosticUnavailable: "诊断不可用",
  none: "无", default: "默认", enabled: "已启用", disabled: "已停用", unknown: "未知", ready: "就绪",
  true: "启用 · true", false: "停用 · false", off: "关闭 · off", shadowMode: "影子 · shadow", enforce: "强制 · enforce", auto: "自动 · auto", classifier: "分类器 · classifier", llm: "LLM · llm",
  nativeUnavailable: "分类器模型选择不可用：宿主缺少原生已认证分类器 API（需要 Pi >=0.99）。现有配置已保留。",
  noClassifierModels: "没有已认证的可用分类器模型。", noLlmModels: "没有已认证的可用 LLM 模型。", classifierCatalog: "分类器模型目录不可用：{message}", llmCatalog: "LLM 模型目录不可用：{message}",
};
const catalogs = { en, "zh-CN": zh };
export function classifierText(key: Key, vars: Readonly<Record<string, string | number>> = {}, locale?: SupportedSettingsLocale): string {
  return catalogs[getTuiLocale(locale)][key].replace(/\{(\w+)\}/g, (match, name: string) => vars[name] !== undefined ? String(vars[name]) : match);
}

/** Translate UI-owned catalog messages, leaving external host errors intact. */
export function classifierCatalogNotice(message: string, locale?: SupportedSettingsLocale): string {
  for (const key of ["nativeUnavailable", "noClassifierModels", "noLlmModels"] as const) {
    if (message === en[key]) return classifierText(key, {}, locale);
  }
  for (const [prefix, key] of [["Classifier model catalog unavailable: ", "classifierCatalog"], ["LLM catalog unavailable: ", "llmCatalog"]] as const) {
    if (message.startsWith(prefix)) return classifierText(key, { message: message.slice(prefix.length) }, locale);
  }
  return message;
}
