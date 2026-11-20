// ---------------------------------------------------------------------------
// Hook Engine — Lightweight tapable-inspired hook system
// 4 hook types: SyncHook, AsyncSeriesHook, AsyncSeriesBailHook,
// AsyncSeriesWaterfallHook. Zero external dependencies.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SyncHook — call() iterates handlers synchronously, returns void
// ---------------------------------------------------------------------------
export class SyncHook {
    handlers = [];
    tap(name, fn) {
        this.handlers.push({ name, fn });
    }
    call(...args) {
        for (const h of this.handlers) {
            h.fn(...args);
        }
    }
}
// ---------------------------------------------------------------------------
// AsyncSeriesHook — call() awaits each handler in registration order
// ---------------------------------------------------------------------------
export class AsyncSeriesHook {
    handlers = [];
    tap(name, fn) {
        this.handlers.push({ name, fn });
    }
    async call(...args) {
        for (const h of this.handlers) {
            await h.fn(...args);
        }
    }
}
// ---------------------------------------------------------------------------
// AsyncSeriesBailHook — returns early if a handler returns non-undefined
// ---------------------------------------------------------------------------
export class AsyncSeriesBailHook {
    handlers = [];
    tap(name, fn) {
        this.handlers.push({ name, fn });
    }
    async call(...args) {
        for (const h of this.handlers) {
            const result = await h.fn(...args);
            if (result !== undefined)
                return result;
        }
        return undefined;
    }
}
// ---------------------------------------------------------------------------
// AsyncSeriesWaterfallHook — passes return value through chain
// ---------------------------------------------------------------------------
export class AsyncSeriesWaterfallHook {
    handlers = [];
    tap(name, fn) {
        this.handlers.push({ name, fn });
    }
    async call(initial) {
        let current = initial;
        for (const h of this.handlers) {
            current = await h.fn(current);
        }
        return current;
    }
}
//# sourceMappingURL=hook-engine.js.map