import {QuotaOwner} from 'pi-graph-observability/usage';
import type {QuotaObservation,QuotaProviderPort,Clock,ScopeLease} from 'pi-graph-observability';
import {legacyQuotaData,quotaCredentialFingerprint,fetchCredentialQuota} from '../observability/quota-provider-adapter.ts';
/**
 * Usage bars subsystem for pi-cockpit.
 *
 * Ports the hknet/pi-usage-bars extension's status/command surface into the
 * Cockpit. The fetching and parsing layer lives in ./core.ts (a verbatim port
 * of the upstream core.ts). This module owns:
 *
 *   - the active-provider quota/balance/spend snapshot (polled at
 *     config.usage.pollIntervalMs; 0 switches to manual refresh — no
 *     background polling, no footer bar, /usage fetches on open and on `r`),
 *   - the synchronous `getStatus(theme, barWidth)` string the Cockpit footer
 *     renders on a dedicated line (the upstream wrote this through
 *     ctx.ui.setStatus; Cockpit renders it inline so the bar is themed and
 *     collapse-controlled like the rest of the footer),
 *   - the `/usage` selector overlay (UsageSelectorComponent, unchanged),
 *   - the `--usage` one-shot flag for a non-interactive credential/endpoint
 *     smoke test.
 *
 * Lifecycle is owned by Cockpit's index.ts (it already owns session_start /
 * model_select / session_shutdown). This factory returns a controller object;
 * it does not register its own event listeners so there is no second
 * session_start listener fighting Cockpit's own.
 */

import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Spacer,
	Text,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	clampPercent,
	colorForPercent,
	detectProvider,
	providerToPiProviderId,
	resolveUsageEndpoints,
	type AccountBalance,
	type AccountSpend,
	type ProviderKey,
	type UsageByProvider,
} from "./core.ts";
import { buildTrend, readUsageHistory, type TrendSummary, type UsageRecord } from "./history.ts";
import { renderThemeSparkline } from "./sparkline.ts";
import { type CockpitConfig, DEFAULT_CONFIG } from "../types.ts";

const EXTENSION_ID = "pi-cockpit:usage-bars";
const USAGE_UPDATE_EVENT = `${EXTENSION_ID}:update`;
const PROVIDERS: readonly ProviderKey[] = [
	"chatgpt",
	"codex",
	"claude",
	"zai",
	"zai-cn",
	"kimi",
	"minimax",
	"minimax-cn",
	"openrouter",
	"deepseek",
	"moonshot",
	"moonshot-cn",
];

const PROVIDER_LABELS: Record<ProviderKey, string> = {
	chatgpt: "ChatGPT (official)",
	codex: "Codex",
	claude: "Claude",
	zai: "ZAI Coding Plan (Global)",
	"zai-cn": "ZAI Coding Plan (China)",
	kimi: "Kimi For Coding",
	minimax: "MiniMax Coding Plan (Global)",
	"minimax-cn": "MiniMax Coding Plan (China)",
	openrouter: "OpenRouter",
	deepseek: "DeepSeek",
	moonshot: "Moonshot/Kimi API (Global)",
	"moonshot-cn": "Moonshot/Kimi API (China)",
};

function formatFinancialAmount(amount: number, unit: string): string {
	if (/^[A-Z]{3}$/.test(unit)) {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: unit,
			minimumFractionDigits: 2,
			maximumFractionDigits: 5,
		}).format(amount);
	}
	const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount);
	return `${formatted} ${unit}`;
}

function formatAccountBalance(balance: AccountBalance): string {
	return `${balance.label} · ${formatFinancialAmount(balance.amount, balance.unit)}`;
}

function formatAccountSpend(spend: AccountSpend): string {
	const values = [
		spend.daily === undefined ? undefined : `today ${formatFinancialAmount(spend.daily, spend.unit)}`,
		spend.weekly === undefined ? undefined : `week ${formatFinancialAmount(spend.weekly, spend.unit)}`,
		spend.monthly === undefined ? undefined : `month ${formatFinancialAmount(spend.monthly, spend.unit)}`,
	].filter((value): value is string => Boolean(value));
	if (values.length === 0 && spend.lifetime !== undefined) {
		values.push(`lifetime ${formatFinancialAmount(spend.lifetime, spend.unit)}`);
	}
	return `Spent · ${values.join(" · ")}`;
}

interface SubscriptionItem {
	name: string;
	provider: ProviderKey;
	data: UsageDataLike;
	isActive: boolean;
	/** Per-provider 7-day token trend from the api-manager usage-history store. */
	trend?: TrendSummary;
}

interface CredentialResolution {
	fingerprint: string;
	token?: string;
	error?: string;
}

/**
 * Footprint of the data the selector overlay needs from each provider. It is a
 * structural subset of the upstream UsageData so this module does not re-import
 * the full interface for the overlay's render path.
 */
