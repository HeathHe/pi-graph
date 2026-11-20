import type { RemoteJsonRpcEnvelope, RemoteJsonRpcId, RemoteJsonRpcNotification, RemoteProtocolNotification,
  RemoteInitializeResult, RemoteWorkerIdentity, RemoteStatus } from "../protocol/remote-run.ts";
import type { RemoteTimer, RemoteTimers } from "./ports.ts";
export interface RemoteLineDecoder { write(chunk: unknown): void; end(): void }
export interface RemoteRpcStream {
  onData(callback: (chunk: unknown) => void): void;
  onStderr(callback: (chunk: unknown) => void): void;
  onExit(callback: (code: number) => void): void;
  onClose(callback: () => void): void;
  onError(callback: (error: Error) => void): void;
  onDrain(callback: () => void): () => void;
  isClosed(): boolean;
  write(encoded: string): boolean;
  end(): void; destroy(): void;
}
export interface RemoteRpcOptions {
  requestTimeoutMs: number; maxStderrBytes: number; maxBufferedOutputBytes: number;
  randomUUID(): string; timers: RemoteTimers;
  byteLength(value: unknown): number;
  createDecoder(onLine: (line: string) => void): RemoteLineDecoder;
  parse(line: string): RemoteJsonRpcEnvelope; encode(envelope: RemoteJsonRpcEnvelope): string;
  acceptNotification(method: string): boolean;
}
interface PendingResponse {
  resolve(value: unknown): void; reject(error: Error, cancelWrite?: boolean): void;
  timer?: RemoteTimer; responseReceived: boolean; writeStarted: boolean; writeFinished: boolean;
}
export type SshTransportErrorCode =
  | "authentication"
  | "connect-timeout"
  | "handshake-timeout"
  | "host-key"
  | "identity"
  | "output-limit"
  | "pool-limit"
  | "protocol"
  | "request-timeout"
  | "transport";

export class SshTransportError extends Error {
  readonly code: SshTransportErrorCode;

  constructor(code: SshTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SshTransportError";
    this.code = code;
  }
}

export class RemoteRpcResponseError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RemoteRpcResponseError";
    this.code = code;
    this.data = data;
  }
}

