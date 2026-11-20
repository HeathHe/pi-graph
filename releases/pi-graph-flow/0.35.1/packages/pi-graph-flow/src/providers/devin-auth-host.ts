import { createServer, type Server, type ServerResponse } from "node:http";
import { AuthFailure, authError, DEVIN_TOKEN_URL, DEVIN_CALLBACK_HOST, DEVIN_CALLBACK_PORT, DEVIN_CALLBACK_PATH, DEVIN_CALLBACK_HOST_ENV, DEVIN_CALLBACK_PORT_ENV, type DevinCallbackOutcome, type DevinCallbackServer, type StartDevinCallbackServerOptions } from "pi-graph-provider-backend/auth";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const HOST_PATTERN = /^[A-Za-z0-9.:[\]_-]+$/;
/**
 * Loopback callback listener for one login attempt. Only a callback carrying
 * this attempt's `state` can end it: a forged request is answered with an
 * error page and ignored, and the attempt keeps waiting for its own callback.
 */
async function startDevinCallbackServerImpl(
  expectedState: string,
  options: StartDevinCallbackServerOptions = {},
): Promise<DevinCallbackServer> {
  const host = options.host ?? envHost() ?? DEVIN_CALLBACK_HOST;
  const preferredPort = options.port ?? envPort() ?? DEVIN_CALLBACK_PORT;
  const allowPortFallback = options.allowPortFallback !== false;

  let settle: ((outcome: DevinCallbackOutcome) => void) | undefined;
  let settled = false;
  const outcome = new Promise<DevinCallbackOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (value: DevinCallbackOutcome): void => {
    if (settled) return;
    settled = true;
    settle?.(value);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== DEVIN_CALLBACK_PATH) {
      respond(response, 404, callbackPage("Not found", "This route is not the Devin CLI callback."));
      return;
    }
    const state = url.searchParams.get("state");
    const failure = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    // Only this attempt's own callback may end it: any web page can reach the
    // loopback port, so a forged request must not cancel a live sign-in.
    const owned = state !== null && state === expectedState;
    if (failure) {
      const description = url.searchParams.get("error_description") ?? failure;
      respond(response, 400, callbackPage("Devin sign-in failed", description));
      if (owned) finish({ kind: "error", message: description });
      return;
    }
    if (!owned) {
      respond(response, 400, callbackPage("Devin sign-in failed", "The callback state did not match this sign-in attempt."));
      return;
    }
    if (!code) {
      respond(response, 400, callbackPage("Devin sign-in failed", "The callback carried no authorization code."));
      finish({ kind: "error", message: "The Devin callback carried no authorization code." });
      return;
    }
    respond(response, 200, callbackPage("Devin sign-in complete", "You can close this window and return to Pi."));
    finish({ kind: "code", code, state });
  });

  const port = await listen(server, host, preferredPort, allowPortFallback);
  server.unref();
  const timer = setTimeout(() => finish({ kind: "timeout" }), CALLBACK_TIMEOUT_MS);
  timer.unref();

  return {
    redirectUri: `http://${host}:${port}${DEVIN_CALLBACK_PATH}`,
    wait: () => outcome,
    cancelWait: () => finish({ kind: "cancelled" }),
    async close() {
      clearTimeout(timer);
      finish({ kind: "cancelled" });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startDevinCallbackServer(expectedState: string, options: StartDevinCallbackServerOptions = {}): Promise<DevinCallbackServer> {
  try { return await startDevinCallbackServerImpl(expectedState, options); }
  catch (error) { throw authError(error, "devin", "callback", "transport"); }
}

/** Exchange an authorization code for a Devin session token. */
async function exchangeDevinAuthorizationCodeImpl(
  code: string,
  codeVerifier: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(DEVIN_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new AuthFailure({ provider: "devin", stage: "token-exchange", kind: "http", httpStatus: response.status });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AuthFailure({ provider: "devin", stage: "token-exchange", kind: "protocol" });
  }
  const token = parsed && typeof parsed === "object" ? (parsed as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthFailure({ provider: "devin", stage: "token-exchange", kind: "protocol" });
  }
  return token;
}

export async function exchangeDevinAuthorizationCode(code: string, codeVerifier: string, signal?: AbortSignal): Promise<string> {
  try { return await exchangeDevinAuthorizationCodeImpl(code, codeVerifier, signal); }
  catch (error) { throw authError(error, "devin", "token-exchange", "transport"); }
}

async function listen(
  server: Server,
  host: string,
  preferredPort: number,
  allowPortFallback: boolean,
): Promise<number> {
  try {
    return await listenOn(server, host, preferredPort);
  } catch (error) {
    if (!allowPortFallback || !isAddressInUse(error)) throw error;
    return listenOn(server, host, 0);
  }
}

function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Devin callback server did not report a bound port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";
}

function envHost(): string | undefined {
  const value = process.env[DEVIN_CALLBACK_HOST_ENV]?.trim();
  return value && HOST_PATTERN.test(value) ? value : undefined;
}

function envPort(): number | undefined {
  const value = Number(process.env[DEVIN_CALLBACK_PORT_ENV]);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : undefined;
}

function respond(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function callbackPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #12121c; color: #eaeaea; }
    .box { text-align: center; padding: 2rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
    p { color: #a0a0b0; margin: 0; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