type UsageDataLike = {
	session: number;
	weekly: number;
	quotaHidden?: boolean;
	sessionHidden?: boolean;
	weeklyHidden?: boolean;
	sessionLabel?: string;
	weeklyLabel?: string;
	sessionResetsIn?: string;
	weeklyResetsIn?: string;
	accountBalance?: AccountBalance;
	accountBalanceDetails?: AccountBalance[];
	accountSpend?: AccountSpend;
	notice?: string;
	extraSpend?: number;
	extraLimit?: number;
	warning?: string;
	stale?: boolean;
	error?: string;
};

class UsageSelectorComponent extends Container implements Focusable {
	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private readonly hintText: Text;
	private readonly requestController = new AbortController();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onCancelCallback: () => void;
	private readonly onTogglePolling: () => boolean;
	private pollingEnabled: boolean;
	private readonly activeProvider: ProviderKey | null;
	private readonly fetchAllFn: (signal: AbortSignal) => Promise<UsageByProvider>;
	private allItems: SubscriptionItem[] = [];
	private filteredItems: SubscriptionItem[] = [];
	private selectedIndex = 0;
	private viewportStart = 0;
	private loading = true;
	private hint: "loading" | "ready" | "error" = "loading";
	private disposed = false;
	private _focused = false;

	/** Whether an initial or `r`-triggered refetch is still in flight. */
	isLoading(): boolean {
		return this.loading;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		activeProvider: ProviderKey | null,
		fetchAll: (signal: AbortSignal) => Promise<UsageByProvider>,
		onCancel: () => void,
		onTogglePolling: () => boolean,
		pollingEnabled: boolean,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.activeProvider = activeProvider;
		this.fetchAllFn = fetchAll;
		this.onCancelCallback = onCancel;
		this.onTogglePolling = onTogglePolling;
		this.pollingEnabled = pollingEnabled;

		this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		this.addChild(new Spacer(1));
		this.hintText = new Text("", 0, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		this.updateHint();
		this.updateList();
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			const [results, historyByProvider] = await Promise.all([
				this.fetchAllFn(this.requestController.signal),
				readUsageHistory().then((records) => this.groupHistoryByProvider(records)),
			]);
			if (this.disposed || this.requestController.signal.aborted) return;
			this.loading = false;
			this.hint = "ready";
			this.buildItems(results, historyByProvider);
		} catch {
			if (this.disposed || this.requestController.signal.aborted) return;
			this.loading = false;
			this.hint = "error";
		}
		this.updateHint();
		this.updateList();
		this.tui.requestRender();
	}

	private updateHint(): void {
		if (this.hint === "loading") {
			this.hintText.setText(this.theme.fg("dim", "Fetching quota, balance, and spend from configured providers…"));
		} else if (this.hint === "error") {
			this.hintText.setText(this.theme.fg("error", "Failed to fetch usage data"));
		} else {
			const pollState = this.pollingEnabled
				? this.theme.fg("success", "polling on")
				: this.theme.fg("warning", "polling off");
			this.hintText.setText(
				this.theme.fg("muted", "Only showing configured usage providers. ") +
					this.theme.fg("dim", "✓ = active provider · r = refresh · p = poll: ") + pollState,
			);
		}
	}

	private groupHistoryByProvider(records: UsageRecord[]): Partial<Record<ProviderKey, TrendSummary>> {
		const byPiProviderId = new Map<string, UsageRecord[]>();
		for (const record of records) {
			const bucket = byPiProviderId.get(record.provider) ?? [];
			bucket.push(record);
			byPiProviderId.set(record.provider, bucket);
		}
		const trends: Partial<Record<ProviderKey, TrendSummary>> = {};
		for (const provider of PROVIDERS) {
			const piId = providerToPiProviderId(provider);
			const providerRecords = byPiProviderId.get(piId) ?? [];
			const trend = buildTrend(providerRecords, 7);
			if (trend) trends[provider] = trend;
		}
		return trends;
	}

	private buildItems(results: UsageByProvider, trends?: Partial<Record<ProviderKey, TrendSummary>>): void {
		this.allItems = PROVIDERS.flatMap((provider) => {
			const data = results[provider];
			return data
				? [{
					name: PROVIDER_LABELS[provider],
					provider,
					data: data as unknown as UsageDataLike,
					isActive: this.activeProvider === provider,
					trend: trends?.[provider],
				}]
				: [];
		});
		this.filteredItems = this.allItems;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.ensureSelectedVisible();
	}

	private filterItems(query: string): void {
		const normalized = query.trim().toLowerCase();
		this.filteredItems = normalized
			? this.allItems.filter((item) =>
				item.name.toLowerCase().includes(normalized) || item.provider.includes(normalized))
			: this.allItems;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.viewportStart = 0;
		this.ensureSelectedVisible();
	}

