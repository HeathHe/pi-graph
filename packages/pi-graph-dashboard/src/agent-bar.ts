/**
 * Agent Bar and the legacy Session Bar facade implementation.
 *
 * Agent Bar consumes canonical local session endpoints and SessionUiState. The
 * compatibility exports at the bottom preserve the former AgentRow-based API.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { CockpitEndpoint } from "./endpoint-store.ts";
import type { SessionUiState } from "./session-ui-state.ts";
import { formatUnreadCount, type SessionTab } from "./session-tabs.ts";
import type { AgentRow } from "./types.ts";
import { effectiveAgentStatus, isCliAgent, type AgentDisplayStatus } from "./agents-store.ts";
import { visibleAgentRows } from "./stack-widget.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";
import { ownerDisplayToken } from "./window-autocomplete.ts";

export const SESSION_BAR_WIDGET_KEY = "cockpit-session-bar";
export const AGENT_BAR_WIDGET_KEY = SESSION_BAR_WIDGET_KEY;

/** Chip label for the main (root) session. */
export const MAIN_SESSION_LABEL = "main";

/** Stable compatibility order for legacy AgentRow callers. */
export function byStartOrder(a: AgentRow, b: AgentRow): number {
	return a.startedAt - b.startedAt || a.correlationId.localeCompare(b.correlationId);
}

export interface SessionBarDeps {
	getAgents: () => AgentRow[];
	/** Stable owner clock snapshot; render never reads the wall clock itself. */
	getNow: () => number;
	/** Whether the main (root) agent is currently working. */
	isMainRunning?: () => boolean;
	/** Current session shown at the right edge (@label + status color). */
	getCurrentSession?: () => { label: string; color: ThemeColor } | undefined;
}

export interface SessionBarHint {
	text: string;
	color?: ThemeColor;
}

export type SessionBarHintValue = string | SessionBarHint;

export interface AgentBarDeps {
	getEndpoints: () => readonly CockpitEndpoint[];
	getState: () => SessionUiState;
	getNow: () => number;
	isMainRunning?: () => boolean;
	getShortcutHint?: () => SessionBarHintValue | undefined;
}

export const AGENT_SESSION_COLORS = [
	"accent",
	"warning",
	"success",
	"mdLink",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
] as const satisfies readonly ThemeColor[];

/** Stable pseudo-random color per agent lifecycle identity; never flickers. */
export function assignedAgentColor(correlationId: string): ThemeColor {
	let hash = 2166136261;
	for (const char of correlationId) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return AGENT_SESSION_COLORS[(hash >>> 0) % AGENT_SESSION_COLORS.length];
}

export function agentSessionColor(row: AgentRow, now: number, stableStatus?: AgentDisplayStatus): ThemeColor {
	const status = stableStatus ?? effectiveAgentStatus(row, now);
	if (status === "done" || status === "sleeping" || status === "terminated") return "muted";
	if (status === "failed" || status === "stalled") return "error";
	return assignedAgentColor(row.correlationId);
}

/** Map an agent display status to a theme color slot. */
export function statusColor(status: AgentDisplayStatus): ThemeColor {
	switch (status) {
		case "running":
		case "retrying":
			return "warning";
		case "stalled":
		case "failed":
		case "terminated":
			return "error";
		case "done":
		case "result-ready":
			return "success";
		default:
			return "muted";
	}
}

/** Original chip shape retained exclusively for the legacy Session Bar facade. */
function legacyChip(label: string, active: boolean, color: ThemeColor, theme: Theme): string {
	const text = `@${label}`;
	return active
		? `${theme.fg(color, "▸")} ${theme.fg(color, theme.bold(text))}`
		: theme.fg(color, text);
}

export type AgentBarStatus = AgentDisplayStatus | "idle";

interface AgentBarTab extends SessionTab {
	status: AgentBarStatus;
	color: ThemeColor;
	/** The rail has one suffix slot: live tool name when present, otherwise localized state. */
	suffix: string;
	/** Last terminal outcome selects the status glyph, but never exposes its error message. */
	outcome?: "completed" | "failed" | "terminated";
	/** External CLI backend (ACP `cli/<tool>` route): shown as an accent badge after the label. */
	cli?: boolean;
}

