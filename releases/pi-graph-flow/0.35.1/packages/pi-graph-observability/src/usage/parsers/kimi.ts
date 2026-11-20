import type {UsageData,AccountBalance} from "../contracts.ts";
import {asObject,readNumber,readPercentCandidate,usedPercentFromCounts,normalizeIsoDate,isoFromEpoch,resetFromRemains,hydrateUsageResets,normalizeUsagePair,formatDuration} from "./financial.ts";
/** Authentication and official https://api.kimi.com/coding/v1/usages transport remain Host owned (kimi-coding/k3). */
export function extractKimiUsageFromPayload(payload: unknown, nowMs: number): UsageData | null {
  const root = asObject(payload);
  if (!root) return null;
  const webUsages = Array.isArray(root.usages) ? root.usages : undefined;
  const codingUsage = webUsages?.map(asObject).find((entry) =>
    String(entry?.scope ?? "").toUpperCase() === "FEATURE_CODING") ?? root;
  const dataRows = Array.isArray(codingUsage.data) ? codingUsage.data.map(asObject).filter(Boolean) : [];
  const usage = asObject(codingUsage.usage) ?? asObject(codingUsage.detail) ??
    dataRows.find((entry) => String(entry?.model_name ?? entry?.modelName ?? "").toLowerCase() === "all");
  const limits = Array.isArray(codingUsage.limits)
    ? codingUsage.limits
    : dataRows.filter((entry) => entry !== usage);
  const sessionLimit = limits.map(asObject).find((entry) => {
    const window = asObject(entry?.window);
    const duration = readNumber(window?.duration);
    const unit = String(window?.timeUnit ?? window?.time_unit ?? "").toUpperCase();
    return duration === 300 && unit.includes("MINUTE");
  }) ?? limits.map(asObject).find((entry) => entry !== null);
  const sessionDetail = asObject(sessionLimit?.detail) ?? sessionLimit;

  const session = usedPercentFromCounts(sessionDetail);
  const weekly = usedPercentFromCounts(usage);
  if (session === null || weekly === null) return null;

  const sessionReset = normalizeIsoDate(sessionDetail?.resetTime ?? sessionDetail?.reset_at ?? sessionDetail?.reset_time);
  const weeklyReset = normalizeIsoDate(usage?.resetTime ?? usage?.reset_at ?? usage?.reset_time);
  return hydrateUsageResets({
    ...normalizeUsagePair(session, weekly),
    sessionLabel: "5-hour",
    weeklyLabel: "Weekly",
    sessionResetsAt: sessionReset,
    weeklyResetsAt: weeklyReset,
  }, nowMs);
}

