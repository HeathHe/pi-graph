import { RemoteRpcConnection, RemoteConnectionFactoryOwner, SshTransportError, RemoteRpcResponseError } from "pi-graph-provider-backend/remote";
export { SshTransportError, RemoteRpcResponseError } from "pi-graph-provider-backend/remote";
export type { SshTransportErrorCode } from "pi-graph-provider-backend/remote";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "ssh2";
import type { RemoteConnection, RemoteConnectionFactory } from "./driver.ts";
import {
  TEAMMATE_REMOTE_GATEWAY_COMMAND,
  openTeammateRemoteChannel,
  resolveSshHostRef,
  type SshHostTeammateRemoteChannel,
} from "../public/v1/ssh-hosts.ts";
import {
  REMOTE_MAX_LINE_BYTES,
  createRemoteRequest,
  encodeRemoteEnvelope,
  parseRemoteEnvelopeLine,
  type RemoteInitializeParams,
  type RemoteInitializeResult,
  type RemoteJsonRpcEnvelope,
  type RemoteJsonRpcId,
  type RemoteProtocolNotification,
  type RemoteRequestMethod,
  type RemoteRequestParamsByMethod,
  type RemoteResultByMethod,
  type RemoteRunAttachParams,
  type RemoteRunAttachResult,
  type RemoteRunCancelParams,
  type RemoteRunCancelResult,
  type RemoteRunInputParams,
  type RemoteRunInputResult,
  type RemoteRunListResult,
  type RemoteRunStartParams,
  type RemoteRunStartResult,
  type RemoteWindowListParams,
  type RemoteWindowListResult,
  type RemoteWindowObserveParams,
  type RemoteWindowObserveResult,
  type RemoteWindowReceiptParams,
  type RemoteWindowReceiptResult,
  type RemoteWindowSendParams,
  type RemoteWindowSendResult,
  type RemoteWindowBridgeNegotiation,
} from "./protocol.ts";
import {
  isRemoteHostReferenceConfig,
  type RemoteHostConfig,
  type RemoteHostEntry,
  type RemoteStatus,
  type RemoteWorkerIdentity,
  type ResolvedRemoteTarget,
  type ResolvedRemoteWorkspace,
} from "./types.ts";

/** @deprecated Import TEAMMATE_REMOTE_GATEWAY_COMMAND from the dependency-light v1/ssh-hosts subpath. */
export const REMOTE_GATEWAY_COMMAND = TEAMMATE_REMOTE_GATEWAY_COMMAND;
export const SSH_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const SSH_DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
export const SSH_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const SSH_DEFAULT_KEEPALIVE_MS = 10_000;
export const SSH_DEFAULT_KEEPALIVE_COUNT = 3;
export const SSH_DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
export const SSH_DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 4 * 1024 * 1024;

export type RemoteWindowBridgeFailure = Exclude<RemoteWindowBridgeNegotiation, { status: "supported" }>;

/** Maps transport/setup failures without exposing remote stderr, argv, host, or path data. */
export function diagnoseRemoteWindowBridgeError(error: unknown): RemoteWindowBridgeFailure {
  const daemonIncompatible = error instanceof RemoteRpcResponseError
    || (error instanceof SshTransportError
      && (error.code === "protocol"
        || error.code === "request-timeout"
        || error.code === "output-limit"));
  return daemonIncompatible
    ? {
      status: "upgrade-required",
      code: "daemon-incompatible",
      message: "Remote daemon is incompatible with the window bridge handshake",
    }
    : {
      status: "unsupported",
      code: "host-unreachable",
      message: "Configured SSH host is unreachable or could not be authenticated",
    };
}

export interface SshClientConnectConfig {
  host: string;
  port: number;
  username: string;
  hostVerifier: (presentedKey: Buffer) => boolean;
  privateKey?: Buffer;
  agent?: string;
  authHandler: readonly ["publickey"] | readonly ["agent"];
  keepaliveInterval: number;
  keepaliveCountMax: number;
  timeout: number;
  readyTimeout: number;
  strictVendor: boolean;
  tryKeyboard: false;
}

export interface SshChannelLike extends NodeJS.ReadWriteStream {
  readonly stderr: NodeJS.ReadableStream;
  readonly destroyed?: boolean;
  readonly closed?: boolean;
  destroy(error?: Error): this;
}

export interface SshClientLike {
  connect(config: SshClientConnectConfig): unknown;
  exec(command: string, callback: (error: Error | undefined, channel: SshChannelLike) => void): unknown;
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  end(): unknown;
  destroy(): unknown;
}