function endpointStatus(endpoint: CockpitEndpoint, now: number, mainRunning: boolean): AgentBarStatus {
	if (endpoint.kind === "root") return mainRunning ? "running" : "idle";
	if (endpoint.agentRow) return effectiveAgentStatus(endpoint.agentRow, now);
	if (endpoint.externalAgent) return endpoint.externalAgent.status;
	if (endpoint.status === "sleeping") return "sleeping";
	if (endpoint.status === "settled") return "done";
	return "running";
}

function endpointColor(endpoint: CockpitEndpoint, status: AgentBarStatus, now: number): ThemeColor {
	if (endpoint.kind === "root") return status === "running" ? "warning" : "muted";
	if (endpoint.agentRow) return agentSessionColor(endpoint.agentRow, now, status === "idle" ? undefined : status);
	if (status === "done" || status === "sleeping" || status === "terminated") return "muted";
	if (status === "failed" || status === "stalled") return "error";
	return assignedAgentColor(endpoint.correlationId ?? endpoint.id);
}

function statusVisual(
	status: AgentBarStatus,
	outcome?: AgentBarTab["outcome"],
): { glyph: string; color: ThemeColor } {
	if (outcome === "completed") return { glyph: "✓", color: "success" };
	if (outcome === "failed") return { glyph: "✗", color: "error" };
	if (outcome === "terminated") return { glyph: "✗", color: "warning" };
	if (status === "failed") return { glyph: "✗", color: "error" };
	if (status === "stalled") return { glyph: "!", color: "error" };
	if (status === "terminated") return { glyph: "✗", color: "warning" };
	if (status === "done" || status === "result-ready") return { glyph: "✓", color: "success" };
	if (status === "retrying") return { glyph: "↻", color: "warning" };
	if (status === "running") return { glyph: "●", color: "warning" };
	if (status === "pending") return { glyph: "○", color: "dim" };
	return { glyph: "○", color: "muted" };
}

function railChip(tab: AgentBarTab, active: boolean, theme: Theme): string {
	const visual = statusVisual(tab.status, tab.outcome);
	const selected = active ? `${theme.fg("accent", "▸")} ` : "";
	const status = theme.fg(visual.color, visual.glyph);
	const identity = theme.fg(tab.color, active ? theme.bold(`@${tab.label}`) : `@${tab.label}`);
	const cli = tab.cli ? theme.fg("accent", ` ${tuiT("widget.agent.cli")}`) : "";
	const unreadCount = tab.unread ?? 0;
	const unread = unreadCount > 0 ? theme.fg("warning", ` •${formatUnreadCount(unreadCount)}`) : "";
	const suffix = tab.suffix ? theme.fg("dim", ` · ${tab.suffix}`) : "";
	return `${selected}${status} ${identity}${cli}${unread}${suffix}`;
}

export interface AgentBarRenderOptions {
	mainRunning?: boolean;
	now?: number;
	shortcutHint?: SessionBarHintValue;
}

/** Chip-to-chip separator in the agent bar. */
const CHIP_SEPARATOR = "  ";

/**
 * One-line horizontal panning for the agent chip list. When the chips overflow
 * the width, the window is anchored so the selected chip sits at the right edge
 * with as many preceding chips as fit, and dim ◀N / N▶ markers count what stays
 * hidden on each side — arrow-cycling always keeps the highlighted selection
 * and its context visible no matter how many agents exist.
 */
