import { AuthFailure, authError, assertAuthCurrent, waitAuth } from "./contracts.ts";
export const DEVIN_AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
export const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token";
export const DEVIN_CALLBACK_HOST = "127.0.0.1";
export const DEVIN_CALLBACK_PORT = 59_653;
export const DEVIN_CALLBACK_PATH = "/callback";
/** Callback overrides, mirroring pi's own `PI_OAUTH_CALLBACK_HOST`. */
export const DEVIN_CALLBACK_HOST_ENV = "PI_DEVIN_OAUTH_CALLBACK_HOST";
export const DEVIN_CALLBACK_PORT_ENV = "PI_DEVIN_OAUTH_CALLBACK_PORT";
/** Skew subtracted from the token's JWT `exp`, as the CLI projects it. */
export const DEVIN_EXPIRY_SKEW_MS = 300_000;
/** Lifetime applied when the session token is not a decodable JWT (one year). */
export const DEVIN_TOKEN_FALLBACK_TTL_MS = 31_536_000_000;
export const DEVIN_LOGIN_INSTRUCTIONS =
  "Sign in to Devin in your browser. If the browser runs on another machine, paste the final redirect URL or code here.";


function base64url(value: Uint8Array): string {
  return btoa(Array.from(value, byte => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export interface DevinPkce { verifier: string; challenge: string; }
export interface DevinCryptoPort { randomBytes(size: number): Uint8Array; sha256(value: string): Uint8Array; }
export function deriveDevinPkce(crypto: DevinCryptoPort): DevinPkce {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.sha256(verifier));
  return { verifier, challenge };
}
export interface DevinAuthorizationInput {
  code?: string;
  state?: string;
  /** Failure Devin reported, when the pasted redirect carried no code. */
  error?: string;
}

/**
 * Accept the forms a Devin sign-in can hand back: the final redirect URL, a
 * `code#state` pair, a query fragment, or the bare authorization code.
 */
export function parseDevinAuthorizationInput(input: string): DevinAuthorizationInput {
  const value = input.trim();
  if (!value) return {};
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      return {
        ...(code ? { code } : {}),
        ...(state ? { state } : {}),
        ...(!code && failure ? { error: failure } : {}),
      };
    } catch {
      // Not a usable URL; fall through to the code forms below.
    }
  }
  const fragment = value.indexOf("#");
  if (fragment >= 0) {
    const code = value.slice(0, fragment).trim();
    const state = value.slice(fragment + 1).trim();
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    const code = params.get("code");
    const state = params.get("state");
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  return { code: value };
}

/** Credential expiry for a Devin session token: JWT `exp` minus skew, else one year out. */
export function devinTokenExpiry(token: string, now = Date.now()): number {
  const expSeconds = decodeJwtExpirySeconds(token);
  return expSeconds === undefined
    ? now + DEVIN_TOKEN_FALLBACK_TTL_MS
    : expSeconds * 1000 - DEVIN_EXPIRY_SKEW_MS;
}

function decodeJwtExpirySeconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0))));
    if (!parsed || typeof parsed !== "object") return undefined;
    const exp = (parsed as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

export type DevinCallbackOutcome =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }
  | { kind: "timeout" };

export interface DevinCallbackServer {
  /** Loopback redirect URI advertised to Devin for this login attempt. */
  redirectUri: string;
  /**
   * First outcome of this attempt. Never rejects, so abandoning the wait
   * (manual paste or abort) cannot leak an unhandled rejection.
   */
  wait(): Promise<DevinCallbackOutcome>;
  cancelWait(): void;
  close(): Promise<void>;
}

export interface StartDevinCallbackServerOptions {
  host?: string;
  port?: number;
  /** Bind an OS-assigned port when the preferred one is taken. */
  allowPortFallback?: boolean;
}


export interface DevinLoginCallbacks {
  onAuth(info: { url: string; instructions?: string }): void;
  onManualCodeInput?(): Promise<string>;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}
export interface DevinCredential { access: string; refresh: string; expires: number; }
export interface DevinLoginHost {
  pkce(): DevinPkce;
  state(): string;
  now(): number;
  startCallback(state: string): Promise<DevinCallbackServer>;
  exchange(code: string, verifier: string, signal?: AbortSignal): Promise<string>;
  assertCurrent?(): void;
}
export async function runDevinLogin(callbacks: DevinLoginCallbacks, host: DevinLoginHost): Promise<DevinCredential> {
  const current = () => assertAuthCurrent("devin", callbacks.signal, host.assertCurrent);
  current();
  const { verifier, challenge } = host.pkce(), state = host.state();
  let server: DevinCallbackServer;
  try { server = await host.startCallback(state); }
  catch (error) { throw authError(error, "devin", "callback", "transport"); }
  let manualInput: string | undefined, manualError: unknown, primary: unknown;
  const abort = () => server.cancelWait();
  callbacks.signal?.addEventListener("abort", abort, { once: true });
  if (callbacks.signal?.aborted) abort();
  try {
    current();
    const params = new URLSearchParams({ response_type: "code", redirect_uri: server.redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, prompt: "select_account" });
    callbacks.onAuth({ url: `${DEVIN_AUTHORIZE_URL}?${params.toString()}`, instructions: DEVIN_LOGIN_INSTRUCTIONS });
    const manual = callbacks.onManualCodeInput?.().then(input => { manualInput = input; server.cancelWait(); }, error => { manualError = error; server.cancelWait(); });
    const callback = await waitAuth(server.wait(), "devin", callbacks.signal); current();
    if (callback.kind === "error") throw new AuthFailure({ provider: "devin", stage: "callback", kind: "authorization" }, new Error(callback.message));
    if (callback.kind === "timeout") throw new AuthFailure({ provider: "devin", stage: "callback", kind: "timeout" });
    let code = callback.kind === "code" ? callback.code : undefined;
    let returnedState = callback.kind === "code" ? callback.state : undefined;
    const applyManualInput = () => {
      if (!manualInput) return;
      const parsed = parseDevinAuthorizationInput(manualInput);
      if (parsed.error) throw new AuthFailure({ provider: "devin", stage: "callback", kind: "authorization" }, new Error(parsed.error));
      code = parsed.code; returnedState = parsed.state;
    };
    if (!code) applyManualInput();
    if (!code && manual) { await waitAuth(manual, "devin", callbacks.signal); current(); if (manualError) throw manualError; applyManualInput(); }
    current();
    if (!code) throw new AuthFailure({ provider: "devin", stage: "callback", kind: "authorization" });
    if (returnedState && returnedState !== state) throw new AuthFailure({ provider: "devin", stage: "callback", kind: "authorization" });
    callbacks.onProgress?.("Exchanging the authorization code for a Devin session token…");
    const token = await waitAuth(host.exchange(code, verifier, callbacks.signal), "devin", callbacks.signal); current();
    return { access: token, refresh: token, expires: devinTokenExpiry(token, host.now()) };
  } catch (error) { primary = error; throw authError(error, "devin", "callback", "authorization"); }
  finally {
    callbacks.signal?.removeEventListener("abort", abort);
    try { await server.close(); } catch (error) { if (!primary) throw authError(error, "devin", "cleanup", "transport"); }
  }
}
export function devinApiKeyFromCredential(credential: { access: string }): string { return credential.access; }
export async function refreshDevinToken(): Promise<DevinCredential> {
  const error = new AuthFailure({ provider: "devin", stage: "refresh", kind: "authorization" });
  error.message = "Devin session tokens cannot be refreshed; run /login devin to sign in again.";
  throw error;
}