export interface SshRemoteConnectionFactoryOptions {
  createClient?: () => SshClientLike;
  readIdentityFile?: (filePath: string) => Buffer;
  agentSocket?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  maxConnectionsPerHost?: number;
  maxChannelsPerConnection?: number;
  maxPendingPerHost?: number;
  maxStderrBytes?: number;
  maxBufferedOutputBytes?: number;
}

interface NormalizedSshOptions {
  createClient: () => SshClientLike;
  readIdentityFile: (filePath: string) => Buffer;
  agentSocket?: string;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  maxConnectionsPerHost: number;
  maxChannelsPerConnection: number;
  maxPendingPerHost: number;
  maxStderrBytes: number;
  maxBufferedOutputBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return normalized;
}

function normalizeOptions(options: SshRemoteConnectionFactoryOptions): NormalizedSshOptions {
  const agentSocket = options.agentSocket ?? process.env.SSH_AUTH_SOCK;
  return {
    createClient: options.createClient ?? (() => new Client() as unknown as SshClientLike),
    readIdentityFile: options.readIdentityFile ?? readPrivateIdentityFile,
    ...(agentSocket ? { agentSocket } : {}),
    connectTimeoutMs: positiveInteger(options.connectTimeoutMs, SSH_DEFAULT_CONNECT_TIMEOUT_MS, "SSH connect timeout"),
    handshakeTimeoutMs: positiveInteger(options.handshakeTimeoutMs, SSH_DEFAULT_HANDSHAKE_TIMEOUT_MS, "SSH handshake timeout"),
    requestTimeoutMs: positiveInteger(options.requestTimeoutMs, SSH_DEFAULT_REQUEST_TIMEOUT_MS, "SSH request timeout"),
    keepaliveIntervalMs: positiveInteger(options.keepaliveIntervalMs, SSH_DEFAULT_KEEPALIVE_MS, "SSH keepalive interval"),
    keepaliveCountMax: positiveInteger(options.keepaliveCountMax, SSH_DEFAULT_KEEPALIVE_COUNT, "SSH keepalive count", 100),
    maxConnectionsPerHost: positiveInteger(options.maxConnectionsPerHost, 2, "SSH connections per host", 32),
    maxChannelsPerConnection: positiveInteger(options.maxChannelsPerConnection, 4, "SSH channels per connection", 128),
    maxPendingPerHost: positiveInteger(options.maxPendingPerHost, 64, "SSH pending requests per host", 4096),
    maxStderrBytes: positiveInteger(options.maxStderrBytes, SSH_DEFAULT_MAX_STDERR_BYTES, "SSH stderr limit"),
    maxBufferedOutputBytes: positiveInteger(
      options.maxBufferedOutputBytes,
      SSH_DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
      "SSH buffered output limit",
    ),
  };
}

export function expandIdentityPath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return path.join(os.homedir(), filePath.slice(2));
  return path.resolve(filePath);
}

