/** Complete legacy MCP OAuth orchestration. Physical IO and credential storage remain Host-owned. */
import { AuthFailure, authError, authErrorView, type AuthAuthority, type AuthLease } from "./contracts.ts";
export interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials"; clientId?: string; clientSecret?: string;
  scope?: string; redirectUri?: string; clientName?: string; clientUri?: string;
}
export interface McpAuthDefinition { url?: string; auth?: string | false; oauth?: false | McpOAuthConfig; headers?: Record<string, string>; }
export interface McpAuthTokens { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string; }
export interface McpAuthEntry<T extends McpAuthTokens> { tokens?: T; clientInfo?: { redirectUris?: string[] }; }
export interface McpAuthProvider { readonly redirectUrl?: string; clientInformation(): unknown | Promise<unknown>; }
export interface McpAuthTransport { close(): Promise<void>; finishAuth(code: string): Promise<void>; }
export interface McpAuthTimer { unref?(): void; }
export interface McpAuthHost<P extends McpAuthProvider, T extends McpAuthTokens> {
  authority(identity: string): AuthAuthority;
  generateState(): string;
  createProvider(name: string, url: string, config: McpOAuthConfig, callbacks: { onRedirect(url: URL): void | Promise<void>; guard: AuthLease }): P;
  createTransport(url: URL, options: { authProvider: P }): McpAuthTransport;
  runSdkAuth(provider: P, options: { serverUrl: string }): Promise<string>;
  unauthorized(message: string): Error;
  ensureCallbackServer(options: { signal: AbortSignal; strictPort: boolean; oauthState: string; reserveState: boolean; port?: number; callbackHost?: string; callbackPath?: string }): Promise<unknown>;
  waitForCallback(state: string): Promise<string>; cancelPendingCallback(state: string): void;
  releaseCallbackServer(state: string): void; stopCallbackServer(): Promise<void>;
  getAuthForUrl(name: string, url: string): McpAuthEntry<T> | undefined | Promise<McpAuthEntry<T> | undefined>;
  isTokenExpired(name: string): boolean | null | Promise<boolean | null>; hasStoredTokens(name: string): boolean | Promise<boolean>;
  clearAllCredentials(name: string): void; clearClientInfo(name: string): void; clearTokens(name: string): void; clearCodeVerifier(name: string): void;
  updateOAuthState(name: string, state: string, url: string): void | Promise<void>; getOAuthState(name: string): string | undefined | Promise<string | undefined>; clearOAuthState(name: string): void | Promise<void>;
  open(url: string): Promise<unknown>;
  setTimeout(callback: () => void, delay: number): McpAuthTimer; clearTimeout(timer: McpAuthTimer): void;
  log: { info(message: string): void; debug(message: string, detail: unknown): void; warn(message: string, detail: unknown): void; error(message: string, detail: unknown): void; };
}
/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export interface AuthenticateOptions {
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>
}

export function extractOAuthConfig(definition: McpAuthDefinition): McpOAuthConfig {
  if (definition.oauth === false) {
    return {}
  }

  const config: McpOAuthConfig = {}
  if (definition.oauth?.grantType !== undefined) config.grantType = definition.oauth.grantType
  if (definition.oauth?.clientId !== undefined) config.clientId = definition.oauth.clientId
  if (definition.oauth?.clientSecret !== undefined) config.clientSecret = definition.oauth.clientSecret
  if (definition.oauth?.scope !== undefined) config.scope = definition.oauth.scope
  if (definition.oauth?.redirectUri !== undefined) {
    if (typeof definition.oauth.redirectUri !== "string") {
      throw new Error("OAuth redirectUri must be a string")
    }
    const redirectUri = definition.oauth.redirectUri.trim()
    if (!redirectUri) {
      throw new Error("OAuth redirectUri must not be empty")
    }
    config.redirectUri = redirectUri
  }
  if (definition.oauth?.clientName !== undefined) {
    if (typeof definition.oauth.clientName !== "string") {
      throw new Error("OAuth clientName must be a string")
    }
    const clientName = definition.oauth.clientName.trim()
    if (!clientName) {
      throw new Error("OAuth clientName must not be empty")
    }
    config.clientName = clientName
  }
  if (definition.oauth?.clientUri !== undefined) {
    if (typeof definition.oauth.clientUri !== "string") {
      throw new Error("OAuth clientUri must be a string")
    }
    const clientUri = definition.oauth.clientUri.trim()
    if (!clientUri) {
      throw new Error("OAuth clientUri must not be empty")
    }
    config.clientUri = clientUri
  }
  return config
}

