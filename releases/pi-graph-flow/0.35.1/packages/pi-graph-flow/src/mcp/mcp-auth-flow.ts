/**
 * MCP Auth Flow
 *
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */

import {
  auth as runSdkAuth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import open from "open"
import { McpOAuthProvider } from "./mcp-oauth-provider.ts"
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  releaseCallbackServer,
} from "./mcp-callback-server.ts"
import {
  getAuthForUrl,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  updateOAuthState,
  getOAuthState,
  clearOAuthState,
  type StoredTokens,
} from "./mcp-auth.ts"
import { McpContinuationAuthority } from "./fabric-route-guard.ts"

import { createMcpAuthOwner, extractOAuthConfig, parseAuthorizationCodeInput, supportsOAuth } from "pi-graph-provider-backend/auth";
export { extractOAuthConfig, parseAuthorizationCodeInput, supportsOAuth };
export type { AuthStatus, AuthenticateOptions } from "pi-graph-provider-backend/auth";
const owner = createMcpAuthOwner<McpOAuthProvider, StoredTokens>({
  authority: identity => new McpContinuationAuthority(identity),
  generateState: () => Array.from(crypto.getRandomValues(new Uint8Array(32))).map(byte => byte.toString(16).padStart(2, "0")).join(""),
  createProvider: (name, url, config, callbacks) => new McpOAuthProvider(name, url, config, callbacks),
  createTransport: (url, options) => new StreamableHTTPClientTransport(url, options),
  runSdkAuth, unauthorized: message => new UnauthorizedError(message),
  ensureCallbackServer, waitForCallback, cancelPendingCallback, stopCallbackServer, releaseCallbackServer,
  getAuthForUrl, isTokenExpired, hasStoredTokens, clearAllCredentials, clearClientInfo, clearTokens, clearCodeVerifier,
  updateOAuthState, getOAuthState, clearOAuthState,
  open, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  log: { info: message => console.log(message), debug: (message, detail) => console.debug(message, detail), warn: (message, detail) => console.warn(message, detail), error: (message, detail) => console.error(message, detail) },
});
export const { captureOAuthContinuation, beginOAuthContinuation, startAuth, completeAuthFromInput, completeAuth,
  authenticate, getValidToken, getAuthStatus, removeAuth, initializeOAuth, shutdownOAuth } = owner;
