import { SshTransportError } from "./rpc-connection.ts";
export interface RemotePoolClient {
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  end(): unknown; destroy(): unknown;
}
export interface RemotePoolOptions<TClient extends RemotePoolClient> {
  createClient(): TClient; connect(client: TClient): Promise<void>;
  maxConnectionsPerHost: number; maxChannelsPerConnection: number; maxPendingPerHost: number;
}
interface PoolSlot<TClient> { client: TClient; activeChannels: number; closed: boolean }
export interface PoolLease<TClient> { client: TClient; release(): void }
interface PendingLease<TClient> {
  resolve(lease: PoolLease<TClient>): void; reject(error: Error): void; signal?: AbortSignal; onAbort?: () => void;
}
function abortError(): Error { const error = new Error("SSH connection request was aborted"); error.name = "AbortError"; return error; }
export interface RemoteConnectionLifecycle { readonly status: string; close(): Promise<void> }
export interface RemoteSshFactoryPorts<TTarget, TWorkspace, TEntry, THost, TClient extends RemotePoolClient, TStream, TProvided, TConnection extends RemoteConnectionLifecycle> {
  validateTarget(target: TTarget): void; validateWorkspace(workspace: TWorkspace): void;
  targetEntry(target: TTarget): TEntry; workspaceEntry(workspace: TWorkspace): TEntry;
  referenceId(entry: TEntry): string | undefined;
  openProvided(reference: string, signal?: AbortSignal): Promise<TProvided | undefined>;
  resolveEntry(entry: TEntry): Promise<{ host: THost; sshHostRef?: string }>;
  validateHost(host: THost): void; hostPoolKey(host: THost): string;
  pool: Omit<RemotePoolOptions<TClient>, "connect">; connectClient(client: TClient, host: THost): Promise<void>;
  execGateway(client: TClient): Promise<TStream>; createConnection(stream: TStream, release: () => void): TConnection;
  providedStream(provided: TProvided): TStream; closeProvided(provided: TProvided): unknown;
}
export class RemoteHostConnectionPool<TClient extends RemotePoolClient> {
  readonly #options: RemotePoolOptions<TClient>;
  readonly #onClose: () => void;
  readonly #slots: PoolSlot<TClient>[] = [];
  readonly #pending: PendingLease<TClient>[] = [];
  #connecting = 0;
  #retired = false;
  #closed = false;

  constructor(options: RemotePoolOptions<TClient>, onClose: () => void) {
    this.#options = options;
    this.#onClose = onClose;
  }

  acquire(signal?: AbortSignal): Promise<PoolLease<TClient>> {
    if (this.#closed || this.#retired) return Promise.reject(new SshTransportError("transport", "SSH host pool is closed"));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.#pending.length >= this.#options.maxPendingPerHost) {
      return Promise.reject(new SshTransportError("pool-limit", "SSH host pool pending limit reached"));
    }
    return new Promise<PoolLease<TClient>>((resolve, reject) => {
      const pending: PendingLease<TClient> = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        pending.onAbort = () => {
          const index = this.#pending.indexOf(pending);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.#pending.push(pending);
      this.#drain();
    });
  }

  retire(): void {
    if (this.#closed || this.#retired) return;
    this.#retired = true;
    for (const pending of this.#pending.splice(0)) {
      this.#cleanupPending(pending);
      pending.reject(new SshTransportError("transport", "SSH host reference changed before pool admission"));
    }
    this.#closeRetiredIfIdle();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.splice(0)) {
      this.#cleanupPending(pending);
      pending.reject(new SshTransportError("transport", "SSH host pool closed before admission"));
    }
    for (const slot of this.#slots.splice(0)) {
      slot.closed = true;
      slot.client.end();
    }
    this.#onClose();
  }

  #drain(): void {
    if (this.#closed || this.#retired) {
      this.#closeRetiredIfIdle();
      return;
    }
    while (this.#pending.length > 0) {
      const slot = this.#slots.find((candidate) => !candidate.closed
        && candidate.activeChannels < this.#options.maxChannelsPerConnection);
      if (slot) {
        const pending = this.#pending.shift()!;
        if (pending.signal?.aborted) {
          this.#cleanupPending(pending);
          pending.reject(abortError());
          continue;
        }
        slot.activeChannels += 1;
        this.#cleanupPending(pending);
        pending.resolve(this.#lease(slot));
        continue;
      }
      if (this.#slots.length + this.#connecting >= this.#options.maxConnectionsPerHost) return;
      const pending = this.#pending.shift()!;
      if (pending.signal?.aborted) {
        this.#cleanupPending(pending);
        pending.reject(abortError());
        continue;
      }
      this.#cleanupPending(pending);
      this.#connecting += 1;
      void this.#openSlot().then((created) => {
        this.#connecting -= 1;
        if (this.#closed || this.#retired) {
          created.client.end();
          pending.reject(new SshTransportError("transport", "SSH host pool closed during setup"));
          this.#closeRetiredIfIdle();
          return;
        }
        created.activeChannels = 1;
        this.#slots.push(created);
        pending.resolve(this.#lease(created));
        this.#drain();
      }, (error: unknown) => {
        this.#connecting -= 1;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        this.#drain();
      });
    }
  }

  #lease(slot: PoolSlot<TClient>): PoolLease<TClient> {
    let released = false;
    return {
      client: slot.client,
      release: () => {
        if (released) return;
        released = true;
        slot.activeChannels = Math.max(0, slot.activeChannels - 1);
        if (this.#retired) this.#closeRetiredIfIdle();
        else this.#drain();
      },
    };
  }

  #cleanupPending(pending: PendingLease<TClient>): void {
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  #closeRetiredIfIdle(): void {
    if (!this.#retired || this.#closed || this.#connecting > 0) return;
    if (this.#slots.some((slot) => !slot.closed && slot.activeChannels > 0)) return;
    this.close();
  }

  async #openSlot(): Promise<PoolSlot<TClient>> {
    const client = this.#options.createClient();
    const slot: PoolSlot<TClient> = { client, activeChannels: 0, closed: false };
    await this.#options.connect(client);
    client.on("error", () => client.destroy());
    client.once("close", () => {
      slot.closed = true;
      const index = this.#slots.indexOf(slot);
      if (index >= 0) this.#slots.splice(index, 1);
      this.#drain();
    });
    return slot;
  }
}

export class RemoteConnectionFactoryOwner<TTarget, TWorkspace, TEntry, THost, TClient extends RemotePoolClient, TStream, TProvided, TConnection extends RemoteConnectionLifecycle> {
  readonly #options: RemoteSshFactoryPorts<TTarget, TWorkspace, TEntry, THost, TClient, TStream, TProvided, TConnection>;
  readonly #pools = new Map<string, RemoteHostConnectionPool<TClient>>();
  readonly #allPools = new Set<RemoteHostConnectionPool<TClient>>();
  readonly #referencePoolKeys = new Map<string, string>();
  readonly #providerConnections = new Set<TConnection>();
  #closed = false;

