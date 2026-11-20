/** Compatibility entry; protocol orchestration is owned by M08 and credentials by Pi. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { deriveDevinPkce, runDevinLogin, refreshDevinToken as refreshOwnedDevinToken, devinApiKeyFromCredential as ownedDevinApiKey, type DevinPkce } from "pi-graph-provider-backend/auth";
import { startDevinCallbackServer, exchangeDevinAuthorizationCode } from "./devin-auth-host.ts";
export { DEVIN_AUTHORIZE_URL, DEVIN_TOKEN_URL, DEVIN_CALLBACK_HOST, DEVIN_CALLBACK_PORT, DEVIN_CALLBACK_PATH, DEVIN_CALLBACK_HOST_ENV, DEVIN_CALLBACK_PORT_ENV, DEVIN_EXPIRY_SKEW_MS, DEVIN_TOKEN_FALLBACK_TTL_MS, DEVIN_LOGIN_INSTRUCTIONS, parseDevinAuthorizationInput, devinTokenExpiry } from "pi-graph-provider-backend/auth";
export type { DevinPkce, DevinAuthorizationInput, DevinCallbackOutcome, DevinCallbackServer, StartDevinCallbackServerOptions } from "pi-graph-provider-backend/auth";
export { startDevinCallbackServer, exchangeDevinAuthorizationCode };
export function generateDevinPkce(): DevinPkce { return deriveDevinPkce({ randomBytes, sha256: value => createHash("sha256").update(value, "utf8").digest() }); }
export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const credential = await runDevinLogin(callbacks, { pkce: generateDevinPkce, state: randomUUID, now: Date.now, startCallback: startDevinCallbackServer, exchange: exchangeDevinAuthorizationCode });
  return { access: credential.access, refresh: credential.refresh, expires: credential.expires };
}
export async function refreshDevinToken(): Promise<OAuthCredentials> {
  const credential = await refreshOwnedDevinToken();
  return { access: credential.access, refresh: credential.refresh, expires: credential.expires };
}
export function devinApiKeyFromCredential(credential: OAuthCredentials): string { return ownedDevinApiKey(credential); }