function parseOAuthRedirectUri(redirectUri: string): { port: number; callbackHost: string; callbackPath: string } {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch (error) {
    throw new AuthFailure({ provider: "mcp", stage: "configuration", kind: "configuration" }, error)
  }

  const hostname = url.hostname.toLowerCase()
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error("OAuth redirectUri must be an http:// localhost or loopback URI")
  }

  if (url.username || url.password) {
    throw new Error("OAuth redirectUri must not include username or password")
  }

  if (url.hash) {
    throw new Error("OAuth redirectUri must not include a fragment")
  }

  if (!url.port) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const port = Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const callbackHost = hostname === "[::1]" ? "::1" : hostname
  return { port, callbackHost, callbackPath: url.pathname }
}


function getSearchParamsFromInput(input: string): URLSearchParams | undefined {
  try {
    const url = new URL(input)
    const params = new URLSearchParams(url.search)
    if (url.hash) {
      const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
      const hashParams = new URLSearchParams(hash)
      hashParams.forEach((value, key) => {
        if (!params.has(key)) params.set(key, value)
      })
    }
    return params
  } catch {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input
    const params = new URLSearchParams(query.startsWith("#") ? query.slice(1) : query)
    return params.has("code") || params.has("state") || params.has("error") ? params : undefined
  }
}

/**
 * Extract an OAuth authorization code from either a raw code, a query string,
 * or the full localhost redirect URL copied from the browser address bar.
 */
export function parseAuthorizationCodeInput(input: string, expectedState?: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Authorization code or redirect URL is required")
  }

  const params = getSearchParamsFromInput(trimmed)
  if (params) {
    const error = params.get("error")
    if (error) {
      const description = params.get("error_description")
      throw new AuthFailure({ provider: "mcp", stage: "callback", kind: "authorization" }, new Error(description ? `${error}: ${description}` : error))
    }

    const state = params.get("state")
    if (expectedState && !state) {
      throw new Error("OAuth state missing from redirect URL")
    }
    if (expectedState && state !== expectedState) {
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    const code = params.get("code")
    if (code) return code
  }

  if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) {
    return trimmed
  }

  throw new Error("Could not find an OAuth authorization code in the provided input")
}


export function supportsOAuth(definition: McpAuthDefinition): boolean {
  // OAuth requires a URL
  if (!definition.url) return false

  // Explicitly disabled via auth: false or oauth: false
  if (definition.auth === false) return false
  if (definition.oauth === false) return false
  if (definition.auth === "oauth") return true

  // Configured custom headers take precedence over implicit OAuth auto-detection.
  if (definition.headers && Object.keys(definition.headers).length > 0) return false

  // OAuth is enabled when auth is not specified (auto-detect)
  return definition.auth === undefined
}

