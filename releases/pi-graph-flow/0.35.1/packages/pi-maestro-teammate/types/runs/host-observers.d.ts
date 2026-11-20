/** Host-only, in-process observation of actual local Pi subprocess boundaries.
 * No child-supplied actor ID, copied Todo snapshot, progress/token inference or remote substitute.
 */
export interface TeammateHostBoundary {
    correlationId: string;
    incarnation: string;
    /** Host-monotonic process incarnation; late events from replaced children are older. */
    sequence: number;
    parentSessionFile?: string;
    runtimeGeneration: number;
    event: Readonly<Record<string, unknown>>;
    /** Native steer only. Never wakes an offline runtime or aborts a tool. */
    steer(message: string): boolean;
}
type Observer = (boundary: TeammateHostBoundary) => void;
export { nextTeammateHostSequence } from 'pi-graph-observability/execution';
export declare function registerTeammateHostObserver(owner: string, observer: Observer): () => void;
/** @internal Producer boundary; observers cannot interfere with execution. */
export declare function publishTeammateHostBoundary(boundary: TeammateHostBoundary): void;
