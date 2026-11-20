/** presentation responsibility; composed by the existing tools/plan entry. */
import { altKey } from "../key-labels.ts";
import { Type } from "typebox";
import { planAutoStatusLabel } from "../tools/plan-auto.ts";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { UserAttentionHandler } from "../notify/user-attention.ts";
import { Text } from "@earendil-works/pi-tui";
import { toolCallLine, toolResultLine, resultSummary } from "pi-cockpit/src/quiet-tools.ts";
import { PlanDecomposeParams } from "../tools/plan-decompose.ts";
import type { PlanState } from "./state.ts";
import type { Mode, PlanExecutionMode, PlanHandoffStatus, PlanContext, PlanReviewOutcome, PlanApprovalAudit, PlanHandoffDelivery, PlanToolDetails, PlanCompactionSnapshot, PlanNewContextPayload, LoadedPlanArtifactDocument, PlanArtifactSummary, PlanNewContextScheduleInput, PlanNewContextScheduleReceipt, PlanRuntimeOptions, PlanWorkflowPublicationResult, PlanCleanContextCompactionRequest, PlanHandoffRequestIdentity, PlanOperationIdentity, PlanCompactHandoff, PlanContextReplacement, PlanCalls } from "./types.ts";
import type { PlanHost } from "./host.ts";
export const STATUS_KEY = "mode";
export const PLAN_TOGGLE_KEY = "alt+shift+p";
export const PLAN_TOGGLE_LABEL = altKey("Shift+P");
export const PLAN_ENTER_TOOL = "plan-enter";
export const PLAN_DECOMPOSE_TOOL = "plan-decompose";
export const PLAN_MODE_TOOL_NAMES = [
    "plan-update",
    "plan-review",
    "plan-confirm",
    "plan-exit",
    "plan-status",
] as const;
export const ALL_PLAN_TOOL_NAMES = new Set([PLAN_ENTER_TOOL, PLAN_DECOMPOSE_TOOL, ...PLAN_MODE_TOOL_NAMES]);
export const PlanUpdateParams = Type.Object({
    markdown: Type.String({ description: "Complete Markdown text for current.md" }),
    expectedRevision: Type.Optional(Type.Integer({
        minimum: 0,
        description: "Expected current revision for optimistic concurrency; the save fails if the draft has moved past it. Defaults to the currently loaded revision.",
    })),
});
export const EmptyPlanParams = Type.Object({});
export const PLAN_MODE_REMINDER_TYPE = "plan-mode-reminder";
export function createPlanPresentation(state: PlanState, calls: Pick<PlanCalls, "executeEnterTool" | "executeUpdateTool" | "executeReviewTool" | "executeConfirmTool" | "executeDecomposeTool" | "executeExitTool" | "executeStatusTool" | "executePlanCommand">, host: PlanHost) {
function syncModeStatus(ctx: PlanContext): void {
    ctx.ui.setStatus("maestro-plan-auto", planAutoStatusLabel(ctx));
    ctx.ui.setStatus(STATUS_KEY, state.mode === "act" ? "ACT" : hasPlan() ? "READY" : "PLAN");
}
/** Reuse the existing mode status/listener projection for authorization changes. */
function refreshPlanModeStatus(ctx: PlanContext): void {
    syncModeStatus(ctx);
    host.onPlanModeChanged?.(ctx);
}
function isPlanMode(): boolean {
    return state.mode === "plan";
}
function getMode(): Mode {
    return state.mode;
}
function hasPlan(): boolean {
    return Boolean(state.latestPlan?.trim());
}
function getPlanText(): string {
    return state.latestPlan ?? "";
}
function getPlanArtifactSummary(): PlanArtifactSummary {
    return {
        available: state.latestArtifactAvailable,
        revision: state.latestRevision,
        status: state.latestStatus,
    };
}
/** Bind the root UI/UCL to Plan/Act mode transitions. */
function setPlanModeChangeListener(listener: ((ctx: PlanContext) => void) | undefined): void { host.observeModeChanges(listener); }
function buildPlanExitMessage(): string {
    const path = state.currentStore?.currentPath ?? "the persisted Plan draft";
    return [
        "## Exited Plan Mode",
        "The user intentionally exited Plan mode without approving the draft.",
        `Act mode is now active, and the draft remains preserved at ${path}.`,
        "This is not an approval failure. Do not call Plan-only tools unless the user explicitly re-enters Plan mode.",
    ].join("\n");
}
function buildPlanExitReminder(): string {
    return `<system-reminder>\n${buildPlanExitMessage()}\n</system-reminder>`;
}
function currentDetails(action: PlanToolDetails["action"]): PlanToolDetails {
    return {
        action,
        mode: state.mode,
        revision: state.latestRevision,
        path: state.currentStore?.currentPath ?? "",
        sessionId: state.currentStore?.sessionId ?? "",
        status: state.latestStatus,
        handoffStatus: getPlanHandoffStatus(),
        ...(state.latestHandoffKey ? { handoffKey: state.latestHandoffKey } : {}),
        ...(state.latestExecution ? { execution: state.latestExecution } : {}),
        ...(state.latestWorkflowBinding ? { workflowBinding: state.latestWorkflowBinding } : {}),
    };
}
/**
 * Detached Plan state for compaction metadata and prompts, mirroring
 * getTodoCompactionSnapshot.
 *
 * Only one-shot notes reach the model via before_agent_start.message, so after a
 * compaction the model's only trace of an approved Plan is whatever prose survived the
 * summary — including the handoff key, which nothing injects and which the todo tool
 * needs verbatim. The plan body is deliberately left out: it lives at `path` and is
 * reloaded from the store, so this carries identity and reload metadata, the same way
 * the checkpoint treats skills.
 */
function getPlanCompactionSnapshot(): PlanCompactionSnapshot {
    return {
        mode: state.mode,
        status: state.latestStatus,
        revision: state.latestRevision,
        handoffStatus: getPlanHandoffStatus(),
        ...(state.latestHandoffKey ? { handoffKey: state.latestHandoffKey } : {}),
        ...(state.currentStore ? {
            path: state.latestStatus === "approved" && state.latestApprovedPath
                ? join(state.currentStore.plansDir, state.latestApprovedPath)
                : state.currentStore.currentPath,
        } : {}),
        ...(state.latestStatus === "approved" && state.latestApprovedChecksum ? { checksum: state.latestApprovedChecksum } : {}),
    };
}
/** Return the current Plan material for a deterministic context-reset handoff. */
function getPlanNewContextPayload(): PlanNewContextPayload | undefined {
    if (!state.latestPlan || state.latestStatus === "empty" || !state.currentStore)
        return undefined;
    const path = state.latestStatus === "approved" && state.latestApprovedPath
        ? join(state.currentStore.plansDir, state.latestApprovedPath)
        : state.currentStore.currentPath;
    return {
        status: state.latestStatus,
        revision: state.latestRevision,
        path,
        ...(state.latestHandoffKey ? { handoffKey: state.latestHandoffKey } : {}),
        ...(state.latestApprovedChecksum ? { checksum: state.latestApprovedChecksum } : {}),
        markdown: state.latestPlan,
    };
}
function getPlanHandoffStatus(): PlanHandoffStatus {
    if (state.latestStatus !== "approved")
        return "none";
    if (!state.latestHandoffKey || !host.hasExecutableTodoForHandoff(state.latestHandoffKey))
        return "todo-required";
    return "ready";
}
function result(text: string, details: PlanToolDetails, isError = false, terminate = false): AgentToolResult<PlanToolDetails> {
    return {
        content: [{ type: "text", text }],
        details,
        ...(isError ? { isError: true } : {}),
        ...(terminate ? { terminate: true } : {}),
    } as unknown as AgentToolResult<PlanToolDetails>;
}
function supersededResult(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> {
    return result("Plan operation was superseded by a newer Plan operation.", {
        ...currentDetails(action),
        error: "E_PLAN_OPERATION_SUPERSEDED",
    }, true);
}
function registerPlanTools(pi: ExtensionAPI, options: {
    onUserAttention?: UserAttentionHandler;
} = {}): void {
    const enterTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
        name: PLAN_ENTER_TOOL,
        label: "Plan Enter",
        description: "Enter durable Plan mode and load this chat session's current.md draft. Use only when the user explicitly requests Plan mode or a concrete unresolved decision or gated change requires user approval not already given. Internal task planning does not require this tool.",
        promptSnippet: "Enter Plan mode for an explicit user request for Plan mode or an unresolved approval point, not merely to organize implementation steps. Otherwise stay in Act and implement the authorized scope.",
        promptGuidelines: [
            "For agent-initiated entry, before calling plan-enter, state the specific decision or authorization needed and why the current user request does not settle it. Task size, multiple files, investigation, tests, and implementation checklists alone are not approval points.",
            "Use read-only investigation in Act to resolve technical uncertainty. For one user-owned choice, ask one focused question with ask-user-question; use Plan mode when that choice changes the broader approach, not automatically for every question.",
            "A clear request to implement a diagnosed fix or proposed display change normally authorizes in-scope edits. Do not seek duplicate approval; preserve existing permission gates, failure stop conditions, and explicit locked constraints. Do not invent data semantics or silently narrow the requested result to avoid asking.",
        ],
        parameters: EmptyPlanParams,
        execute: (...args) => calls.executeEnterTool(...args, options.onUserAttention),
        renderShell: "self",
        renderCall(_args, theme, ctx) {
            if (ctx?.isPartial === false)
                return new Text("", 0, 0);
            return toolCallLine(theme, "plan", "enter");
        },
        renderResult(result, opts, theme, ctx) {
            if (opts.isPartial)
                return new Text("", 0, 0);
            const block = result.content.find((c) => c.type === "text");
            const text = block && "text" in block ? block.text : "";
            const isError = ctx.isError || (result as {
                isError?: boolean;
            }).isError === true;
            return toolResultLine(theme, { name: "plan", ok: !isError, arg: "enter", summary: resultSummary(result), expanded: opts.expanded, detail: text });
        },
    };
    const updateTool: ToolDefinition<typeof PlanUpdateParams, PlanToolDetails> = {
        name: "plan-update",
        label: "Plan Update",
        description: "Replace this chat session's current.md draft with complete Markdown. expectedRevision defaults to the currently loaded revision.",
        promptSnippet: "Use plan-update to persist the decision-complete, execution-ready Markdown Plan before review.",
        parameters: PlanUpdateParams,
        execute: (...args) => calls.executeUpdateTool(...args, options.onUserAttention),
        renderShell: "self",
        renderCall(_args, theme, ctx) {
            if (ctx?.isPartial === false)
                return new Text("", 0, 0);
            return toolCallLine(theme, "plan", "update");
        },
        renderResult(result, opts, theme, ctx) {
            if (opts.isPartial)
                return new Text("", 0, 0);
            const block = result.content.find((c) => c.type === "text");
            const text = block && "text" in block ? block.text : "";
            const isError = ctx.isError || (result as {
                isError?: boolean;
            }).isError === true;
            return toolResultLine(theme, { name: "plan", ok: !isError, arg: "update", summary: resultSummary(result), expanded: opts.expanded, detail: text });
        },
    };
    const reviewTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
        name: "plan-review",
        label: "Plan Draft Editor",
        description: "Open the full-screen editable Markdown draft in an interactive UI. Save or cancel without entering Act mode. Use plan-confirm for Review & Refine (role-based AI review and refinement).",
        parameters: EmptyPlanParams,
        executionMode: "sequential",
        execute: (...args) => calls.executeReviewTool(...args, options.onUserAttention),
        renderShell: "self",
        renderCall(_args, theme, ctx) {
            if (ctx?.isPartial === false)
                return new Text("", 0, 0);
            return toolCallLine(theme, "plan", "review");
        },
        renderResult(result, opts, theme, ctx) {
            if (opts.isPartial)
                return new Text("", 0, 0);
            const block = result.content.find((c) => c.type === "text");
            const text = block && "text" in block ? block.text : "";
            const isError = ctx.isError || (result as {
                isError?: boolean;
            }).isError === true;
            return toolResultLine(theme, { name: "plan", ok: !isError, arg: "review", summary: resultSummary(result), expanded: opts.expanded, detail: text });
        },
    };
    const confirmTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
        name: "plan-confirm",
        label: "Plan Confirm",
        description: "Only a valid human Plan-auto preauthorization bypasses the UI, approves this exact draft, and executes standalone/current without inheriting Workflow, New Context, or decision documents. Otherwise present the Markdown Plan in an interactive UI with choices to execute, modify, discuss, run role-based Review & Refine, or exit. Current-context execution returns through the tool result; New Context execution settles the turn, saves the Plan conversation as a checkpoint, resets deterministically, then resumes automatically.",
        promptSnippet: "Standard presentation step after plan-update. Default is manual; only an explicit human Plan-auto grant preauthorizes this confirm and immediate standalone/current execution. The user controls approval and may run role-based Review & Refine; choosing Execute authorizes immediate implementation, with New Context execution preserving a checkpoint and resuming automatically after turn settlement.",
        parameters: EmptyPlanParams,
        executionMode: "sequential",
        execute: (...args) => calls.executeConfirmTool(...args, options.onUserAttention),
        renderShell: "self",
        renderCall(_args, theme, ctx) {
            if (ctx?.isPartial === false)
                return new Text("", 0, 0);
            return toolCallLine(theme, "plan", "confirm");
        },
        renderResult(result, opts, theme, ctx) {
            if (opts.isPartial)
                return new Text("", 0, 0);
            const block = result.content.find((c) => c.type === "text");
            const text = block && "text" in block ? block.text : "";
            const isError = ctx.isError || (result as {
                isError?: boolean;
            }).isError === true;
            return toolResultLine(theme, { name: "plan", ok: !isError, arg: "confirm", summary: resultSummary(result), expanded: opts.expanded, detail: text });
        },
    };
    const decomposeTool: ToolDefinition<typeof PlanDecomposeParams, PlanToolDetails> = {
        name: PLAN_DECOMPOSE_TOOL,
        label: "Plan Decompose",
        description: "Inject the main-flow decomposition prompt for the currently approved Plan. Requires Act mode and the exact approved handoff key; creates no files, Todos, messages, or agents.",
        promptSnippet: "For complex approved work, call plan-decompose with the exact planHandoffKey, then let the current main flow build the complete Todo graph from its returned prompt.",
        parameters: PlanDecomposeParams,
        execute: (...args) => calls.executeDecomposeTool(...args, options.onUserAttention),
        renderShell: "self",
        renderCall(_args, theme, ctx) {
            if (ctx?.isPartial === false)
                return new Text("", 0, 0);
            return toolCallLine(theme, "plan", "decompose");
        },
        renderResult(result, opts, theme, ctx) {
            if (opts.isPartial)
                return new Text("", 0, 0);
            const block = result.content.find((c) => c.type === "text");
            const text = block && "text" in block ? block.text : "";
            const isError = ctx.isError || (result as {
                isError?: boolean;
            }).isError === true;
            return toolResultLine(theme, { name: "plan", ok: !isError, arg: "decompose", summary: resultSummary(result), expanded: opts.expanded, detail: text });
        },
    };
    const exitTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
        name: "plan-exit",
        label: "Plan Exit",
        description: "Exit Plan mode without deleting the persisted draft and return to Act mode.",
        parameters: EmptyPlanParams,
        execute: (...args) => calls.executeExitTool(...args, options.onUserAttention),
        renderShell: "self",
        renderCall(_args, theme, ctx) {
            if (ctx?.isPartial === false)
                return new Text("", 0, 0);
            return toolCallLine(theme, "plan", "exit");
        },
        renderResult(result, opts, theme, ctx) {
            if (opts.isPartial)
                return new Text("", 0, 0);
            const block = result.content.find((c) => c.type === "text");
            const text = block && "text" in block ? block.text : "";
            const isError = ctx.isError || (result as {
                isError?: boolean;
            }).isError === true;
            return toolResultLine(theme, { name: "plan", ok: !isError, arg: "exit", summary: resultSummary(result), expanded: opts.expanded, detail: text });
        },
    };
    const statusTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
        name: "plan-status",
        label: "Plan Status",
        description: "Return the draft path, revision, approval status, and handoff state while Plan mode is active.",
        parameters: EmptyPlanParams,
        execute: (...args) => calls.executeStatusTool(...args, options.onUserAttention),
        renderShell: "self",
        renderCall(_args, theme, ctx) {
            if (ctx?.isPartial === false)
                return new Text("", 0, 0);
            return toolCallLine(theme, "plan", "status");
        },
        renderResult(result, opts, theme, ctx) {
            if (opts.isPartial)
                return new Text("", 0, 0);
            const block = result.content.find((c) => c.type === "text");
            const text = block && "text" in block ? block.text : "";
            const isError = ctx.isError || (result as {
                isError?: boolean;
            }).isError === true;
            return toolResultLine(theme, { name: "plan", ok: !isError, arg: "status", summary: resultSummary(result), expanded: opts.expanded, detail: text });
        },
    };
    for (const tool of [enterTool, updateTool, reviewTool, confirmTool, decomposeTool, exitTool, statusTool]) {
        pi.registerTool(tool as ToolDefinition);
    }
}
function buildPlanEnterNote(): string {
    return [
        "<system-reminder>",
        "## Plan Mode Just Activated",
        "Plan mode was activated (via user toggle or plan-enter). The tool surface is UNCHANGED for prompt-cache stability,",
        "and the tool-call hook blocks only the built-in file-editing tools (Write/Edit) until approval.",
        "Keep planning read-only by convention: research, search, and inspect freely, but do not mutate",
        "project files, Workflow/Todo/Goal state, or external systems while shaping the draft.",
        "- Plan tools: plan-update, plan-review, plan-confirm, plan-exit, plan-status.",
        "",
        "Workflow: research → plan-update (persist draft) → plan-confirm (present to user) in the same turn.",
        "plan-confirm defaults to a human choice (execute, modify, discuss, or exit). Only a valid human /plan-auto grant preauthorizes the next confirm and immediate standalone/current execution; plan-update and plan-review never automatically approve.",
        "If the user wants changes: plan-update again, then plan-confirm again.",
        "plan-exit leaves Plan mode without approving; the draft is preserved.",
        "If the user challenges an unnecessary Plan, acknowledge the mismatch. If their intent is unclear, ask one focused question with ask-user-question about abandoning planning; on an explicit request to abandon it, use plan-exit. Do not force a full draft and confirmation solely because Plan mode was entered. Exit is not approval and does not waive any other gate.",
        "",
        // Restored in full rather than condensed: 896d036f thinned this guidance on the
        // premise that the tool panel was "the authoritative signal" for Plan mode, and
        // 2e7c19b2 then removed the panel change altogether. This note is now the only
        // channel, and being one-time it extends the cached prefix once instead of
        // invalidating it per turn — so there is no cache argument for keeping it terse.
        "Planning quality:",
        "- Ground every decision in codebase evidence, not assumption.",
        "- Align every user requirement with a planned outcome and a verifiable acceptance check; separate user-required outcomes and explicit locked constraints from agent-selected implementation means.",
        "- Prefer the smallest end-to-end path using existing authorities. Justify every blocking dependency by a requirement or confirmed material defect; risks and optional diagnostics/provenance/hardening are not automatic delivery gates. Make shared authorities available before their consumers need production-path acceptance.",
        "- Require every Plan to include an end-of-execution knowledge outcome: after implementation and",
        "  verification, assess the task execution for a reusable pitfall, failure lesson, trade-off, or",
        "  prescriptive constraint. Plan candidate staging only when the quality bar is met; otherwise require",
        "  an explicit zero-candidate result. Actual knowledge writes happen after approval in Act/Run mode.",
        "",
        "Agent boundary (Plan-mode work stays read-only — dispatch only read-only roles):",
        "- Never use plan-exit to bypass Plan-mode boundaries. Stay in Plan mode and reshape the work",
        "  to the read-only planning boundary; use plan-exit only when the user wants to abandon planning.",
        "- Standard flow (broad or uncertain scope): dispatch `explorer` ONCE with batched parallel",
        "  prompts; unless the cross-module escalation below applies, dispatch one `planner`, passing",
        "  each explorer result's exact `agent://` publication ID as an immutable briefing reference",
        "  (use a correlation ID only when latest-turn semantics are intentional), plus your distilled",
        "  evidence, resolved requirements, constraints, and every known red line (architecture invariants,",
        "  compatibility rules) as a mandatory first-round checklist so the plan passes review in one",
        "  round. Never re-dispatch planning from scratch; send targeted revision instructions to the same",
        "  planner instead.",
        "- Required-result barrier: if a required explorer/planner dispatch moves to background or a bounded",
        "  wait times out, do not begin final synthesis or call plan-update / plan-confirm. Wait for automatic",
        "  delivery or use one bounded observe wait until every required result is result-ready, then ensure",
        "  each result's content is present in the current context (inline or loaded from its exact immutable",
        "  publication ID) before composing or persisting the Plan.",
        "- Lightweight flow (small, well-understood task): skip agent exploration entirely — inspect the",
        "  code yourself with read/search tools, then either author the draft via plan-update directly or",
        "  make one `planner` call with that content injected. After spot-checking the result, go straight",
        "  to ask-user-question / plan-confirm.",
        "- Planner budget: the planner may call at most ONE nested read-only agent (prefer a pressure",
        "  review of its near-final draft on architecturally risky changes) and must apply the findings by",
        "  revising its own draft — no repeated review rounds, no delegate chains.",
        "- Multi-planner escalation (cross-module scope only): when explorer evidence shows real module",
        "  boundaries (>= 2 modules, interface contracts are the core risk), you may dispatch up to 3",
        "  planners in parallel — one per module, each with maxNestingDepth: 0 (sub-planners get no nested",
        "  agents) and a briefing carrying only that module's exact immutable explorer publication IDs",
        "  and distilled evidence; never use a task-name URI as durable briefing. Root owns cross-module",
        "  integration and synthesizes the final unified Plan (or designates one lead planner",
        "  for integration). Single-module scope stays one planner.",
        "- Do not use implementation-capable agents in Plan mode. The root agent owns user interaction,",
        "  evidence spot-checking, contract validation, plan-update, and plan-confirm; persist the returned",
        "  Markdown only after checking it against the planner role contract, and return incomplete drafts",
        "  to the same planner for targeted revision (except in the lightweight flow, where you may author",
        "  the small draft yourself).",
        "- Use ask-user-question only for genuine unresolved user-owned choices. Ask one focused question",
        "  when one choice remains; group related questions only when needed. Do not pad a batch or re-ask",
        "  settled requirements, and do not ask questions as plain assistant text.",
        "- Root performs one contract spot-check covering scope, boundaries, non-goals, requirements, and",
        "  acceptance checks. Send concrete gaps to the same planner as targeted revisions without starting",
        "  another review chain; unresolved risks must stay visible.",
        "- Keep the final Markdown decision-complete and directly consumable by an execution agent. Omit",
        "  interview logs, delegate transcripts, and generic boilerplate. Validate the planner's draft",
        "  against the planner role contract before persisting it; return incomplete drafts for revision.",
        "- Approval decomposes the locked Plan into an ordered Todo graph. Goal creation is optional:",
        "  never create one solely because the Plan was approved; use one only when cross-turn persistence,",
        "  a user-requested budget, or independent completion verification is genuinely needed and no active",
        "  Workflow Session already owns execution. A Todo may carry a Goal as a key quality gate, but most",
        "  Todos should complete without one.",
        "",
        // Injected as a one-time custom message (before_agent_start.message) so the
        // system prompt prefix stays stable for prompt-cache reuse.
        "This is a one-time notification injected at the next turn boundary. Subsequent turns will not re-announce Plan mode — this reminder is the only signal you get.",
        "</system-reminder>",
    ].join("\n");
}
function registerPlanCommand(pi: ExtensionAPI): void {
    pi.registerCommand("plan", {
        description: "Plan mode: /plan [<prompt>|exit|show|approve|clear|tools]",
        getArgumentCompletions(prefix: string) {
            const options = [
                { value: "exit", label: "exit", description: "Leave Plan mode and preserve draft" },
                { value: "show", label: "show", description: "Open editable Plan review" },
                { value: "approve", label: "approve", description: "Review, approve and implement" },
                { value: "clear", label: "clear", description: "Clear current Markdown draft" },
                { value: "tools", label: "tools", description: "Show active Plan tools" },
            ];
            const lower = prefix.trim().toLowerCase();
            return lower ? options.filter((option) => option.value.startsWith(lower)) : options;
        },
        handler: calls.executePlanCommand,
    });
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
return { syncModeStatus, refreshPlanModeStatus, isPlanMode, getMode, hasPlan, getPlanText, getPlanArtifactSummary, setPlanModeChangeListener, buildPlanExitMessage, buildPlanExitReminder, currentDetails, getPlanCompactionSnapshot, getPlanNewContextPayload, getPlanHandoffStatus, result, supersededResult, registerPlanTools, buildPlanEnterNote, registerPlanCommand, errorMessage };
}