export function createMcpAuthOwner<P extends McpAuthProvider, T extends McpAuthTokens>(host: McpAuthHost<P, T>) {
  const { authority: createAuthority, generateState, createProvider, createTransport, runSdkAuth, unauthorized,
    ensureCallbackServer, waitForCallback, cancelPendingCallback, stopCallbackServer, releaseCallbackServer,
    getAuthForUrl, isTokenExpired, hasStoredTokens, clearAllCredentials, clearClientInfo, clearTokens, clearCodeVerifier,
    updateOAuthState, getOAuthState, clearOAuthState, open, setTimeout, clearTimeout, log } = host;
// Track pending transports for auth completion
const pendingTransports = new Map<string, McpAuthTransport>()
const pendingAuthStates = new Map<string, string>()
const pendingAuthGuards = new Map<string, AuthLease>()
const pendingAuthCleanupTimers = new Map<string, McpAuthTimer>()

// Deduplicate concurrent authenticate() calls per server.
const pendingAuthentications = new Map<string, { operation: Promise<AuthStatus>; guard: AuthLease }>()
const oauthAuthority = createAuthority("MCP OAuth lifecycle")
const oauthServerAuthorities = new Map<string, AuthAuthority>()

function serverOAuthAuthority(serverName: string): AuthAuthority {
  let authority = oauthServerAuthorities.get(serverName)
  if (authority === undefined) {
    authority = createAuthority(`MCP OAuth server ${serverName}`)
    oauthServerAuthorities.set(serverName, authority)
  }
  return authority
}

function combineOAuthContinuation(
  serverName: string,
  session: AuthLease,
  server: AuthLease,
): AuthLease {
  return {
    identity: `MCP OAuth ${serverName}`,
    generation: server.generation,
    signal: AbortSignal.any([session.signal, server.signal]),
    isCurrent: () => session.isCurrent() && server.isCurrent(),
    assertCurrent: () => {
      session.assertCurrent()
      server.assertCurrent()
    },
  }
}

function captureOAuthContinuation(serverName?: string): AuthLease {
  const session = oauthAuthority.capture()
  return serverName === undefined
    ? session
    : combineOAuthContinuation(serverName, session, serverOAuthAuthority(serverName).capture())
}

function beginOAuthContinuation(serverName: string): AuthLease {
  return combineOAuthContinuation(
    serverName,
    oauthAuthority.capture(),
    serverOAuthAuthority(serverName).renew(`MCP OAuth server ${serverName} operation replaced`),
  )
}

/** Timeout for manual auth completion (5 minutes) */
const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Start OAuth authentication flow for a server.
 * Returns the authorization URL when browser authorization is required.
 */
async function startAuth(
  serverName: string,
  serverUrl: string,
  definition?: McpAuthDefinition,
  guard: AuthLease = beginOAuthContinuation(serverName),
): Promise<{ authorizationUrl: string }> {
  guard.assertCurrent()
  const config = definition ? extractOAuthConfig(definition) : {}

  if (config.grantType === "client_credentials") {
    const storedAuth = await getAuthForUrl(serverName, serverUrl)
    guard.assertCurrent()
    if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
      clearClientInfo(serverName)
      clearCodeVerifier(serverName)
      await clearOAuthState(serverName)
    }

    const authProvider = createProvider(serverName, serverUrl, config, {
      onRedirect: async () => {
        guard.assertCurrent()
        throw new Error("Browser redirect is not used for client_credentials flow")
      },
      guard,
    })
    const result = await runSdkAuth(authProvider, { serverUrl })
    guard.assertCurrent()
    if (result !== "AUTHORIZED") {
      throw unauthorized("Failed to authorize")
    }
    return { authorizationUrl: "" }
  }

  const redirectCallback = config.redirectUri !== undefined ? parseOAuthRedirectUri(config.redirectUri) : undefined
  const oauthState = generateState()

  try {
    await ensureCallbackServer({
      signal: guard.signal,
      strictPort: Boolean(config.clientId) || config.redirectUri !== undefined,
      oauthState,
      reserveState: true,
      ...(redirectCallback ? { port: redirectCallback.port, callbackHost: redirectCallback.callbackHost, callbackPath: redirectCallback.callbackPath } : {}),
    })
    guard.assertCurrent()
  } catch (error) {
    if (guard.isCurrent()) await clearOAuthState(serverName)
    throw error
  }

  let capturedUrl: URL | undefined
  const authProvider = createProvider(serverName, serverUrl, config, {
    onRedirect: async (url) => {
      guard.assertCurrent()
      capturedUrl = url
    },
    guard,
  })

  try {
    const storedAuth = await getAuthForUrl(serverName, serverUrl)
    guard.assertCurrent()
    if (storedAuth?.clientInfo && !config.clientId) {
      if (!storedAuth.tokens) {
        clearClientInfo(serverName)
        clearCodeVerifier(serverName)
        await clearOAuthState(serverName)
      } else {
        const redirectUris = storedAuth.clientInfo.redirectUris
        if (!Array.isArray(redirectUris) || !redirectUris.includes(authProvider.redirectUrl ?? "")) {
          clearClientInfo(serverName)
          clearTokens(serverName)
          clearCodeVerifier(serverName)
          await clearOAuthState(serverName)
        }
      }
    }

    guard.assertCurrent()
    await updateOAuthState(serverName, oauthState, serverUrl)
    guard.assertCurrent()

    const result = await runSdkAuth(authProvider, { serverUrl })
    guard.assertCurrent()
    if (result === "AUTHORIZED") {
      releaseCallbackServer(oauthState)
      await clearOAuthState(serverName)
      return { authorizationUrl: "" }
    }
    if (!capturedUrl) {
      throw unauthorized("OAuth authorization URL was not provided")
    }
    const pendingTransport = createTransport(new URL(serverUrl), { authProvider })
    await setPendingTransport(serverName, pendingTransport, oauthState, guard)
    guard.assertCurrent()
    return { authorizationUrl: capturedUrl.toString() }
  } catch (error) {
    await clearPendingAuth(serverName, oauthState)
    throw error
  }
}