	private viewportSize(): number {
		// Leave room for the frame, search input, hints, and expanded details for
		// the selected provider. Keeping the provider list bounded avoids pushing
		// the custom UI beyond short terminal viewports.
		return Math.max(1, Math.min(8, this.tui.terminal.rows - 14));
	}

	private ensureSelectedVisible(): void {
		const size = this.viewportSize();
		if (this.selectedIndex < this.viewportStart) this.viewportStart = this.selectedIndex;
		if (this.selectedIndex >= this.viewportStart + size) {
			this.viewportStart = this.selectedIndex - size + 1;
		}
		this.viewportStart = Math.max(0, Math.min(
			this.viewportStart,
			Math.max(0, this.filteredItems.length - size),
		));
	}

	private moveSelection(delta: number): void {
		if (this.filteredItems.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.filteredItems.length - 1, this.selectedIndex + delta));
		this.ensureSelectedVisible();
		this.refresh();
	}

	private renderBar(percent: number, width = 16): string {
		const value = clampPercent(percent);
		const filled = Math.round((value / 100) * width);
		return this.theme.fg(colorForPercent(value), "█".repeat(filled)) +
			this.theme.fg("dim", "░".repeat(width - filled));
	}

	private renderItem(item: SubscriptionItem, selected: boolean): void {
		const theme = this.theme;
		const pointer = selected ? theme.fg("accent", "→ ") : "  ";
		const activeBadge = item.isActive ? theme.fg("success", " ✓") : "";
		const name = selected ? theme.fg("accent", theme.bold(item.name)) : item.name;
		this.listContainer.addChild(new Text(`${pointer}${name}${activeBadge}`, 0, 0));
		if (!selected) return;

		const indent = "    ";
		if (item.data.error) {
			this.listContainer.addChild(new Text(indent + theme.fg("error", item.data.error), 0, 0));
		} else {
			const session = clampPercent(item.data.session);
			const weekly = clampPercent(item.data.weekly);
			const sessionReset = item.data.sessionResetsIn
				? theme.fg("dim", `  resets in ${item.data.sessionResetsIn}`)
				: "";
			const weeklyReset = item.data.weeklyResetsIn
				? theme.fg("dim", `  resets in ${item.data.weeklyResetsIn}`)
				: "";
			const sessionLabel = (item.data.sessionLabel ?? "Session").slice(0, 9).padEnd(10);
			const weeklyLabel = (item.data.weeklyLabel ?? "Weekly").slice(0, 9).padEnd(10);

			if (!item.data.quotaHidden) {
				if (!item.data.sessionHidden) {
					this.listContainer.addChild(new Text(
						indent + theme.fg("muted", sessionLabel) + this.renderBar(session) + " " +
							theme.fg(colorForPercent(session), `${session}%`.padStart(4)) + sessionReset,
						0, 0,
					));
				}
				if (!item.data.weeklyHidden) {
					this.listContainer.addChild(new Text(
						indent + theme.fg("muted", weeklyLabel) + this.renderBar(weekly) + " " +
							theme.fg(colorForPercent(weekly), `${weekly}%`.padStart(4)) + weeklyReset,
						0, 0,
					));
				}
			}
			if (item.data.accountBalance) {
				this.listContainer.addChild(new Text(
					indent + theme.fg("muted", formatAccountBalance(item.data.accountBalance)),
					0, 0,
				));
			}
			for (const balance of item.data.accountBalanceDetails ?? []) {
				this.listContainer.addChild(new Text(
					indent + theme.fg("dim", formatAccountBalance(balance)),
					0, 0,
				));
			}
			if (item.data.accountSpend) {
				this.listContainer.addChild(new Text(
					indent + theme.fg("muted", formatAccountSpend(item.data.accountSpend)),
					0, 0,
				));
			}
			if (item.data.notice) {
				this.listContainer.addChild(new Text(indent + theme.fg("muted", item.data.notice), 0, 0));
			}

			if (typeof item.data.extraSpend === "number" && typeof item.data.extraLimit === "number") {
				this.listContainer.addChild(new Text(
					indent + theme.fg("muted", "Extra    ") +
						theme.fg("dim", `$${item.data.extraSpend.toFixed(2)} / $${item.data.extraLimit}`),
					0, 0,
				));
			}
			if (item.data.warning) {
				this.listContainer.addChild(new Text(indent + theme.fg("warning", `⚠ ${item.data.warning}`), 0, 0));
			}
			this.renderTrend(item);
		}
		this.listContainer.addChild(new Spacer(1));
	}

	/** Format a token count compactly (1.4m / 3.2k / 890). */
	private formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
		return String(n);
	}

	/**
	 * Render the per-provider 7-day token trend section (sparkline + summary +
	 * top models) sourced from the api-manager usage-history store. Omitted
	 * entirely when there is no history for the provider in the window.
	 */
	private renderTrend(item: SubscriptionItem): void {
		const trend = item.trend;
		if (!trend) return;
		const theme = this.theme;
		const indent = "    ";
		const series = trend.unknownFields?.includes("tokens") ? [] : trend.daily.map((bucket) => bucket.tokens);
		const sparkline = trend.unknownFields?.includes("tokens") ? theme.fg("dim","history unavailable") : renderThemeSparkline(series, theme, { width: 12, color: "accent" });
		if (!sparkline) return;
		const avgTurns = trend.avgTurnsPerDay > 0 ? Math.round(trend.avgTurnsPerDay * 10) / 10 : 0;
		this.listContainer.addChild(new Text(
			indent + theme.fg("muted", "Last 7d  ") + sparkline + "  " +
				theme.fg("text", `${trend.unknownFields?.includes("tokens")?"unknown":this.formatTokens(trend.totalTokens)} tok`) +
				theme.fg("dim", " · ") +
				theme.fg("warning", trend.unknownFields?.includes("cost")?"cost unknown":`$${trend.totalCost.toFixed(2)}`) +
				theme.fg("dim", " · ") +
				theme.fg("dim", `${avgTurns} turns/day`),
			0, 0,
		));
		if (trend.topModels.length > 0) {
			const parts = trend.topModels.map((m) =>
				`${theme.fg("text", m.model)} ${theme.fg("muted", `${Math.round(m.share * 100)}%`)}`);
			this.listContainer.addChild(new Text(
				indent + theme.fg("muted", "Top model  ") + parts.join(theme.fg("dim", " · ")),
				0, 0,
			));
		}
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.loading) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  Loading…"), 0, 0));
			return;
		}
		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching configured providers"), 0, 0));
			return;
		}
		this.ensureSelectedVisible();
		const size = this.viewportSize();
		const end = Math.min(this.filteredItems.length, this.viewportStart + size);
		if (this.viewportStart > 0) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", `  ↑ ${this.viewportStart} more`), 0, 0));
		}
		for (let index = this.viewportStart; index < end; index += 1) {
			this.renderItem(this.filteredItems[index]!, index === this.selectedIndex);
		}
		if (end < this.filteredItems.length) {
			this.listContainer.addChild(new Text(
				this.theme.fg("dim", `  ↓ ${this.filteredItems.length - end} more`),
				0, 0,
			));
		}
	}

	private refresh(): void {
		this.updateList();
		this.tui.requestRender();
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredItems.length > 0) {
				this.selectedIndex = this.selectedIndex === 0
					? this.filteredItems.length - 1
					: this.selectedIndex - 1;
				this.ensureSelectedVisible();
				this.refresh();
			}
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredItems.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1
					? 0
					: this.selectedIndex + 1;
				this.ensureSelectedVisible();
				this.refresh();
			}
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.pageUp")) {
			this.moveSelection(-this.viewportSize());
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.pageDown")) {
			this.moveSelection(this.viewportSize());
			return;
		}
		if (
			this.keybindings.matches(keyData, "tui.select.cancel") ||
			this.keybindings.matches(keyData, "tui.select.confirm")
		) {
			this.onCancelCallback();
			return;
		}

		// Toggle background polling (persisted to cockpit.json). `p` only acts
		// when the search box is empty, mirroring the `r` refresh convention.
		if (keyData === "p" && this.searchInput.getValue() === "") {
			this.pollingEnabled = this.onTogglePolling();
			this.updateHint();
			this.tui.requestRender();
			return;
		}

		// Manual refetch: plain `r` with an empty search box re-runs load();
		// once the filter has text, `r` stays an ordinary search character.
		if (keyData === "r" && this.searchInput.getValue() === "" && !this.loading) {
			this.loading = true;
			this.hint = "loading";
			this.updateHint();
			this.updateList();
			this.tui.requestRender();
			void this.load();
			return;
		}

		this.searchInput.handleInput(keyData);
		this.filterItems(this.searchInput.getValue());
		this.refresh();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHint();
		this.updateList();
	}

	dispose(): void {
		this.disposed = true;
		this.requestController.abort();
	}
}