class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly #limit: number;
  readonly #items: Array<{ value: T; bytes: number }> = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  #bytes = 0;
  #ended = false;
  #error?: Error;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(value: T, bytes: number): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (this.#bytes + bytes > this.#limit) {
      throw new SshTransportError("output-limit", "Remote notification buffer exceeded limit");
    }
    this.#items.push({ value, bytes });
    this.#bytes += bytes;
  }

  end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) {
          this.#bytes -= item.bytes;
          return Promise.resolve({ value: item.value, done: false });
        }
        if (this.#ended) {
          return this.#error
            ? Promise.reject(this.#error)
            : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

export class RemoteRpcConnection<TNotification extends RemoteJsonRpcNotification = RemoteProtocolNotification> {
  readonly #stream: RemoteRpcStream;
  readonly #release: () => void;
  readonly #requestTimeoutMs: number;
  readonly #maxStderrBytes: number;
  readonly #notifications: BoundedAsyncQueue<TNotification>;
  readonly #pending = new Map<RemoteJsonRpcId, PendingResponse>();
  readonly #decoder: RemoteLineDecoder;
  readonly #options: RemoteRpcOptions;
  #status: RemoteStatus = "connecting";
  #identity?: RemoteWorkerIdentity;
  #stderrBytes = 0;
  #exitCode?: number;
  #closed = false;
  #released = false;
  #writeTail = Promise.resolve();
  #closedPromise: Promise<void>;
  #resolveClosed!: () => void;

  constructor(stream: RemoteRpcStream, release: () => void, options: RemoteRpcOptions) {
    this.#stream = stream;
    this.#options = options;
    this.#release = release;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#maxStderrBytes = options.maxStderrBytes;
    this.#notifications = new BoundedAsyncQueue(options.maxBufferedOutputBytes);
    this.#decoder = options.createDecoder((line) => this.#handleEnvelope(options.parse(line), options.byteLength(line)));
    this.#closedPromise = new Promise((resolve) => { this.#resolveClosed = resolve; });
    stream.onData((chunk: unknown) => {
      try { this.#decoder.write(chunk); }
      catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
    });
    stream.onStderr((chunk: unknown) => {
      this.#stderrBytes += options.byteLength(chunk);
      if (this.#stderrBytes > this.#maxStderrBytes) {
        this.#fail(new SshTransportError("output-limit", "Remote gateway stderr exceeded limit"));
      }
    });
    stream.onExit( (code: number) => { this.#exitCode = code; });
    stream.onClose( () => this.#finalize(this.#closed
      ? undefined
      : new SshTransportError("transport", this.#exitCode
        ? `Remote gateway exited with status ${this.#exitCode}`
        : "Remote gateway disconnected")));
    stream.onError( (error: Error) => this.#fail(new SshTransportError(
      "transport",
      "Remote gateway stream failed",
      { cause: error },
    )));
    if (stream.isClosed()) {
      this.#finalize(new SshTransportError("transport", "Remote gateway disconnected before connection handoff"));
    }
  }

  get status(): RemoteStatus { return this.#status; }
  get identity(): RemoteWorkerIdentity | undefined { return this.#identity; }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new SshTransportError("transport", "Remote gateway connection is closed");
    const id = `ssh-rpc-${this.#options.randomUUID()}`;
    const writing = new AbortController();
    let resolveResponse!: (value: unknown) => void, rejectResponse!: (error: Error) => void;
    const response = new Promise<unknown>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    // Observe immediately, including encoding failures and queued writes. The
    // original error is still returned through this public request below.
    const responseOutcome = response.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    const pending: PendingResponse = {
      responseReceived: false, writeStarted: false, writeFinished: false,
      resolve: value => {
        if (pending.responseReceived) return;
        pending.responseReceived = true; resolveResponse(value);
        if (pending.writeFinished) this.#releaseRequest(id, pending);
      },
      reject: (error, cancelWrite = true) => {
        if (!pending.responseReceived) { pending.responseReceived = true; rejectResponse(error); }
        if (cancelWrite) writing.abort(error);
        if (cancelWrite || pending.writeFinished) this.#releaseRequest(id, pending);
      },
    };
    this.#pending.set(id, pending);
    pending.timer = this.#options.timers.setTimeout(() => {
      if (this.#pending.get(id) !== pending) return;
      const error = new SshTransportError("request-timeout", `Timed out waiting for remote ${method} response`);
      if (pending.writeStarted && !pending.writeFinished) this.#fail(error);
      else pending.reject(error);
    }, this.#requestTimeoutMs);
    pending.timer.unref?.();
    let removeAbortObserver = (): void => {};
    try {
      const encoded = this.#options.encode({ jsonrpc: "2.0", id, method, params });
      const write = this.#writeTail.then(async () => {
        // A cancelled slot that never wrote cannot poison the physical queue.
        // Its public request already observes the exact cancellation reason.
        if (writing.signal.aborted) return;
        if (this.#closed) throw new SshTransportError("transport", "Remote gateway connection is closed");
        pending.writeStarted = true;
        try {
          if (!this.#stream.write(encoded)) await this.#waitForDrain(writing.signal);
          if (writing.signal.aborted) throw this.#writeAbortError(writing.signal);
          pending.writeFinished = true;
          if (pending.responseReceived) this.#releaseRequest(id, pending);
        } catch (error) {
          // Once bytes entered the stream, an undrained failed write cannot be
          // skipped or retried safely. Revoke this transport for real reconnect.
          this.#fail(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      });
      this.#writeTail = write;
      const cancelled = new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(this.#writeAbortError(writing.signal));
        writing.signal.addEventListener("abort", abort, { once: true });
        removeAbortObserver = () => writing.signal.removeEventListener("abort", abort);
        if (writing.signal.aborted) abort();
      });
      // A queued request has its own deadline, independently of an earlier
      // request's backpressure. Its eventual queue slot checks the same token
      // before any write, so an expired slot can never send late.
      const [, outcome] = await Promise.all([Promise.race([write, cancelled]), responseOutcome]);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      removeAbortObserver();
      this.#releaseRequest(id, pending);
    }
  }

  #releaseRequest(id: RemoteJsonRpcId, pending: PendingResponse): void {
    if (pending.timer) this.#options.timers.clearTimeout(pending.timer);
    if (this.#pending.get(id) === pending) this.#pending.delete(id);
  }

  #writeAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new SshTransportError("transport", "Remote gateway write was cancelled");
  }

  #waitForDrain(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(this.#writeAbortError(signal));
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let dispose = (): void => {};
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        dispose();
        if (error) reject(error); else resolve();
      };
      const abort = (): void => finish(this.#writeAbortError(signal));
      signal.addEventListener("abort", abort, { once: true });
      dispose = this.#stream.onDrain(() => finish());
      if (finished) dispose();
      else if (signal.aborted) abort();
    });
  }

  protected admitIdentity(result: RemoteInitializeResult): void {
    this.#identity = Object.freeze({ workerId: result.workerId, instanceNonce: result.instanceNonce });
    this.#status = result.status;
  }
  notifications(): AsyncIterable<TNotification> { return this.#notifications; }

  async close(): Promise<void> {
    if (this.#closed) return this.#closedPromise;
    this.#closed = true;
    this.#stream.end();
    const timer = this.#options.timers.setTimeout(() => this.#stream.destroy(), 1_000);
    timer.unref?.();
    await this.#closedPromise;
    this.#options.timers.clearTimeout(timer);
  }

  #handleEnvelope(envelope: RemoteJsonRpcEnvelope, bytes: number): void {
    if ("id" in envelope) {
      if ("method" in envelope) throw new SshTransportError("protocol", "Remote gateway sent an unexpected request");
      if (envelope.id === null) throw new SshTransportError("protocol", "Remote gateway returned an uncorrelated response");
      const pending = this.#pending.get(envelope.id);
      if (!pending || pending.responseReceived) return;
      if ("error" in envelope) pending.reject(new RemoteRpcResponseError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.data,
      ), false);
      else pending.resolve(envelope.result);
      return;
    }
    if (!this.#options.acceptNotification(envelope.method)) {
      throw new SshTransportError("protocol", `Unknown remote notification method: ${envelope.method}`);
    }
    this.#notifications.push(envelope as TNotification, bytes);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#finalize(error);
    this.#stream.destroy();
  }

  #finalize(error?: Error): void {
    if (this.#released) return;
    this.#closed = true;
    this.#released = true;
    this.#status = "disconnected";
    try { this.#release(); }
    finally {
      for (const pending of [...this.#pending.values()]) {
        pending.reject(error ?? new SshTransportError("transport", "Remote gateway connection closed"));
      }
      this.#pending.clear();
      try { this.#decoder.end(); } catch (decodeError) { error ??= decodeError as Error; }
      this.#notifications.end(error);
      this.#resolveClosed();
    }
  }
}