export function readPrivateIdentityFile(filePath: string): Buffer {
  const resolved = expandIdentityPath(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
    throw new SshTransportError("identity", "SSH identity reference is not a bounded regular file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new SshTransportError("identity", "SSH identity file permissions must deny group and other access");
  }
  return fs.readFileSync(resolved);
}

function normalizedFingerprint(value: string): string {
  return value.slice("SHA256:".length).replace(/=+$/, "");
}

/** Creates a fail-closed verifier for the OpenSSH SHA256 host-key fingerprint form. */
export function createPinnedHostKeyVerifier(expectedFingerprint: string): (presentedKey: Buffer) => boolean {
  if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/.test(expectedFingerprint)) {
    throw new SshTransportError("host-key", "Invalid configured SSH host-key fingerprint");
  }
  const expected = Buffer.from(normalizedFingerprint(expectedFingerprint), "utf8");
  return (presentedKey: Buffer): boolean => {
    const actual = Buffer.from(createHash("sha256").update(presentedKey).digest("base64").replace(/=+$/, ""), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

function hostPoolKey(host: RemoteHostConfig): string {
  return JSON.stringify([host.host, host.port, host.user, host.hostKeySha256, host.identityFile ?? "agent"]);
}

async function resolveRemoteHostEntry(entry: RemoteHostEntry): Promise<{
  host: RemoteHostConfig;
  sshHostRef?: string;
}> {
  if (!isRemoteHostReferenceConfig(entry)) return { host: entry };
  const profile = await resolveSshHostRef(entry.sshHostRef);
  return {
    sshHostRef: entry.sshHostRef,
    host: {
      host: profile.host,
      user: profile.user,
      port: profile.port,
      hostKeySha256: profile.hostKeySha256,
      ...(profile.authentication.kind === "identity"
        ? { identityFile: profile.authentication.identityFile }
        : {}),
    },
  };
}

function validateHost(host: RemoteHostConfig): void {
  if (!host.host || !host.user || !Number.isInteger(host.port)) {
    throw new SshTransportError("protocol", "Configured remote SSH host is invalid");
  }
}

function validateTarget(target: ResolvedRemoteTarget): void {
  if (!path.posix.isAbsolute(target.cwd) || target.cwd.includes("\0")) {
    throw new SshTransportError("protocol", "Configured remote target cwd must be an absolute POSIX path");
  }
  if (target.command.length < 1 || target.command.some((argument) => !argument || argument.includes("\0"))) {
    throw new SshTransportError("protocol", "Configured remote target command argv is invalid");
  }
}

function validateWorkspace(workspace: ResolvedRemoteWorkspace): void {
  if (!path.posix.isAbsolute(workspace.cwd)
    || path.posix.normalize(workspace.cwd) !== workspace.cwd
    || workspace.cwd.includes("\0")) {
    throw new SshTransportError("protocol", "Configured remote workspace cwd must be a canonical absolute POSIX path");
  }
}

function abortError(): Error {
  const error = new Error("SSH connection request was aborted");
  error.name = "AbortError";
  return error;
}

function connectSshClient(
  client: SshClientLike,
  host: RemoteHostConfig,
  options: NormalizedSshOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let hostKeyRejected = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let handshakeTimer: NodeJS.Timeout | undefined;
    let privateKey: Buffer | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      client.off("connect", onConnect);
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("close", onClose);
      privateKey?.fill(0);
      privateKey = undefined;
      if (error) {
        client.destroy();
        reject(error);
      } else resolve();
    };
    const onConnect = () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);
      handshakeTimer = setTimeout(() => finish(new SshTransportError(
        "handshake-timeout",
        "Timed out during SSH handshake and authentication",
      )), options.handshakeTimeoutMs);
      handshakeTimer.unref?.();
    };
    const onReady = () => finish();
    const onError = (error: unknown) => finish(new SshTransportError(
      hostKeyRejected ? "host-key" : "transport",
      hostKeyRejected ? "Configured SSH host key fingerprint did not match" : "SSH connection or authentication failed",
      { cause: error },
    ));
    const onClose = () => finish(new SshTransportError(
      hostKeyRejected ? "host-key" : (connected ? "transport" : "connect-timeout"),
      hostKeyRejected
        ? "Configured SSH host key fingerprint did not match"
        : (connected ? "SSH connection closed during setup" : "SSH connection closed before transport setup"),
    ));
    client.once("connect", onConnect);
    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);
    connectTimer = setTimeout(() => finish(new SshTransportError(
      "connect-timeout",
      "Timed out connecting to configured SSH host",
    )), options.connectTimeoutMs);
    connectTimer.unref?.();

    try {
      privateKey = host.identityFile ? options.readIdentityFile(host.identityFile) : undefined;
      if (!privateKey && !options.agentSocket) throw new SshTransportError(
        "authentication",
        "Configured SSH host requires an identity-file reference or an available ssh-agent",
      );
      const verifyHostKey = createPinnedHostKeyVerifier(host.hostKeySha256);
      client.connect({
        host: host.host,
        port: host.port,
        username: host.user,
        hostVerifier: (key: Buffer) => {
          const accepted = verifyHostKey(key);
          hostKeyRejected = !accepted;
          return accepted;
        },
        ...(privateKey ? { privateKey, authHandler: ["publickey" as const] } : {
          agent: options.agentSocket,
          authHandler: ["agent" as const],
        }),
        keepaliveInterval: options.keepaliveIntervalMs,
        keepaliveCountMax: options.keepaliveCountMax,
        timeout: options.connectTimeoutMs,
        readyTimeout: options.handshakeTimeoutMs,
        strictVendor: true,
        tryKeyboard: false,
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

class BoundedLineDecoder {
  #buffer = Buffer.alloc(0);
  readonly #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  write(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > REMOTE_MAX_LINE_BYTES) throw new SshTransportError("output-limit", "Remote gateway record exceeds limit");
      const line = this.#buffer.subarray(0, newline + 1).toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#onLine(line);
    }
    if (this.#buffer.length > REMOTE_MAX_LINE_BYTES) {
      throw new SshTransportError("output-limit", "Remote gateway record exceeds limit");
    }
  }

  end(): void {
    if (this.#buffer.length > 0) throw new SshTransportError("protocol", "Remote gateway ended with an incomplete record");
  }
}

class SshRemoteConnection extends RemoteRpcConnection<RemoteProtocolNotification> implements RemoteConnection {
  constructor(stream: SshChannelLike, release: () => void, options: NormalizedSshOptions) {
    super({ onData: (fn) => { stream.on("data", fn); }, onStderr: (fn) => { stream.stderr.on("data", fn); },
      onExit: (fn) => { stream.once("exit", fn); }, onClose: (fn) => { stream.once("close", fn); },
      onError: (fn) => { stream.once("error", fn); }, onDrain: (fn) => { stream.once("drain", fn); return () => { stream.off("drain", fn); }; },
      isClosed: () => stream.destroyed === true || stream.closed === true,
      write: (encoded) => stream.write(encoded), end: () => { stream.end(); }, destroy: () => { stream.destroy(); },
    }, release, { ...options, randomUUID,
      timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout) },
      byteLength: (value) => Buffer.byteLength(value as string | Buffer),
      createDecoder: (onLine) => { const decoder = new BoundedLineDecoder(onLine); return {
        write: (chunk) => decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)), end: () => decoder.end(),
      }; },
      parse: parseRemoteEnvelopeLine, encode: encodeRemoteEnvelope,
      acceptNotification: (method) => ["run/state", "run/event", "run/result", "window/state", "window/message", "worker/heartbeat"].includes(method),
    });
  }
  async initialize(params: RemoteInitializeParams): Promise<RemoteInitializeResult> {
    const result = await this.request("remote/initialize", params); this.admitIdentity(result); return result;
  }
  override request<Method extends RemoteRequestMethod>(method: Method, params: RemoteRequestParamsByMethod[Method]): Promise<RemoteResultByMethod[Method]> {
    return super.request(method, params) as Promise<RemoteResultByMethod[Method]>;
  }
  start(params: RemoteRunStartParams): Promise<RemoteRunStartResult> { return this.request("run/start", params); }
  attach(params: RemoteRunAttachParams): Promise<RemoteRunAttachResult> { return this.request("run/attach", params); }
  input(params: RemoteRunInputParams): Promise<RemoteRunInputResult> { return this.request("run/input", params); }
  cancel(params: RemoteRunCancelParams): Promise<RemoteRunCancelResult> { return this.request("run/cancel", params); }
  list(commandId: string, monitorOwnerNonce: string): Promise<RemoteRunListResult> { return this.request("run/list", { commandId, monitorOwnerNonce }); }
  windowList(params: RemoteWindowListParams): Promise<RemoteWindowListResult> { return this.request("window/list", params); }
  windowObserve(params: RemoteWindowObserveParams): Promise<RemoteWindowObserveResult> { return this.request("window/observe", params); }
  windowSend(params: RemoteWindowSendParams): Promise<RemoteWindowSendResult> { return this.request("window/send", params); }
  windowReceipt(params: RemoteWindowReceiptParams): Promise<RemoteWindowReceiptResult> { return this.request("window/receipt", params); }
}
async function execGateway(client: SshClientLike): Promise<SshChannelLike> {
  return new Promise((resolve, reject) => {
    client.exec(REMOTE_GATEWAY_COMMAND, (error, stream) => {
      if (error) reject(new SshTransportError("transport", "Failed to launch fixed remote gateway", { cause: error }));
      else resolve(stream);
    });
  });
}

