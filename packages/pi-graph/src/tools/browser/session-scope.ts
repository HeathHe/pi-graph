import { BrowserManager, type BrowserManagerLike } from "./manager.ts";

/** Host context only: never accept a scope/session selector from browser params. */
export interface BrowserSessionContext {
  sessionManager?: { getSessionId?: () => string | undefined };
}

export function browserHostSessionId(ctx: BrowserSessionContext): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    // Pi invalidates live context getters after replacement/reload.
    return undefined;
  }
}

export interface BrowserSessionScope {
  readonly manager: BrowserManagerLike;
  readonly isolationKey: string;
  sopRead: boolean;
  closing: boolean;
  cleanup?: Promise<number>;
}

/** One named-tab registry per trusted host session, shared across tool/turn instances. */
export class BrowserSessionScopes {
  readonly #scopes = new Map<string, BrowserSessionScope>();

  constructor(private readonly createManager: () => BrowserManagerLike = () => new BrowserManager()) {}

  forSession(sessionId: string | undefined): BrowserSessionScope {
    if (!sessionId?.trim()) throw new Error("Browser operations require a trusted host session identity. Only guide is available without it.");
    let scope = this.#scopes.get(sessionId);
    if (scope?.closing) throw new Error("This browser session scope is shutting down; wait for cleanup before reopening.");
    if (!scope) {
      scope = {
        manager: this.createManager(),
        isolationKey: JSON.stringify(["host-session", sessionId]),
        sopRead: false,
        closing: false,
      };
      this.#scopes.set(sessionId, scope);
    }
    return scope;
  }

  closeSession(sessionId: string | undefined): Promise<number> {
    // Missing identity must never fall back to process-wide browser closeAll.
    if (!sessionId) return Promise.resolve(0);
    const scope = this.#scopes.get(sessionId);
    if (!scope) return Promise.resolve(0);
    if (scope.cleanup) return scope.cleanup;
    scope.closing = true; // Fence admission synchronously, before the first await.
    const cleanup = Promise.resolve().then(() => scope.manager.closeAll()).then((count) => {
      if (this.#scopes.get(sessionId) === scope) this.#scopes.delete(sessionId);
      return count;
    });
    scope.cleanup = cleanup;
    // Failed cleanup retains ownership and blocks replacement; a later shutdown
    // may retry, but it must not silently abandon resources that are still live.
    void cleanup.catch(() => { if (scope.cleanup === cleanup) scope.cleanup = undefined; });
    return cleanup;
  }
}

export const browserSessionScopes = new BrowserSessionScopes();