interface UsageState extends UsageByProvider {
	activeProvider: ProviderKey | null;
	available: Partial<Record<ProviderKey, boolean>>;
}

export interface UsageSubsystem {
	/** Called from Cockpit's session_start handler. May call ctx.shutdown() for the --usage flag. */
	start(ctx: ExtensionContext): Promise<void>;
	/** Called from Cockpit's session_shutdown handler. */
	stop(ctx: ExtensionContext): void;
	/** Called from Cockpit's model_select handler. */
	onModelSelect(ctx: ExtensionContext, model: ExtensionContext["model"]): void;
	/** Open the /usage selector overlay. Returns when the overlay closes. */
	openCommand(ctx: ExtensionContext): Promise<void>;
	/** Synchronous footer snapshot string, or undefined when nothing should render. */
	getStatus(theme: Theme, barWidth: number): string | undefined;
	/** Force an immediate poll refresh (e.g. after a config change). */
	refresh(): void;
	/** Reschedule the periodic poll timer with the current pollIntervalMs. */
	rescheduleTimer(): void;
	/** Toggle background polling on/off (persisted via setPollIntervalMs). Returns true when polling is now on. */
	togglePolling(): boolean;
	/** Abort everything and drop timers. */
	dispose(): void;
}

export interface CreateUsageSubsystemOptions {
	pi: ExtensionAPI;
	/** Live config getter so pollIntervalMs / barWidth read fresh each cycle. */
	getConfig: () => CockpitConfig;
	/** Invoked when the footer snapshot may have changed, so Cockpit re-renders. */
	onStatusChange: () => void;
	/**
	 * Persist a pollIntervalMs change to cockpit.json (0 = manual refresh).
	 * Return true on success. Optional: when omitted, the overlay's `p` toggle
	 * only affects the in-memory config for the current session.
	 */
	setPollIntervalMs?: (ms: number) => boolean;
	/** Host clock/provider seams; tests supply virtual time and bounded transport. */
	clock?: Clock;
	queryQuota?: (ctx: ExtensionContext, request: Parameters<QuotaProviderPort["fetch"]>[0]) => Promise<QuotaObservation>;
	/** Fixture transport remains below the real public ModelRegistry auth resolution. */
	fetchQuota?: typeof fetchCredentialQuota;
}

