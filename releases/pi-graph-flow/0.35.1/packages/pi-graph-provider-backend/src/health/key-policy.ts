/** Metadata only. Credential strings and models.json mutation stay with the Host. */
export type KeyHealthPolicy = "sticky" | "round-robin" | "weighted" | "failover";
export interface KeyHealthEntry { index: number; id: string; enabled?: boolean; weight?: number; failureCount?: number; lastFailureAt?: number; lastFailureStatus?: number; lastUsedAt?: number; }
export interface KeyHealthState { index: number; id: string; enabled: boolean; weight: number; failureCount: number; lastFailureAt?: number; lastFailureStatus?: number; lastUsedAt?: number; }
export interface KeyHealthSelection { id: string; index?: number; }
export interface KeyHealthPorts { now?: () => number; random?: () => number; }

export const DEFAULT_KEY_WEIGHT = 1;
const KEY_FAILURE_COOLDOWN_MS = 60_000;

export function sanitizeKeyHealthEntry(entry: KeyHealthEntry): KeyHealthState {
  return {
    id: entry.id,
    index: entry.index,
    enabled: entry.enabled !== false,
    weight: typeof entry.weight === "number" && Number.isFinite(entry.weight) && entry.weight >= 0
      ? entry.weight
      : DEFAULT_KEY_WEIGHT,
    failureCount: typeof entry.failureCount === "number" && entry.failureCount >= 0
      ? entry.failureCount
      : 0,
    lastFailureAt: typeof entry.lastFailureAt === "number" ? entry.lastFailureAt : undefined,
    lastFailureStatus: typeof entry.lastFailureStatus === "number" ? entry.lastFailureStatus : undefined,
    lastUsedAt: typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : undefined,
  };
}

export function resolveKeyHealth(
  keys: KeyHealthState[], activeId: string | undefined, legacyAvailable: boolean,
  policy: KeyHealthPolicy = "sticky", ports: KeyHealthPorts = {},
): KeyHealthSelection | undefined {
  if (keys.length === 0) {
    if (legacyAvailable) {
      return { id: "legacy" };
    }
    return undefined;
  }
  const enabled = keys.filter((key) => key.enabled);
  if (enabled.length === 0) return undefined;
  switch (policy) {
    case "sticky":
      return pickSticky(enabled, activeId) ?? pickKey(enabled[0]);
    case "round-robin":
      return pickRoundRobin(enabled, activeId);
    case "weighted":
      return pickWeighted(enabled, ports);
    case "failover":
      return pickFailover(enabled, activeId, ports);
    default:
      return pickKey(enabled[0]);
  }
}

function pickKey(key: KeyHealthState): KeyHealthSelection {
  return { id: key.id, index: key.index };
}

function pickSticky(keys: KeyHealthState[], activeId?: string): KeyHealthSelection | undefined {
  if (activeId) {
    const found = keys.find((key) => key.id === activeId);
    if (found) return pickKey(found);
  }
  return undefined;
}

function pickRoundRobin(keys: KeyHealthState[], activeId?: string): KeyHealthSelection {
  if (!activeId) return pickKey(keys[0]);
  const index = keys.findIndex((key) => key.id === activeId);
  const next = keys[(index + 1) % keys.length];
  return pickKey(next);
}

function pickWeighted(keys: KeyHealthState[], ports: KeyHealthPorts = {}): KeyHealthSelection {
  const total = keys.reduce((sum, key) => sum + key.weight, 0);
  if (total <= 0) return pickKey(keys[0]);
  let point = (ports.random ?? Math.random)() * total;
  for (const key of keys) {
    point -= key.weight;
    if (point <= 0) return pickKey(key);
  }
  return pickKey(keys[keys.length - 1]);
}

function pickFailover(keys: KeyHealthState[], activeId: string | undefined, ports: KeyHealthPorts): KeyHealthSelection {
  if (activeId) {
    const active = keys.find((key) => key.id === activeId);
    if (active && active.enabled && !isKeyCooling(active, ports)) {
      return pickKey(active);
    }
  }
  const healthy = keys.filter((key) => !isKeyCooling(key, ports));
  if (healthy.length === 0) {
    const sorted = [...keys].sort((a, b) => {
      if (a.failureCount !== b.failureCount) return a.failureCount - b.failureCount;
      return (a.lastFailureAt ?? 0) - (b.lastFailureAt ?? 0);
    });
    return pickKey(sorted[0]);
  }
  const sorted = healthy.sort((a, b) => {
    if (a.failureCount !== b.failureCount) return a.failureCount - b.failureCount;
    return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
  });
  return pickKey(sorted[0]);
}

export function isKeyCooling(key: KeyHealthState, ports: KeyHealthPorts = {}): boolean {
  if (key.failureCount === 0) return false;
  const last = key.lastFailureAt;
  if (!last) return false;
  return (ports.now ?? Date.now)() - last < KEY_FAILURE_COOLDOWN_MS * Math.min(key.failureCount, 5);
}

export function markKeyHealthFailed(entries: readonly KeyHealthEntry[], keyId: string, status?: number, now: () => number = Date.now): KeyHealthEntry[] | undefined {
  let changed = false;
  const next = entries.map(entry => {
    if (entry.id !== keyId) return entry;
    changed = true;
    return { ...entry, failureCount: (entry.failureCount ?? 0) + 1,
      lastFailureAt: now(), lastFailureStatus: status ?? entry.lastFailureStatus };
  });
  return changed ? next : undefined;
}

export function advanceKeyHealth(
  keys: KeyHealthState[], currentId: string | undefined,
  policy: KeyHealthPolicy = "sticky", excludeKeyId?: string, ports: KeyHealthPorts = {},
): string | undefined {
  if (keys.length === 0) return undefined;
  const enabled = keys.filter((key) => key.enabled);
  if (enabled.length === 0) return undefined;
  if (policy === "round-robin") {
    const index = enabled.findIndex((key) => key.id === currentId);
    const nextIndex = index >= 0 ? (index + 1) % enabled.length : 0;
    return enabled[nextIndex].id;
  }
  if (policy === "weighted") {
    const candidates = enabled.filter((key) => key.id !== excludeKeyId);
    const pick = pickWeighted(candidates.length > 0 ? candidates : enabled, ports);
    return pick.id;
  }
  let candidates = enabled.filter((key) => key.id !== excludeKeyId && !isKeyCooling(key, ports));
  if (candidates.length === 0) candidates = enabled.filter((key) => key.id !== excludeKeyId);
  if (candidates.length === 0) candidates = enabled;
  const sorted = candidates.sort((a, b) => {
    if (a.failureCount !== b.failureCount) return a.failureCount - b.failureCount;
    return (a.lastFailureAt ?? Infinity) - (b.lastFailureAt ?? Infinity);
  });
  return sorted[0].id;
}

