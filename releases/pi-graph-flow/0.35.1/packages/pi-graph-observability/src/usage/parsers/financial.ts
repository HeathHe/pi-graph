import type {UsageData,AccountBalance} from '../contracts.ts';
export function asObject(v:unknown):Record<string,unknown>|null{return v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;}
export function readNumber(value:unknown):number|null {if(typeof value==='number'&&Number.isFinite(value))return value;if(typeof value==='string'&&value.trim()&&Number.isFinite(Number(value)))return Number(value);return null;}
export function readPercentCandidate(value:unknown):number|null {const n=typeof value==='number'&&Number.isFinite(value)?value:null;return n===null||n<0||n>100?null:n>0&&n<1?n*100:n;}
export function normalizeUsagePair(session:number,weekly:number):{session:number;weekly:number}{return {session:Number(Math.max(0,Math.min(100,session)).toFixed(2)),weekly:Number(Math.max(0,Math.min(100,weekly)).toFixed(2))};}
export function formatDuration(seconds:number):string {const minutes=Math.max(0,Math.ceil(seconds/60));return minutes>=1440?`${Math.floor(minutes/1440)}d ${Math.floor(minutes%1440/60)}h`:minutes>=60?`${Math.floor(minutes/60)}h ${minutes%60}m`:`${minutes}m`;}
export function hydrateUsageResets(data:UsageData,nowMs:number):UsageData{return {...data,sessionResetsIn:data.sessionResetsAt?formatDuration((Date.parse(data.sessionResetsAt)-nowMs)/1000):data.sessionResetsIn,weeklyResetsIn:data.weeklyResetsAt?formatDuration((Date.parse(data.weeklyResetsAt)-nowMs)/1000):data.weeklyResetsIn};}
export function usedPercentFromCounts(
  value: Record<string, unknown> | null | undefined,
  options: { remainingPercent?: string; used?: string; total?: string; remaining?: string } = {},
): number | null {
  if (!value) return null;
  const remainingPercent = readNumber(value[options.remainingPercent ?? "remaining_percent"]);
  if (remainingPercent !== null) return Math.max(0, Math.min(100, 100 - remainingPercent));

  const total = readNumber(value[options.total ?? "limit"]);
  const used = readNumber(value[options.used ?? "used"]);
  const remaining = readNumber(value[options.remaining ?? "remaining"]);
  if (total === null || total <= 0) return null;
  if (used !== null) return Math.max(0, Math.min(100, used / total * 100));
  if (remaining !== null) return Math.max(0, Math.min(100, (total - remaining) / total * 100));
  return null;
}

export function normalizeIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(/(\.\d{3})\d+(?=Z|[+-]\d\d:\d\d$)/, "$1");
  return Number.isFinite(new Date(normalized).getTime()) ? normalized : undefined;
}