async function setPendingTransport(
  serverName: string,
  transport: McpAuthTransport,
  oauthState: string,
  guard: AuthLease,
): Promise<void> {
  await clearPendingAuth(serverName)
  guard.assertCurrent()
  pendingTransports.set(serverName, transport)
  pendingAuthStates.set(serverName, oauthState)
  pendingAuthGuards.set(serverName, guard)
  const cleanupTimer = setTimeout(() => {
    clearPendingAuth(serverName, oauthState).catch((error) => {
      log.debug("[MCP] Failed to clear pending auth on timeout", authErrorView(error, serverName, "cleanup"))
    })
  }, MANUAL_AUTH_TIMEOUT_MS)
  cleanupTimer.unref?.()
  pendingAuthCleanupTimers.set(serverName, cleanupTimer)
}

async function clearPendingAuth(serverName: string, oauthState?: string): Promise<void> {
  const pendingState = pendingAuthStates.get(serverName)
  if (oauthState && pendingState && pendingState !== oauthState) return

  const timer = pendingAuthCleanupTimers.get(serverName)
  if (timer) {
    clearTimeout(timer)
    pendingAuthCleanupTimers.delete(serverName)
  }

  const transport = pendingTransports.get(serverName)
  pendingTransports.delete(serverName)
  pendingAuthStates.delete(serverName)
  pendingAuthGuards.delete(serverName)
  const stateToRelease = pendingState ?? oauthState
  if (stateToRelease) {
    releaseCallbackServer(stateToRelease)
    const storedState = await getOAuthState(serverName)
    if (storedState === stateToRelease) {
      await clearOAuthState(serverName)
    }
  }
  if (transport) {
    try {
      await transport.close()
    } catch (error) {
      log.debug("[MCP] Failed to close pending auth transport", authErrorView(error, serverName, "cleanup"))
    }
  }
}

/**
 * Complete OAuth authentication from manual user input.
 */
async function completeAuthFromInput(
  serverName: string,
  input: string,
): Promise<AuthStatus> {
  const guard = pendingAuthGuards.get(serverName) ?? captureOAuthContinuation(serverName)
  guard.assertCurrent()
  const oauthState = await getOAuthState(serverName)
  guard.assertCurrent()
  const code = parseAuthorizationCodeInput(input, oauthState)
  return completeAuth(serverName, code, guard)
}

/**
 * Complete OAuth authentication with the authorization code.
 */