function renderAgentChipLine(tabs: AgentBarTab[], selectedId: string, width: number, theme: Theme): string {
	if (width <= 0 || tabs.length === 0) return "";
	const w = width;
	const selectedIndex = Math.max(0, tabs.findIndex((tab) => tab.id === selectedId));
	const chips = tabs.map((tab) => railChip(tab, tab.id === selectedId, theme));
	const chipWidths = chips.map((text) => visibleWidth(text));
	const sepWidth = visibleWidth(CHIP_SEPARATOR);
	const totalWidth = chipWidths.reduce((sum, chipWidth) => sum + chipWidth + sepWidth, 0) - sepWidth;
	if (totalWidth <= w) return chips.join(CHIP_SEPARATOR);

	const selectedWidth = chipWidths[selectedIndex] ?? 0;
	// Farthest-left start whose window [start..selectedIndex] still fits budget.
	const fitStart = (budget: number): number => {
		let start = selectedIndex;
		let acc = selectedWidth;
		while (start > 0) {
			const next = chipWidths[start - 1] ?? 0;
			if (acc + sepWidth + next > budget) break;
			acc += sepWidth + next;
			start -= 1;
		}
		return start;
	};

	let start = fitStart(w);
	// Markers are sized from the window itself; a wider marker shrinks the
	// budget, which moves the start right, which can widen the left marker.
	// Start only ever moves right, so this converges and terminates.
	for (;;) {
		const leftHidden = start;
		const rightHidden = tabs.length - selectedIndex - 1;
		const leftMarker = leftHidden > 0 ? theme.fg("dim", `◀${leftHidden}`) : "";
		const rightMarker = rightHidden > 0 ? theme.fg("dim", `${rightHidden}▶`) : "";
		const markerCount = (leftMarker ? 1 : 0) + (rightMarker ? 1 : 0);
		const budget = w - visibleWidth(leftMarker) - visibleWidth(rightMarker) - markerCount * sepWidth;
		if (budget < selectedWidth) {
			// Too narrow for the selected chip beside the markers: show it alone.
			return truncateToWidth(chips[selectedIndex] ?? "", w, "…");
		}
		const next = fitStart(budget);
		if (next === start) {
			const window = chips.slice(start, selectedIndex + 1);
			return [leftMarker, ...window, rightMarker].filter(Boolean).join(CHIP_SEPARATOR);
		}
		start = next;
	}
}

/** Keep the mode-switch hint at the right edge without hiding the selected tab. */
export function renderSessionBarLine(
	renderContent: (width: number) => string,
	width: number,
	theme: Theme,
	shortcutHint?: SessionBarHintValue,
): string {
	// A live main-screen row must not write the terminal's final column: doing so
	// arms auto-wrap, while pi-tui still tracks the cursor on the original row.
	const w = Math.max(0, width - 1);
	if (w === 0) return "";
	if (!shortcutHint) return renderContent(w);
	const hintSpec = typeof shortcutHint === "string" ? { text: shortcutHint, color: "dim" as const } : shortcutHint;
	const hint = theme.fg(hintSpec.color ?? "dim", hintSpec.text);
	const hintWidth = visibleWidth(hint);
	const gap = 2;
	if (w < hintWidth + gap + 8) return renderContent(w);
	const contentWidth = w - hintWidth - gap;
	const content = renderContent(contentWidth);
	const padding = Math.max(gap, w - visibleWidth(content) - hintWidth);
	return `${content}${" ".repeat(padding)}${hint}`;
}

/** Render canonical main + local-agent chips with selection highlight and horizontal panning. */
export function renderAgentBar(
	endpoints: readonly CockpitEndpoint[],
	state: SessionUiState,
	width: number,
	theme: Theme,
	options: AgentBarRenderOptions = {},
): string[] {
	if (endpoints.length === 0) {
		const status: AgentBarStatus = options.mainRunning ? "running" : "idle";
		const fallback: AgentBarTab = {
			id: "root",
			label: MAIN_SESSION_LABEL,
			ordinal: 0,
			unread: 0,
			status,
			color: status === "running" ? "warning" : "muted",
			suffix: tuiStatus(status),
		};
		return [renderSessionBarLine(
			(availableWidth) => truncateToWidth(railChip(fallback, true, theme), availableWidth, "…"),
			width,
			theme,
			options.shortcutHint,
		)];
	}
	const now = options.now ?? 0;
	// A stale selection (id no longer in the endpoint list) must not leave the
	// bar without a highlighted chip: fall back to root / first endpoint.
	const fallbackId = endpoints.find((endpoint) => endpoint.kind === "root")?.id ?? endpoints[0]?.id;
	const requestedId = state.selectedId("agent");
	const selectedId = requestedId && endpoints.some((endpoint) => endpoint.id === requestedId)
		? requestedId
		: fallbackId;
	const tabs: AgentBarTab[] = endpoints.map((endpoint) => {
		const status = endpointStatus(endpoint, now, options.mainRunning === true);
		const liveAgent = endpoint.kind === "agent" && (status === "running" || status === "retrying");
		const activeTool = liveAgent ? endpoint.agentRow?.activeTool ?? endpoint.externalAgent?.activeTool : undefined;
		const outcome = status === "done" || status === "failed" || status === "terminated" || status === "sleeping"
			? endpoint.agentRow?.lastOutcome?.status
			: undefined;
		const ownerId = endpoint.kind === "root" ? endpoint.registryEndpoint?.ownerId : undefined;
		return {
			id: endpoint.id,
			label: ownerId ? ownerDisplayToken(endpoint.label, ownerId) : endpoint.label,
			ordinal: endpoint.ordinal,
			unread: state.endpoint(endpoint.id).unread,
			status,
			color: endpointColor(endpoint, status, now),
			suffix: liveAgent
				? activeTool ? truncateToWidth(activeTool, 18, "…") : ""
				: tuiStatus(status),
			...(outcome ? { outcome } : {}),
			...(endpoint.agentRow && isCliAgent(endpoint.agentRow) ? { cli: true } : {}),
		};
	});
	return [renderSessionBarLine(
		(availableWidth) => renderAgentChipLine(tabs, selectedId, availableWidth, theme),
		width,
		theme,
		options.shortcutHint,
	)];
}