export function isoFromEpoch(value: unknown): string | undefined {
  const raw = readNumber(value);
  if (raw === null || raw <= 0) return undefined;
  const milliseconds = raw > 1_000_000_000_000 ? raw : raw * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function resetFromRemains(value: unknown, nowMs: number): string | undefined {
  const raw = readNumber(value);
  if (raw === null || raw <= 0) return undefined;
  const milliseconds = raw > 1_000_000 ? raw : raw * 1000;
  return new Date(nowMs + milliseconds).toISOString();
}

export function extractOpenRouterUsageFromPayloads(
  creditsPayload: unknown,
  keyPayload: unknown,
): UsageData | null {
  const credits = asObject(asObject(creditsPayload)?.data) ?? asObject(creditsPayload);
  const key = asObject(asObject(keyPayload)?.data) ?? asObject(keyPayload);

  const totalCredits = readNumber(credits?.total_credits ?? credits?.totalCredits);
  const totalUsage = readNumber(credits?.total_usage ?? credits?.totalUsage);
  const accountBalance = totalCredits !== null && totalUsage !== null
    ? {
        amount: Number((totalCredits - totalUsage).toFixed(6)),
        unit: "USD",
        label: "Balance",
      }
    : undefined;

  const spendValues = {
    daily: readNumber(key?.usage_daily ?? key?.usageDaily),
    weekly: readNumber(key?.usage_weekly ?? key?.usageWeekly),
    monthly: readNumber(key?.usage_monthly ?? key?.usageMonthly),
    lifetime: readNumber(key?.usage),
  };
  const accountSpend = Object.values(spendValues).some((value) => value !== null)
    ? {
        unit: "USD",
        daily: spendValues.daily ?? undefined,
        weekly: spendValues.weekly ?? undefined,
        monthly: spendValues.monthly ?? undefined,
        lifetime: spendValues.lifetime ?? undefined,
      }
    : undefined;

  const limit = readNumber(key?.limit);
  const remaining = readNumber(key?.limit_remaining ?? key?.limitRemaining);
  const limitUsed = limit !== null && limit > 0 && remaining !== null
    ? Math.max(0, Math.min(limit, limit - remaining))
    : null;
  const limitPercent = limitUsed !== null && limit !== null ? limitUsed / limit * 100 : null;
  if (!accountBalance && !accountSpend && limitPercent === null) return null;

  return {
    session: limitPercent === null ? undefined : Number(limitPercent.toFixed(2)),
    weekly: undefined,
    quotaHidden: limitPercent === null,
    weeklyHidden: true,
    sessionLabel: "Key limit",
    accountBalance,
    accountSpend,
  };
}

export function extractDeepSeekBalanceFromPayload(payload: unknown): UsageData | null {
  const root = asObject(payload);
  const rawBalances = Array.isArray(root?.balance_infos) ? root.balance_infos : [];
  const balances = rawBalances.map(asObject).filter((value): value is Record<string, unknown> => value !== null);
  if (balances.length === 0) return null;

  const parsed = balances.flatMap((balance) => {
    const unit = typeof balance.currency === "string" ? balance.currency.toUpperCase() : "USD";
    const total = readNumber(balance.total_balance ?? balance.totalBalance);
    if (total === null) return [];
    return [{
      total: { amount: total, unit, label: "Total balance" } satisfies AccountBalance,
      toppedUp: readNumber(balance.topped_up_balance ?? balance.toppedUpBalance),
      granted: readNumber(balance.granted_balance ?? balance.grantedBalance),
    }];
  });
  const primary = parsed[0];
  if (!primary) return null;

  const details: AccountBalance[] = [];
  if (primary.toppedUp !== null) {
    details.push({ amount: primary.toppedUp, unit: primary.total.unit, label: "Topped up" });
  }
  if (primary.granted !== null) {
    details.push({ amount: primary.granted, unit: primary.total.unit, label: "Granted" });
  }
  for (const additional of parsed.slice(1)) details.push(additional.total);

  return {
    session: undefined,
    weekly: undefined,
    quotaHidden: true,
    accountBalance: primary.total,
    accountBalanceDetails: details,
    warning: root?.is_available === false ? "Balance is not currently available for API use" : undefined,
  };
}

export function extractMoonshotBalanceFromPayload(
  payload: unknown,
  provider: "moonshot" | "moonshot-cn" = "moonshot",
): UsageData | null {
  const root = asObject(payload);
  const data = asObject(root?.data) ?? root;
  if (!data) return null;
  const available = readNumber(data.available_balance ?? data.availableBalance);
  if (available === null) return null;
  const cash = readNumber(data.cash_balance ?? data.cashBalance);
  const voucher = readNumber(data.voucher_balance ?? data.voucherBalance);
  const unit = provider === "moonshot-cn" ? "CNY" : "USD";
  const details: AccountBalance[] = [];
  if (cash !== null) details.push({ amount: cash, unit, label: "Cash" });
  if (voucher !== null) details.push({ amount: voucher, unit, label: "Voucher" });

  return {
    session: undefined,
    weekly: undefined,
    quotaHidden: true,
    accountBalance: { amount: available, unit, label: "Available balance" },
    accountBalanceDetails: details,
    warning: available <= 0 ? "Balance exhausted; inference requests may be rejected" : undefined,
  };
}