async function completeAuth(
  serverName: string,
  authorizationCode: string,
  guard: AuthLease = pendingAuthGuards.get(serverName) ?? captureOAuthContinuation(serverName),
): Promise<AuthStatus> {
  guard.assertCurrent()
  const transport = pendingTransports.get(serverName)
  if (!transport) {
    throw new Error(`No pending OAuth flow for server: ${serverName}`)
  }

  const oauthState = await getOAuthState(serverName)
  guard.assertCurrent()

  try {
    // Complete the auth using the transport's finishAuth method
    await transport.finishAuth(authorizationCode)
    guard.assertCurrent()
    return "authenticated"
  } finally {
    await clearPendingAuth(serverName, oauthState)
  }
}

/**
 * Perform the complete OAuth authentication flow for a server.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @param definition - The server definition (optional)
 * @returns The final auth status
 */
async function authenticate(
  serverName: string,
  serverUrl: string,
  definition?: McpAuthDefinition,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const inFlight = pendingAuthentications.get(serverName)
  if (inFlight?.guard.isCurrent()) {
    return inFlight.operation
  }

  const guard = beginOAuthContinuation(serverName)
  const operation = (async (): Promise<AuthStatus> => {
    // Start auth flow
    const { authorizationUrl } = await startAuth(serverName, serverUrl, definition, guard)
    guard.assertCurrent()

    // If no auth URL needed, already authenticated
    if (!authorizationUrl) {
      return "authenticated"
    }

    // Get the state that was already generated and stored in startAuth()
    const oauthState = await getOAuthState(serverName)
    guard.assertCurrent()
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // Register the callback BEFORE opening the browser
    const callbackPromise = waitForCallback(oauthState)

    try {
      // Open browser. Always surface the URL first so remote/headless users can copy it
      // even when the OS browser handoff is unavailable or invisible.
      if (options.onAuthorizationUrl) {
        await options.onAuthorizationUrl(authorizationUrl)
        guard.assertCurrent()
      } else {
        log.info(`MCP Auth: Open this URL to authenticate ${serverName}:\n${authorizationUrl}`)
      }
      try {
        await open(authorizationUrl)
      } catch (error) {
        log.warn(`MCP Auth: Failed to open browser for ${serverName}; waiting for manual callback`, { error: authErrorView(error, serverName, "callback") })
      }

      // Wait for callback
      const code = await callbackPromise
      guard.assertCurrent()

      // Validate state
      const storedState = await getOAuthState(serverName)
      guard.assertCurrent()
      if (storedState !== oauthState) {
        await clearOAuthState(serverName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      await clearOAuthState(serverName)

      // Complete the auth
      return await completeAuth(serverName, code, guard)
    } catch (error) {
      cancelPendingCallback(oauthState)
      await clearPendingAuth(serverName, oauthState)
      throw error
    }
  })()

  const record = { operation, guard }
  pendingAuthentications.set(serverName, record)

  try {
    return await operation
  } finally {
    if (pendingAuthentications.get(serverName) === record) {
      pendingAuthentications.delete(serverName)
    }
  }
}

/**
 * Get a valid access token for a server, refreshing if necessary.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @returns The valid tokens or null if not authenticated
 */
async function getValidToken(
  serverName: string,
  serverUrl: string,
): Promise<T | null> {
  let guard = captureOAuthContinuation(serverName)
  guard.assertCurrent()
  // Check if we have valid tokens
  const entry = await getAuthForUrl(serverName, serverUrl)
  guard.assertCurrent()
  if (!entry?.tokens) {
    return null
  }

  // Check expiration
  const expired = await isTokenExpired(serverName)
  guard.assertCurrent()
  if (expired === false) {
    return entry.tokens
  }

  if (expired === true && entry.tokens.refreshToken) {
    // Token refresh is a credential mutation and replaces any older flow for this server.
    guard = beginOAuthContinuation(serverName)
    guard.assertCurrent()
    log.info(`MCP Auth: Token expired for ${serverName}, attempting refresh`)

    try {
      // Create auth provider for token refresh
      const authProvider = createProvider(serverName, serverUrl, {}, {
        onRedirect: async () => { guard.assertCurrent() },
        guard,
      })

      const clientInfo = await authProvider.clientInformation()
      guard.assertCurrent()
      if (!clientInfo) {
        log.info(`MCP Auth: No client info for refresh for ${serverName}`)
        return null
      }

      const result = await runSdkAuth(authProvider, { serverUrl })
      guard.assertCurrent()
      if (result !== "AUTHORIZED") {
        return null
      }
      const refreshed = await getAuthForUrl(serverName, serverUrl)
      guard.assertCurrent()
      return refreshed?.tokens ?? null
    } catch (error) {
      log.error(`MCP Auth: Token refresh failed for ${serverName}`, { error: authErrorView(error, serverName, "callback") })
      return null
    }
  }

  // No expiration info or no refresh token, assume valid
  return entry.tokens
}

/**
 * Check the authentication status for a server.
 *
 * @param serverName - The name of the MCP server
 * @returns The current auth status
 */
async function getAuthStatus(serverName: string): Promise<AuthStatus> {
  const guard = captureOAuthContinuation(serverName)
  const hasTokens = await hasStoredTokens(serverName)
  guard.assertCurrent()
  if (!hasTokens) return "not_authenticated"

  const expired = await isTokenExpired(serverName)
  guard.assertCurrent()
  return expired ? "expired" : "authenticated"
}

/**
 * Remove all OAuth credentials for a server.
 *
 * @param serverName - The name of the MCP server
 */
async function removeAuth(serverName: string): Promise<void> {
  const guard = beginOAuthContinuation(serverName)
  const oauthState = await getOAuthState(serverName)
  guard.assertCurrent()
  if (oauthState) {
    cancelPendingCallback(oauthState)
  }
  await clearPendingAuth(serverName, oauthState)
  guard.assertCurrent()
  clearAllCredentials(serverName)
  await clearOAuthState(serverName)
  guard.assertCurrent()
  log.info(`MCP Auth: Removed credentials for ${serverName}`)
}

/**
 * Check if OAuth is supported for a server configuration.
 * OAuth is supported for HTTP servers unless explicitly disabled.
 *
 * @param definition - The server definition
 * @returns True if OAuth is supported
 */
/**
 * Initialize the OAuth system on startup.
 * OAuth callback binding is lazy and starts from startAuth() only.
 */
async function initializeOAuth(): Promise<void> {
  oauthAuthority.renew("MCP OAuth lifecycle initialized")
  oauthServerAuthorities.clear()
}

/**
 * Shutdown the OAuth system.
 * Stops the callback server and cancels pending auths.
 */
async function shutdownOAuth(): Promise<void> {
  oauthAuthority.revoke("MCP OAuth lifecycle shut down")
  for (const authority of oauthServerAuthorities.values()) authority.revoke("MCP OAuth lifecycle shut down")
  oauthServerAuthorities.clear()
  const pendingServerNames = Array.from(pendingTransports.keys())
  await Promise.all(pendingServerNames.map(async (serverName) => {
    await clearPendingAuth(serverName)
  }))
  await stopCallbackServer()
}

  const safe = <A extends unknown[], R>(method: (...args: A) => Promise<R>, stage: "callback" | "refresh" | "revoke" | "cleanup") =>
    async (...args: A): Promise<R> => { try { return await method(...args); } catch (error) { throw authError(error, "mcp", stage); } };
  return {
    captureOAuthContinuation, beginOAuthContinuation,
    startAuth: safe(startAuth, "callback"), completeAuthFromInput: safe(completeAuthFromInput, "callback"), completeAuth: safe(completeAuth, "callback"),
    authenticate: safe(authenticate, "callback"), getValidToken: safe(getValidToken, "refresh"), getAuthStatus: safe(getAuthStatus, "callback"),
    removeAuth: safe(removeAuth, "revoke"), initializeOAuth: safe(initializeOAuth, "callback"), shutdownOAuth: safe(shutdownOAuth, "cleanup"),
  };
}
