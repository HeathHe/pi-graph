import type {UsageData,AccountBalance} from "../contracts.ts";
import {asObject,readNumber,readPercentCandidate,usedPercentFromCounts,normalizeIsoDate,isoFromEpoch,resetFromRemains,hydrateUsageResets,normalizeUsagePair,formatDuration} from "./financial.ts";
interface MiniMaxWindow {
  percent: number;
  resetsAt?: string;
}

function pickHighestWindow(windows: MiniMaxWindow[]): MiniMaxWindow | undefined {
  return windows.reduce<MiniMaxWindow | undefined>((highest, window) =>
    !highest || window.percent > highest.percent ? window : highest, undefined);
}

function miniMaxResetAt(value: Record<string, unknown>, prefix: "current" | "weekly", nowMs: number): string | undefined {
  const end = prefix === "current"
    ? value.end_time ?? value.endTime
    : value.weekly_end_time ?? value.weeklyEndTime;
  const remains = prefix === "current"
    ? value.remains_time ?? value.remainsTime
    : value.weekly_remains_time ?? value.weeklyRemainsTime;
  const resetsAt = prefix === "current"
    ? value.current_resets_at ?? value.currentResetsAt
    : value.weekly_resets_at ?? value.weeklyResetsAt;
  return normalizeIsoDate(resetsAt) ?? isoFromEpoch(end) ?? resetFromRemains(remains, nowMs);
}

function extractMiniMaxCreditBalance(payload: unknown): AccountBalance | undefined {
  const root = asObject(payload);
  const data = asObject(root?.data) ?? root;
  if (!data) return undefined;
  const amount = readNumber(
    data.points_balance ?? data.pointsBalance ??
    data.point_balance ?? data.pointBalance ??
    data.credits_balance ?? data.creditsBalance ??
    data.credit_balance ?? data.creditBalance,
  );
  return amount === null ? undefined : { amount, unit: "credits", label: "Credit balance" };
}

export function extractMiniMaxUsageFromPayload(payload: unknown, nowMs: number): UsageData | null {
  const root = asObject(payload);
  const data = asObject(root?.data) ?? root;
  if (!data) return null;
  const accountBalance = extractMiniMaxCreditBalance(payload);

  const intervalWindows: MiniMaxWindow[] = [];
  const weeklyWindows: MiniMaxWindow[] = [];
  if (Array.isArray(data.services)) {
    for (const rawService of data.services) {
      const service = asObject(rawService);
      if (!service) continue;
      const directPercent = readPercentCandidate(readNumber(service.percent));
      const percent = directPercent ?? usedPercentFromCounts(service, { total: "limit", used: "usage" });
      if (percent === null) continue;
      const windowType = String(service.window_type ?? service.windowType ?? "").toLowerCase();
      const resetsAt = normalizeIsoDate(service.resets_at ?? service.reset_time ?? service.end_time);
      (windowType.includes("week") ? weeklyWindows : intervalWindows).push({ percent, resetsAt });
    }
  }

  if (Array.isArray(data.model_remains ?? data.modelRemains)) {
    for (const rawModel of (data.model_remains ?? data.modelRemains) as unknown[]) {
      const raw = asObject(rawModel);
      if (!raw) continue;
      const model: Record<string, unknown> = {
        ...raw,
        current_interval_remaining_percent:
          raw.current_interval_remaining_percent ?? raw.currentIntervalRemainingPercent,
        current_interval_total_count: raw.current_interval_total_count ?? raw.currentIntervalTotalCount,
        current_interval_usage_count: raw.current_interval_usage_count ?? raw.currentIntervalUsageCount,
        current_interval_status: raw.current_interval_status ?? raw.currentIntervalStatus,
        current_weekly_remaining_percent:
          raw.current_weekly_remaining_percent ?? raw.currentWeeklyRemainingPercent,
        current_weekly_total_count: raw.current_weekly_total_count ?? raw.currentWeeklyTotalCount,
        current_weekly_usage_count: raw.current_weekly_usage_count ?? raw.currentWeeklyUsageCount,
        current_weekly_status: raw.current_weekly_status ?? raw.currentWeeklyStatus,
      };
      const unavailable = (prefix: "interval" | "weekly") =>
        readNumber(model[`current_${prefix}_status`]) === 3 &&
        (readNumber(model[`current_${prefix}_remaining_percent`]) ?? 0) >= 100 &&
        (readNumber(model[`current_${prefix}_total_count`]) ?? 0) === 0 &&
        (readNumber(model[`current_${prefix}_usage_count`]) ?? 0) === 0;
      const interval = unavailable("interval") ? null : usedPercentFromCounts(model, {
        remainingPercent: "current_interval_remaining_percent",
        total: "current_interval_total_count",
        remaining: "current_interval_usage_count",
      });
      if (interval !== null) {
        intervalWindows.push({ percent: interval, resetsAt: miniMaxResetAt(model, "current", nowMs) });
      }
      const weekly = unavailable("weekly") ? null : usedPercentFromCounts(model, {
        remainingPercent: "current_weekly_remaining_percent",
        total: "current_weekly_total_count",
        remaining: "current_weekly_usage_count",
      });
      if (weekly !== null) {
        weeklyWindows.push({ percent: weekly, resetsAt: miniMaxResetAt(model, "weekly", nowMs) });
      }
    }
  }

  const session = pickHighestWindow(intervalWindows);
  const weekly = pickHighestWindow(weeklyWindows);
  if (!session) {
    return accountBalance
      ? { session: undefined, weekly: undefined, quotaHidden: true, accountBalance }
      : null;
  }
  return hydrateUsageResets({
    session: Number(session.percent.toFixed(2)),
    accountBalance,
    weekly: weekly ? Number(weekly.percent.toFixed(2)) : undefined,
    sessionLabel: "Interval",
    weeklyLabel: "Weekly",
    weeklyHidden: !weekly,
    sessionResetsAt: session.resetsAt,
    weeklyResetsAt: weekly?.resetsAt,
  }, nowMs);
}