export function makeAgentBarWidget(deps: AgentBarDeps) {
	return (_tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			return renderAgentBar(deps.getEndpoints(), deps.getState(), width, theme, {
				mainRunning: deps.isMainRunning?.(),
				now: deps.getNow(),
				shortcutHint: deps.getShortcutHint?.(),
			});
		},
		invalidate(): void {},
		dispose(): void {},
	});
}

export interface SessionBarRenderOptions {
	mainRunning?: boolean;
	current?: { label: string; color: ThemeColor } | undefined;
	now?: number;
	stableStatuses?: Map<string, AgentDisplayStatus>;
}

/** Legacy AgentRow-based pure renderer retained for downstream compatibility. */
export function renderSessionBar(
	rows: AgentRow[],
	width: number,
	theme: Theme,
	opts: SessionBarRenderOptions = {},
): string[] {
	const agents = visibleAgentRows(rows).sort(byStartOrder);
	const viewingId = agents.find((row) => row.viewing)?.correlationId;
	const now = opts.now ?? agents.reduce((latest, row) => Math.max(latest, row.lastActivityAt), 0);
	const liveIds = new Set(agents.map((row) => row.correlationId));
	if (opts.stableStatuses) {
		for (const id of opts.stableStatuses.keys()) {
			if (!liveIds.has(id)) opts.stableStatuses.delete(id);
		}
	}
	const chips = [
		legacyChip(
			MAIN_SESSION_LABEL,
			viewingId === undefined,
			viewingId === undefined ? "accent" : opts.mainRunning ? "warning" : "muted",
			theme,
		),
		...agents.map((row) => {
			const label = row.name || row.role || row.agent || "agent";
			const nextStatus = effectiveAgentStatus(row, now);
			const previousStatus = opts.stableStatuses?.get(row.correlationId);
			const stableStatus = previousStatus === nextStatus ? previousStatus : nextStatus;
			opts.stableStatuses?.set(row.correlationId, stableStatus);
			const color = agentSessionColor(row, now, stableStatus);
			return legacyChip(label, row.correlationId === viewingId, color, theme);
		}),
	];
	const w = Math.max(1, width);
	const chipsLine = chips.join("  ");
	const rawStatus = opts.current
		? theme.fg(opts.current.color, `● @${opts.current.label}`)
		: "";
	if (!rawStatus) {
		return [truncateToWidth(chipsLine, w, "…")];
	}
	const status = truncateToWidth(rawStatus, w, "…");
	const measuredStatus = visibleWidth(status);
	if (measuredStatus >= w) return [status];
	const leftBudget = Math.max(0, w - measuredStatus - 2);
	if (leftBudget === 0) return [" ".repeat(w - measuredStatus) + status];
	const left = truncateToWidth(chipsLine, leftBudget, "…");
	const pad = Math.max(0, w - visibleWidth(left) - measuredStatus);
	return [left + " ".repeat(pad) + status];
}

export function makeSessionBarWidget(deps: SessionBarDeps) {
	const stableStatuses = new Map<string, AgentDisplayStatus>();
	return (_tui: TUI, theme: Theme) => ({
		render(width: number): string[] {
			return renderSessionBar(deps.getAgents(), width, theme, {
				mainRunning: deps.isMainRunning?.(),
				current: deps.getCurrentSession?.(),
				now: deps.getNow(),
				stableStatuses,
			});
		},
		invalidate(): void {},
		dispose(): void {},
	});
}
