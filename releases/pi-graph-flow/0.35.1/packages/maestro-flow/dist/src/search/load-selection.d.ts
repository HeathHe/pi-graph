import type { WikiEntry } from '#maestro-dashboard/wiki/wiki-types.js';
export declare const LOAD_SELECTION_TYPES: readonly ["spec", "knowhow", "note", "domain", "issue", "project", "roadmap", "session", "scratch"];
export type DaemonLoadType = (typeof LOAD_SELECTION_TYPES)[number];
export interface DaemonLoadSelection {
    type: DaemonLoadType;
    ids?: string[];
    category?: string;
    keyword?: string;
    tag?: string;
    includeDeprecated?: boolean;
    limit: number;
    projection: 'full' | 'metadata';
    applicableRepoId?: string;
    targetRepoId?: string;
    targetAlias?: string;
    originExplicit?: boolean;
}
/** Apply the exact load ordering/filtering before response serialization. */
export declare function applyDaemonLoadSelection(source: WikiEntry[], selection: DaemonLoadSelection): WikiEntry[];
//# sourceMappingURL=load-selection.d.ts.map