import type { TeammateBackend } from "./protocol/backend.ts";
import type { BackendRegistry, BackendRegistryConfig, ResolvedBackend } from "./protocol/registry.ts";
import type { TeammateRunSpec } from "./protocol/spec.ts";
import { BackendConfigurationError, readBackendFailureEvidence, resolveBackendConfig, snapshotConfig } from "./config.ts";
import { exactBackendCapabilities } from "./capabilities.ts";

export type BackendLoader = (module: string) => Promise<unknown>;

interface RegistrationSnapshot {
  readonly module: string;
  readonly config: ReturnType<typeof snapshotConfig>;
}

function asBackend<TPlacement>(loaded: unknown): TeammateBackend<TPlacement> | undefined {
  const candidate = (loaded as { default?: unknown } | null)?.default ?? loaded;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const shape = candidate as Partial<TeammateBackend<TPlacement>>;
  return typeof shape.name === "string" && typeof shape.start === "function"
    && typeof shape.capabilities === "function" ? candidate as TeammateBackend<TPlacement> : undefined;
}

/** One immutable dispatch generation; only the host supplies module loading. */
export class TeammateBackendRegistry<TPlacement = unknown> implements BackendRegistry<TPlacement> {
  private readonly registrations = new Map<string, RegistrationSnapshot>();
  private readonly loaded = new Map<string, Promise<ResolvedBackend<TPlacement>>>();
  private readonly defaultName: string;
  private readonly load: BackendLoader;

  constructor(config: BackendRegistryConfig, load: BackendLoader) {
    if (typeof load !== "function") throw new BackendConfigurationError("Backend loader is required");
    this.load = load;
    if (!config || typeof config.default !== "string" || !config.backends
        || typeof config.backends !== "object" || Array.isArray(config.backends)) {
      throw new BackendConfigurationError("Invalid backend registry document");
    }
    this.defaultName = config.default;
    for (const name of Object.keys(config.backends)) {
      const registration = config.backends[name];
      if (!registration || typeof registration !== "object" || typeof registration.module !== "string") {
        throw new BackendConfigurationError(`teammate backend "${name}" has an invalid registration`);
      }
      this.registrations.set(name, Object.freeze({
        module: registration.module,
        config: snapshotConfig(registration.config ?? {}),
      }));
    }
    if (!this.registrations.has(this.defaultName)) {
      throw new BackendConfigurationError(`teammate backend registry names "${this.defaultName}" as its default, but no such backend is registered`);
    }
  }

  listBackendNames(): string[] {
    return [...this.registrations.keys()];
  }

  defaultBackendName(): string {
    return this.defaultName;
  }

  private registered(name: string): Promise<ResolvedBackend<TPlacement>> {
    const memoized = this.loaded.get(name);
    if (memoized !== undefined) return memoized;
    const registration = this.registrations.get(name);
    if (registration === undefined) {
      return Promise.reject(new BackendConfigurationError(`teammate backend "${name}" is not registered`));
    }
    // The entry is installed before any user loader or resolver can re-enter.
    const entry = Promise.resolve().then(async (): Promise<ResolvedBackend<TPlacement>> => {
      let loaded: unknown;
      try {
        loaded = await this.load(registration.module);
      } catch (cause) {
        throw new BackendConfigurationError(`teammate backend "${name}" could not be loaded`, cause);
      }
      let backend: TeammateBackend<TPlacement> | undefined;
      let protocolVersion: unknown;
      try {
        backend = asBackend<TPlacement>(loaded);
        protocolVersion = backend?.protocolVersion;
      } catch (cause) {
        throw new BackendConfigurationError(`teammate backend "${name}" export inspection failed`, cause);
      }
      if (backend === undefined) {
        throw new BackendConfigurationError(`teammate backend "${name}" exports no valid backend`);
      }
      if (protocolVersion !== 1) {
        throw new BackendConfigurationError(`teammate backend "${name}" has an unsupported protocol version`);
      }
      const resolved = resolveBackendConfig(backend, registration.config);
      if (resolved.errors.length > 0) {
        throw new BackendConfigurationError(
          `teammate backend "${name}" is misconfigured: ${resolved.errors.join("; ")}`,
          readBackendFailureEvidence(resolved),
        );
      }
      let capabilities: ReturnType<typeof exactBackendCapabilities>;
      try {
        capabilities = exactBackendCapabilities(backend.capabilities(resolved.values));
      } catch (cause) {
        throw new BackendConfigurationError(`teammate backend "${name}" capability evaluation failed`, cause);
      }
      if (capabilities === undefined) {
        throw new BackendConfigurationError(`teammate backend "${name}" must expose exactly nine valid capabilities`);
      }
      return Object.freeze({ backend, config: resolved.values, capabilities });
    });
    const guarded = entry.catch(cause => {
      if (this.loaded.get(name) === guarded) this.loaded.delete(name);
      throw cause;
    });
    this.loaded.set(name, guarded);
    return guarded;
  }

  async resolve(spec: TeammateRunSpec<TPlacement>, requestedBackend?: string): Promise<ResolvedBackend<TPlacement>> {
    return this.registered(requestedBackend ?? spec.backend ?? this.defaultName);
  }

  async capabilitiesOf(backendName: string) {
    return (await this.registered(backendName)).capabilities;
  }
}
