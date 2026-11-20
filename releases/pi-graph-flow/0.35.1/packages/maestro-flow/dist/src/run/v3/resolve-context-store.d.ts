import { SessionStore } from '../store.js';
import { type ResolveSessionContextResult } from './resolve-context.js';
export interface ResolveSessionContextStoreOptions {
    explicit_session_id?: string;
    env?: Readonly<Record<string, string | undefined>>;
}
/** Resolve v3 Session authority without consulting legacy projections or file timestamps. */
export declare function resolveSessionContextFromStore(store: SessionStore, options?: ResolveSessionContextStoreOptions): ResolveSessionContextResult;
//# sourceMappingURL=resolve-context-store.d.ts.map