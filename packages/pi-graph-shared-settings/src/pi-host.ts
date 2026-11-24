/** Classify only the supplied host version; prereleases and unsupported hosts are unknown. */
export function getPiHostMode(version: unknown): "native" | "legacy" | "unknown" {
  if (typeof version !== "string") return "unknown";
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return "unknown";

  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return "unknown";
  if (major > 0 || minor >= 99) return "native";
  if (minor >= 87) return "legacy";
  return "unknown";
}

/** Missing native APIs never authorize legacy fallback on a native or unknown host. */
export function getPiFeatureOwner(
  version: unknown,
  apiAvailable: boolean,
): "native" | "legacy" | "unavailable" {
  const mode = getPiHostMode(version);
  if (mode === "legacy") return "legacy";
  return mode === "native" && apiAvailable ? "native" : "unavailable";
}
