/** Authentication orchestration contracts. Credentials stay with the original Host. */
export type AuthFailureKind = "http" | "authorization" | "cancelled" | "timeout" | "configuration" | "protocol" | "transport" | "unknown";
export type AuthStage = "configuration" | "registration" | "callback" | "token-exchange" | "refresh" | "revoke" | "cleanup";
export interface AuthErrorView { readonly provider: string; readonly stage: AuthStage; readonly kind: AuthFailureKind; readonly httpStatus?: number; }
const originalFailures = new WeakMap<Error, { error: unknown; name: string; status?: number; cancelled: boolean }>();
const stages = new Set<AuthStage>(["configuration", "registration", "callback", "token-exchange", "refresh", "revoke", "cleanup"]);
const kinds = new Set<AuthFailureKind>(["http", "authorization", "cancelled", "timeout", "configuration", "protocol", "transport", "unknown"]);
const label = (value: string): string => /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "provider";
export class AuthFailure extends Error {
  readonly view: Readonly<AuthErrorView>;
  constructor(view: AuthErrorView, original?: unknown) {
    const httpStatus = Number.isInteger(view.httpStatus) && view.httpStatus! >= 100 && view.httpStatus! <= 599 ? view.httpStatus : undefined;
    const safe = Object.freeze({ provider: label(view.provider), stage: stages.has(view.stage) ? view.stage : "configuration", kind: kinds.has(view.kind) ? view.kind : "unknown", ...(httpStatus === undefined ? {} : { httpStatus }) });
    super(`${safe.provider} authentication ${safe.stage}: ${safe.kind}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}`);
    this.name = safe.kind === "cancelled" ? "AbortError" : "AuthFailure";
    this.view = safe;
    const value = original instanceof Error ? original : undefined;
    originalFailures.set(this, { error: original, name: value?.name ?? "Error", status: httpStatus, cancelled: safe.kind === "cancelled" });
  }
}
export function authError(error: unknown, provider: string, stage: AuthStage, fallback: AuthFailureKind = "unknown"): AuthFailure {
  if (error instanceof AuthFailure) return error;
  const record = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown } : undefined;
  const status = typeof record?.status === "number" ? record.status : typeof record?.statusCode === "number" ? record.statusCode : undefined;
  const cancelled = record?.name === "AbortError" || (record?.name === "FabricContractError" && (record.code === "cancelled" || record.code === "stale_generation"));
  return new AuthFailure({ provider, stage, kind: cancelled ? "cancelled" : fallback, ...(status === undefined ? {} : { httpStatus: status }) }, error);
}
export function authErrorView(error: unknown, provider: string, stage: AuthStage): Readonly<AuthErrorView> {
  return authError(error, provider, stage).view;
}
export function assertAuthCurrent(provider: string, signal?: AbortSignal, assertCurrent?: () => void): void {
  if (signal?.aborted) throw new AuthFailure({ provider, stage: "callback", kind: "cancelled" }, signal.reason);
  try { assertCurrent?.(); } catch (error) { throw authError(error, provider, "callback", "cancelled"); }
}
/** Observe cancellation without changing the original operation or starting a retry. */
export function waitAuth<T>(value: Promise<T>, provider: string, signal?: AbortSignal): Promise<T> {
  if (!signal) return value;
  if (signal.aborted) {
    // The caller has already created this operation. Observe its terminal result
    // even when cancellation prevents returning it; never restart the operation.
    void value.then(() => undefined, () => undefined);
    return Promise.reject(new AuthFailure({ provider, stage: "callback", kind: "cancelled" }, signal.reason));
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new AuthFailure({ provider, stage: "callback", kind: "cancelled" }, signal.reason)); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    value.then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
  });
}
export interface AuthLease { readonly identity: string; readonly generation: number; readonly signal: AbortSignal; isCurrent(): boolean; assertCurrent(): void; }
export interface AuthAuthority { capture(): AuthLease; renew(reason?: string): AuthLease; revoke(reason?: string): void; }
