interface TapEntry<F> {
    name: string;
    fn: F;
}
export declare class SyncHook<T extends unknown[] = []> {
    readonly handlers: TapEntry<(...args: T) => void>[];
    tap(name: string, fn: (...args: T) => void): void;
    call(...args: T): void;
}
export declare class AsyncSeriesHook<T extends unknown[] = []> {
    readonly handlers: TapEntry<(...args: T) => void | Promise<void>>[];
    tap(name: string, fn: (...args: T) => void | Promise<void>): void;
    call(...args: T): Promise<void>;
}
export declare class AsyncSeriesBailHook<T extends unknown[] = []> {
    readonly handlers: TapEntry<(...args: T) => unknown | Promise<unknown>>[];
    tap(name: string, fn: (...args: T) => unknown | Promise<unknown>): void;
    call(...args: T): Promise<unknown | undefined>;
}
export declare class AsyncSeriesWaterfallHook<T = unknown> {
    readonly handlers: TapEntry<(value: T) => T | Promise<T>>[];
    tap(name: string, fn: (value: T) => T | Promise<T>): void;
    call(initial: T): Promise<T>;
}
export {};
