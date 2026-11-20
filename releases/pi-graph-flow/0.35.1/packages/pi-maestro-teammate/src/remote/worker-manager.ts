import { randomUUID } from "node:crypto";
import { resolveRemoteTarget, type RemoteConfig } from "./config.ts";
import type { RemoteConnectionFactory } from "./driver.ts";
import type { ResolvedRemoteTarget } from "./types.ts";
import { RemoteWorkerManager as CoreRemoteWorkerManager } from "pi-graph-provider-backend/remote";
import type { RemoteWorkerManagerOptions as CoreOptions } from "pi-graph-provider-backend/remote";
export { REMOTE_MANAGER_MAX_OWNED_RUNS, REMOTE_MANAGER_MAX_START_COMMANDS, REMOTE_MANAGER_MAX_ORPHAN_EVENTS,
  RemoteOwnershipError, RemoteWorkerQuotaError, RemoteWorkerDisconnectedError } from "pi-graph-provider-backend/remote";
export type { RemoteWorkerStartRequest, RemoteWorkerAttachRequest, RemoteWorkerWaitOptions, RemoteWorkerView } from "pi-graph-provider-backend/remote";
export interface RemoteWorkerManagerOptions extends Omit<CoreOptions<ResolvedRemoteTarget>, "resolveTarget" | "timers" | "monitorOwnerNonce" | "commandIdFactory" | "connectionFactory"> {
  config: RemoteConfig; connectionFactory: RemoteConnectionFactory;
  monitorOwnerNonce?: string; commandIdFactory?: () => string;
}
/** Compatibility constructor: configuration/UUID/timers stay on the original Host. */
export class RemoteWorkerManager extends CoreRemoteWorkerManager<ResolvedRemoteTarget> {
  constructor(options: RemoteWorkerManagerOptions) {
    super({ ...options, resolveTarget: (targetId) => resolveRemoteTarget(options.config, targetId),
      monitorOwnerNonce: options.monitorOwnerNonce ?? randomUUID(),
      commandIdFactory: options.commandIdFactory ?? (() => randomUUID()),
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout) },
    });
  }
}
