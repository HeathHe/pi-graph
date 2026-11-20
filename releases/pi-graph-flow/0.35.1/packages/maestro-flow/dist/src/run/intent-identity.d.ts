import { type IntentIdentity } from './protocol-schemas.js';
/**
 * Normalize intent text for exact identity only. This intentionally preserves
 * punctuation, emoji, combining marks after NFKC, and the full string length.
 * It must never be reused as a filesystem slug.
 */
export declare function normalizeIntent(value: string): string;
export declare function canonicalWorkspaceId(projectRoot: string): string;
export declare function canonicalCommandIdentity(command: string): string;
export interface CreateIntentIdentityOptions {
    source?: IntentIdentity['source'];
    backfillStatus?: IntentIdentity['backfill_status'];
}
export declare function createIntentIdentity(projectRoot: string, command: string, intent: string, options?: CreateIntentIdentityOptions): IntentIdentity;
export declare function sameIntentIdentity(left: IntentIdentity, right: IntentIdentity): boolean;
export { intentIdentitySchema, type IntentIdentity } from './protocol-schemas.js';
//# sourceMappingURL=intent-identity.d.ts.map