/** Pooled SSH factory for configured POSIX remote targets. */
export class SshRemoteConnectionFactory implements RemoteConnectionFactory {
  readonly #owner: RemoteConnectionFactoryOwner<ResolvedRemoteTarget, ResolvedRemoteWorkspace, RemoteHostEntry, RemoteHostConfig, SshClientLike, SshChannelLike, SshHostTeammateRemoteChannel, SshRemoteConnection>;
  constructor(options: SshRemoteConnectionFactoryOptions = {}) {
    const normalized = normalizeOptions(options);
    this.#owner = new RemoteConnectionFactoryOwner({
      validateTarget, validateWorkspace, targetEntry: (target) => target.hostConfig, workspaceEntry: (workspace) => workspace.hostConfig,
      referenceId: (entry) => isRemoteHostReferenceConfig(entry) ? entry.sshHostRef : undefined,
      openProvided: openTeammateRemoteChannel, resolveEntry: resolveRemoteHostEntry, validateHost, hostPoolKey,
      pool: normalized, connectClient: (client, host) => connectSshClient(client, host, normalized),
      execGateway, createConnection: (stream, release) => new SshRemoteConnection(stream, release, normalized),
      providedStream: (provided) => provided.stream, closeProvided: (provided) => provided.close(),
    });
  }
  connect(target: ResolvedRemoteTarget, signal?: AbortSignal): Promise<RemoteConnection> { return this.#owner.connect(target, signal); }
  connectWorkspace(workspace: ResolvedRemoteWorkspace, signal?: AbortSignal): Promise<RemoteConnection> { return this.#owner.connectWorkspace(workspace, signal); }
  close(): Promise<void> { return this.#owner.close(); }
}