  constructor(options: RemoteSshFactoryPorts<TTarget, TWorkspace, TEntry, THost, TClient, TStream, TProvided, TConnection>) { this.#options = options; }

  async connect(target: TTarget, signal?: AbortSignal): Promise<TConnection> {
    this.#options.validateTarget(target);
    return this.#connectHost(this.#options.targetEntry(target), signal);
  }

  /** Opens the same pinned, pooled gateway for an explicitly configured workspace. */
  async connectWorkspace(workspace: TWorkspace, signal?: AbortSignal): Promise<TConnection> {
    this.#options.validateWorkspace(workspace);
    return this.#connectHost(this.#options.workspaceEntry(workspace), signal);
  }

  async #connectHost(entry: TEntry, signal?: AbortSignal): Promise<TConnection> {
    if (this.#closed) throw new SshTransportError("transport", "SSH connection factory is closed");
    const referenceId = this.#options.referenceId(entry);
    if (referenceId !== undefined) {
      const provided = await this.#options.openProvided(referenceId, signal);
      if (provided) return this.#prepareProviderConnection(provided);
    }
    const resolved = await this.#options.resolveEntry(entry);
    if (this.#closed) throw new SshTransportError("transport", "SSH connection factory is closed");
    this.#options.validateHost(resolved.host);
    const hostKey = this.#options.hostPoolKey(resolved.host);
    const key = resolved.sshHostRef === undefined
      ? `inline:${hostKey}`
      : `reference:${resolved.sshHostRef}:${hostKey}`;
    if (resolved.sshHostRef !== undefined) {
      const previousKey = this.#referencePoolKeys.get(resolved.sshHostRef);
      if (previousKey && previousKey !== key) {
        const previousPool = this.#pools.get(previousKey);
        if (previousPool && this.#pools.get(previousKey) === previousPool) this.#pools.delete(previousKey);
        previousPool?.retire();
      }
      this.#referencePoolKeys.set(resolved.sshHostRef, key);
    }
    let pool = this.#pools.get(key);
    if (!pool) {
      const reference = resolved.sshHostRef;
      pool = new RemoteHostConnectionPool<TClient>({ ...this.#options.pool, connect: (client) => this.#options.connectClient(client, resolved.host) }, () => {
        const ownsCurrentPool = this.#pools.get(key) === pool;
        if (ownsCurrentPool) this.#pools.delete(key);
        if (pool) this.#allPools.delete(pool);
        if (ownsCurrentPool && reference !== undefined && this.#referencePoolKeys.get(reference) === key) {
          this.#referencePoolKeys.delete(reference);
        }
      });
      this.#pools.set(key, pool);
      this.#allPools.add(pool);
    }
    const lease = await pool.acquire(signal);
    try {
      const stream = await this.#options.execGateway(lease.client);
      return this.#options.createConnection(stream, lease.release);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  #prepareProviderConnection(provided: TProvided): TConnection {
    let connection: TConnection | undefined;
    let committed = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (committed && connection) this.#providerConnections.delete(connection);
      this.#options.closeProvided(provided);
    };

    try {
      if (this.#closed) throw new SshTransportError("transport", "SSH connection factory is closed");
      connection = this.#options.createConnection(this.#options.providedStream(provided), release);
      if (connection.status === "disconnected") {
        throw new SshTransportError("transport", "Remote gateway disconnected before connection handoff");
      }
      this.#providerConnections.add(connection);
      committed = true;
      return connection;
    } catch (error) {
      release();
      if (error instanceof SshTransportError) throw error;
      throw new SshTransportError("transport", "Provider remote gateway connection setup failed");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const providerConnections = [...this.#providerConnections];
    this.#providerConnections.clear();
    for (const pool of [...this.#allPools]) pool.close();
    this.#pools.clear();
    this.#allPools.clear();
    this.#referencePoolKeys.clear();
    await Promise.allSettled(providerConnections.map((connection) => connection.close()));
  }
}