export function createUsageSubsystem(options: CreateUsageSubsystemOptions): UsageSubsystem {
	const { pi, getConfig, onStatusChange, setPollIntervalMs } = options;

	pi.registerFlag("usage", {
		description: "Print one-line usage for the active provider and exit",
		type: "boolean",
		default: false,
	});

	const endpoints = resolveUsageEndpoints();
	const state: UsageState = {
		chatgpt: null,
		codex: null,
		claude: null,
		zai: null,
		"zai-cn": null,
		kimi: null,
		minimax: null,
		"minimax-cn": null,
		openrouter: null,
		deepseek: null,
		moonshot: null,
		"moonshot-cn": null,
		activeProvider: null,
		available: {},
	};

	const isManualRefresh = () => getConfig().usage.pollIntervalMs <= 0;

	let currentContext: ExtensionContext | undefined;
	let sessionController: AbortController | undefined;
	let sessionEpoch = 0;
	const accountRevisions = new Map<ProviderKey, number>();
	const credentialFingerprints=new Map<ProviderKey,string>();
	const refreshQueued=new Set<ProviderKey>();
	const owners = new Map<ProviderKey, {owner: QuotaOwner; key: string; ctx: ExtensionContext}>();
	const clock: Clock = options.clock ?? {now: Date.now, schedule(ms, callback) {const timer=setTimeout(callback,ms); return {cancel:()=>clearTimeout(timer)};},scheduleBackground(ms,callback){const timer=setTimeout(callback,ms);timer.unref?.();return {cancel:()=>clearTimeout(timer)};}};
	const closeOwners=():void=>{for(const {owner} of owners.values())owner.close();owners.clear();};

	const renderPercent = (theme: Theme, value: number) => {
		const percent = clampPercent(value);
		return theme.fg(colorForPercent(percent), `${percent}%`);
	};

	const renderBar = (theme: Theme, value: number, width: number) => {
		const percent = clampPercent(value);
		const filled = Math.round((percent / 100) * width);
		return theme.fg(colorForPercent(percent), "█".repeat(filled)) +
			theme.fg("dim", "░".repeat(width - filled));
	};

	/**
	 * Pure status-string builder. Cockpit's footer calls getStatus(theme, barWidth)
	 * on every render; this never touches ctx.ui.setStatus, so the footer owns
	 * the line and its collapse/priority logic. Returns undefined when nothing
	 * should render (active provider unconfigured/unsupported).
	 */
	function buildStatus(theme: Theme, barWidth: number): string | undefined {
		// Manual refresh mode: nothing is polled, so the footer bar stays hidden.
		if (isManualRefresh()) return undefined;
		const provider = state.activeProvider;
		if (!provider || state.available[provider] === false) return undefined;

		const data = state[provider];
		const label = PROVIDER_LABELS[provider];
		if (!data) return theme.fg("dim", `${label} usage: loading…`);
		if (data.error) {
			return theme.fg("warning", `${label} usage unavailable (${data.error})`);
		}
		if (data.quotaHidden) {
			const financial = [
				data.accountBalance ? formatAccountBalance(data.accountBalance) : undefined,
				data.accountSpend?.monthly === undefined
					? undefined
					: `Month · ${formatFinancialAmount(data.accountSpend.monthly, data.accountSpend.unit)}`,
			].filter((value): value is string => Boolean(value));
			const summary = financial.length > 0 ? financial.join(" · ") : data.notice;
			return summary ? theme.fg("dim", `${label} `) + theme.fg("muted", summary) : undefined;
		}

		const session = clampPercent(data.session);
		const weekly = clampPercent(data.weekly);
		const sessionPrefix = data.sessionLabel === "5-hour"
			? "5h "
			: data.sessionLabel === "Interval"
				? "I "
				: data.sessionLabel === "Key limit"
					? "L "
					: "S ";
		const quotaLanes: string[] = [];
		if (!data.sessionHidden) {
			quotaLanes.push(
				theme.fg("muted", sessionPrefix) + renderBar(theme, session, barWidth) + " " + renderPercent(theme, session) +
					(data.sessionResetsIn ? theme.fg("dim", ` ⟳ ${data.sessionResetsIn}`) : ""),
			);
		}
		if (!data.weeklyHidden) {
			quotaLanes.push(
				theme.fg("muted", "W ") + renderBar(theme, weekly, barWidth) + " " + renderPercent(theme, weekly) +
					(data.weeklyResetsIn ? theme.fg("dim", ` ⟳ ${data.weeklyResetsIn}`) : ""),
			);
		}
		return theme.fg("dim", `${label} `) +
			quotaLanes.join(" ") +
			(data.accountBalance ? theme.fg("muted", ` · ${formatAccountBalance(data.accountBalance)}`) : "") +
			(data.accountSpend?.monthly === undefined
				? ""
				: theme.fg("muted", ` · Month ${formatFinancialAmount(data.accountSpend.monthly, data.accountSpend.unit)}`)) +
			(data.stale ? theme.fg("warning", " stale") : "") +
			(data.warning && !data.stale ? theme.fg("warning", " ⚠") : "");
	}

	function updateProviderFrom(model: ExtensionContext["model"]): boolean {
		const previous = state.activeProvider;
		state.activeProvider = detectProvider(model);
		if (previous !== state.activeProvider) {
			if(previous){owners.get(previous)?.owner.close();owners.delete(previous);}
			return true;
		}
		return false;
	}

	function isSubscriptionAuth(source: string | undefined): boolean {
		// Pi 0.84 exposes AuthResult.source as a human-readable label rather than a
		// credential-type discriminator. Keep the compatibility assumption in one
		// place until ModelRegistry exposes the resolved credential type directly.
		return source === "OAuth";
	}

	async function resolveCredential(ctx: ExtensionContext, provider: ProviderKey): Promise<CredentialResolution> {
		const providerId=providerToPiProviderId(provider);
		try{
			if(!ctx.modelRegistry.getProvider(providerId)||!ctx.modelRegistry.getProviderAuthStatus(providerId).configured)return {fingerprint:'unconfigured'};
			const resolved=await ctx.modelRegistry.getProviderAuth(providerId);
			if((provider==='claude'||provider==='chatgpt')&&!isSubscriptionAuth(resolved?.source))return {fingerprint:'unsupported-auth'};
			const auth=resolved?.auth;if(!auth)return {fingerprint:'unresolved-auth',error:'authentication unavailable'};
			const fingerprint=quotaCredentialFingerprint(auth);
			if(auth.apiKey)return {token:auth.apiKey,fingerprint};
			const authorization=auth.headers?.Authorization??auth.headers?.authorization;
			if(typeof authorization==='string'&&authorization.startsWith('Bearer '))return {token:authorization.slice('Bearer '.length),fingerprint};
			return {fingerprint,error:'configured authentication did not resolve a token'};
		}catch{return {fingerprint:'auth-error',error:'authentication unavailable'};}
	}
	function observeCredential(ctx:ExtensionContext,provider:ProviderKey,fingerprint:string):boolean {
		if(currentContext!==ctx)return false;
		const previous=credentialFingerprints.get(provider);credentialFingerprints.set(provider,fingerprint);
		if(previous===undefined||previous===fingerprint)return true;
		// Public SDK auth resolution is authoritative; the optional account event only accelerates this path.
		accountRevisions.set(provider,(accountRevisions.get(provider)??0)+1);
		owners.get(provider)?.owner.close();owners.delete(provider);state[provider]=null;delete state.available[provider];onStatusChange();
		if(provider===state.activeProvider&&!isManualRefresh()&&!refreshQueued.has(provider)){
			refreshQueued.add(provider);void Promise.resolve().then(()=>{refreshQueued.delete(provider);if(currentContext===ctx&&!sessionController?.signal.aborted)void poll();});
		}
		return false;
	}

	async function queryProvider(ctx:ExtensionContext,request:Parameters<QuotaProviderPort['fetch']>[0]):Promise<QuotaObservation> {
		if(options.queryQuota)return options.queryQuota(ctx,request);
		const {provider,signal}=request;
		const credential=await resolveCredential(ctx,provider);
		if(signal.aborted)return {status:'stale',observedAt:clock.now()};
		if(!observeCredential(ctx,provider,credential.fingerprint))return {status:'stale',observedAt:clock.now()};
		if(credential.error)return {status:'error',errorCode:'auth',observedAt:clock.now()};
		if(!credential.token)return {status:'unconfigured',observedAt:clock.now()};
		let data:import('./core.ts').UsageData;
		try{data=await (options.fetchQuota??fetchCredentialQuota)(provider,credential.token,{endpoints,signal});}
		catch{data=legacyQuotaData({error:'usage request unavailable'});}
		if(signal.aborted)return {status:'stale',observedAt:clock.now()};
		// Re-resolve before committing even an error: credentials can change without any SDK event.
		const verified=await resolveCredential(ctx,provider);
		if(signal.aborted)return {status:'stale',observedAt:clock.now()};
		if(!observeCredential(ctx,provider,verified.fingerprint)||verified.fingerprint!==credential.fingerprint)return {status:'stale',observedAt:clock.now()};
		if(verified.error)return {status:'error',errorCode:'auth',observedAt:clock.now()};

		if(data.error)return {status:'error',errorCode:/429|rate.limit/i.test(data.error)?'rate-limit':'unavailable',retryAfterMs:data.retryAfterMs,observedAt:clock.now()};
		return {status:data.stale?'stale':'known',data:{...data,session:data.sessionHidden||data.unknownFields?.includes('session')?undefined:data.session,weekly:data.weeklyHidden||data.unknownFields?.includes('weekly')?undefined:data.weekly},observedAt:clock.now()};
	}
	function ensureOwner(ctx:ExtensionContext,provider:ProviderKey,interval=0):QuotaOwner {
		const epoch=sessionEpoch,account=accountRevisions.get(provider)??0,sessionId=ctx.sessionManager.getSessionId();
		const key=JSON.stringify([epoch,sessionId,account,interval]);const existing=owners.get(provider);
		if(existing?.key===key&&existing.ctx===ctx)return existing.owner;
		existing?.owner.close();
		// This is a local observation lease, not a Teammate Root identity or execution authority.
		const lease:ScopeLease={scope:{sessionId,runtimeGeneration:epoch,ownerId:'cockpit-quota',incarnation:`local-${epoch}`},current:()=>sessionEpoch===epoch&&currentContext===ctx&&!sessionController?.signal.aborted&&(accountRevisions.get(provider)??0)===account};
		const owner=new QuotaOwner(clock,{fetch:request=>queryProvider(ctx,request)},10000,1000,false);
		owners.set(provider,{owner,key,ctx});
		owner.subscribe(()=>{
			if(!lease.current()||owners.get(provider)?.owner!==owner)return;
			const observation=owner.snapshot().value.observation;
			state.available[provider]=observation.status!=='unconfigured';
			state[provider]=observation.data?legacyQuotaData(observation.data):observation.status==='error'?legacyQuotaData({error:observation.errorCode??'unavailable'}):null;
			if(observation.status==='stale'&&state[provider])state[provider]!.stale=true;
			onStatusChange();
		});
		owner.configure(lease,provider,String(account),interval);return owner;
	}
	async function fetchProvider(ctx:ExtensionContext,provider:ProviderKey,signal:AbortSignal):Promise<void> {
		for(let attempt=0;attempt<2;attempt++){
			const capturedEpoch=sessionEpoch,capturedAccount=accountRevisions.get(provider)??0;
			const owner=ensureOwner(ctx,provider,ctx.mode==='tui'&&!isManualRefresh()&&provider===state.activeProvider?getConfig().usage.pollIntervalMs:0);
			const stop=()=>{owner.close();if(owners.get(provider)?.owner===owner)owners.delete(provider);};
			if(signal.aborted)return;signal.addEventListener('abort',stop,{once:true});
			try{await owner.poll();}finally{signal.removeEventListener('abort',stop);}
			if(signal.aborted||currentContext!==ctx||sessionEpoch!==capturedEpoch)return;
			if((accountRevisions.get(provider)??0)!==capturedAccount)continue;
			const data=state[provider];if(data&&!data.error)pi.events.emit(USAGE_UPDATE_EVENT,{provider,...data});return;
		}
	}

	async function poll():Promise<void>{const ctx=currentContext,signal=sessionController?.signal,provider=state.activeProvider;if(!ctx||!signal||signal.aborted||ctx.mode!=='tui'||!provider)return;await fetchProvider(ctx,provider,signal);}

	async function fetchAllForContext(ctx:ExtensionContext,signal:AbortSignal):Promise<UsageByProvider>{
		const capturedEpoch=sessionEpoch;
		const result=Object.fromEntries(PROVIDERS.map(provider=>[provider,null])) as UsageByProvider;
		await Promise.all(PROVIDERS.map(async provider=>{if(signal.aborted)return;const account=accountRevisions.get(provider)??0;await fetchProvider(ctx,provider,signal);if(!signal.aborted&&currentContext===ctx&&sessionEpoch===capturedEpoch&&(accountRevisions.get(provider)??0)===account)result[provider]=state[provider];}));
		if(signal.aborted||sessionEpoch!==capturedEpoch||currentContext!==ctx)throw new DOMException('Aborted','AbortError');return result;
	}

	/**
	 * Toggle background polling on/off and persist it via setPollIntervalMs.
	 * On → default interval; off → 0 (manual refresh only). Returns the new
	 * polling state so the overlay can re-render its hint.
	 */
	function togglePolling(): boolean {
		const next = isManualRefresh() ? DEFAULT_CONFIG.usage.pollIntervalMs : 0;
		const ok = setPollIntervalMs ? setPollIntervalMs(next) : true;
		if (ok) {
			schedulePollTimer();
			if (next > 0) void poll();
			onStatusChange();
		}
		return next > 0;
	}

	function schedulePollTimer():void {const ctx=currentContext,provider=state.activeProvider;if(ctx&&provider)ensureOwner(ctx,provider,ctx.mode==='tui'&&!isManualRefresh()?getConfig().usage.pollIntervalMs:0);}

	const unsubscribeAccountChanged = pi.events.on("pi:account-changed", (payload: unknown) => {
		if (!payload || typeof payload !== "object" || !("providerId" in payload) ||
			typeof payload.providerId !== "string") return;
		const provider = detectProvider({ provider: payload.providerId });
		if (!provider) return;
		accountRevisions.set(provider,(accountRevisions.get(provider)??0)+1);
		owners.get(provider)?.owner.close();owners.delete(provider);
		state[provider] = null;
		delete state.available[provider];
		if (provider === state.activeProvider) {
			onStatusChange();
			if (!isManualRefresh()) void poll();
		}
	});

	return {
		async start(ctx) {
			sessionEpoch += 1;closeOwners();
			for(const provider of PROVIDERS)state[provider]=null;state.available={};
			currentContext = ctx;
			sessionController?.abort();
			sessionController = new AbortController();
			updateProviderFrom(ctx.model);


			if (pi.getFlag("usage") === true) {
				const provider = state.activeProvider;
				if (!provider) {
					console.log(JSON.stringify({ extension: EXTENSION_ID, status: "unsupported", provider: ctx.model?.provider }));
				} else {
					await fetchProvider(ctx, provider, sessionController.signal);
					const data = state[provider];
					console.log(JSON.stringify({
						extension: EXTENSION_ID,
						provider,
						status: !data ? "unconfigured" : data.error ? "error" : "ok",
						...(data ?? {}),
					}));
				}
				ctx.shutdown();
				return;
			}

			if (ctx.mode !== "tui") return;

			onStatusChange();
			if (isManualRefresh()) return;
			void poll();
			schedulePollTimer();
		},

		stop(ctx) {
			sessionEpoch += 1;closeOwners();
			sessionController?.abort();
			sessionController = undefined;
			// Clear the active provider so getStatus() returns undefined after a
			// shutdown (matches the upstream setStatus(STATUS_KEY, undefined)).
			state.activeProvider = null;
			if (ctx.mode === "tui") onStatusChange();
			currentContext = undefined;
		},

		onModelSelect(ctx, model) {
			currentContext = ctx;
			const changed = updateProviderFrom(model);
			if (changed) onStatusChange();
			if (!isManualRefresh()) void poll();
		},

		async openCommand(ctx) {
			currentContext = ctx;
			updateProviderFrom(ctx.model);
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/usage is available in interactive mode", "warning");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
				new UsageSelectorComponent(
					tui,
					theme,
					keybindings,
					state.activeProvider,
					(signal) => fetchAllForContext(ctx, signal),
					() => done(),
					togglePolling,
					!isManualRefresh(),
				));
			if (!isManualRefresh()) void poll();
		},

		getStatus(theme, barWidth) {
			return buildStatus(theme, barWidth);
		},

		refresh() {
			if (!isManualRefresh()) void poll();
		},

		rescheduleTimer() {
			if (currentContext && currentContext.mode === "tui") schedulePollTimer();
		},

		togglePolling() {
			return togglePolling();
		},

		dispose() {
			unsubscribeAccountChanged();
			sessionEpoch += 1;closeOwners();
			sessionController?.abort();
			sessionController = undefined;
			currentContext = undefined;
		},
	};
}
