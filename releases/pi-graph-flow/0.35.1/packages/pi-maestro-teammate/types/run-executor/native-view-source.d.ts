import { type NativeCurrentReadCapability, type NativeCurrentView } from "./native-current-view.ts";
import type { NativeExecutionSnapshot } from "./native-observation.ts";
export declare const NATIVE_VIEW_INVALIDATED = "pi-graph-next:native-view-invalidated/1";
export interface NativeViewDescriptor {
    readonly mode: "legacy" | "v2";
    readonly correlationId: string;
    readonly projectionKey: string;
    readonly entityKey?: string;
    readonly streamKey?: string;
    readonly cursor?: number;
}
export interface NativeViewRow {
    readonly ownerId: string;
    readonly correlationId: string;
    readonly agent: string;
    readonly view: NativeCurrentView;
}
export interface NativePendingView {
    /** Observer registration time, not CPU runtime or business start evidence. */
    readonly observedSince: number;
    readonly ownerId: string;
    readonly agent: string;
    readonly snapshot: NativeExecutionSnapshot;
    readonly detached: boolean;
    readonly retained: boolean;
}
export interface NativeSourceSnapshot {
    readonly revision: number;
    readonly pending: readonly NativePendingView[];
}
export interface NativeViewSource {
    readonly namespace: "pi-graph-next:native-source/1";
}
interface Manager {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(): readonly {
        id: string;
    }[];
}
interface Scope {
    readonly manager: Manager;
    readonly sessionId: string;
    readonly cwd: string;
}
/** Query descriptor only: hashes confer no authority, and are computed at parse/publication boundaries. */
export declare function nativeViewDescriptorOfEntity(entity: {
    correlationId: string;
    projection?: unknown;
}, source: {
    streamId: string;
    generation: number;
}, cursor?: number): NativeViewDescriptor;
export declare function nativeLegacyViewDescriptor(correlationId: string, projection: unknown): NativeViewDescriptor;
export declare function lookupNativeViewSource(scope: Scope): NativeViewSource | undefined;
export declare function readNativeView(source: unknown, descriptor: NativeViewDescriptor): NativeViewRow | undefined;
export declare function readNativeSource(source: unknown): NativeSourceSnapshot | undefined;
/** Root-only composition; not exported by the public facade. */
export declare function createNativeViewSource(scope: Scope, validHost: () => boolean, invalidate: () => void): {
    source: NativeViewSource;
    captureHost(): object;
    register(input: {
        object: object;
        correlationId: string;
        agent: string;
        generation: number | null;
        capability: NativeCurrentReadCapability;
        current: () => boolean;
        retained?: () => boolean;
        anchor: string | null;
        hostTicket: object;
    }): object | undefined;
    capture(object: object): object | undefined;
    confirm(receipt: object | undefined, descriptor: NativeViewDescriptor, ordinal?: number): void;
    reusePublished(descriptor: NativeViewDescriptor): void;
    reconcile(): void;
    navigate(): void;
    dispose: () => void;
};
export {};
