export declare const TOPIC_IDENTITY_SCHEMA_VERSION: "topic-identity/1.0";
export declare const TOPIC_NORMALIZATION: "NFKC+unicode-lower+whitespace-collapse/1";
export type TopicIdentitySource = 'explicit' | 'workflow' | 'legacy-intent';
export interface TopicIdentity {
    schema_version: typeof TOPIC_IDENTITY_SCHEMA_VERSION;
    normalization: typeof TOPIC_NORMALIZATION;
    workspace_id: string;
    source: TopicIdentitySource;
    verbatim: string;
    normalized: string;
    normalized_length: number;
    normalized_hash: string;
    identity_hash: string;
    revision: 1;
}
/**
 * Normalize a user-supplied topic without deriving identity from a command.
 * Punctuation, emoji, and the full normalized text remain identity-significant.
 */
export declare function normalizeTopic(value: string): string;
/**
 * Produce the same opaque workspace scope for equivalent absolute paths.
 * The path itself is intentionally not persisted in the identity.
 */
export declare function canonicalTopicWorkspaceId(workspaceRoot: string): string;
/**
 * Create an identity from verbatim topic text and workspace scope. Interactive
 * callers must supply an explicit topic; workflow and legacy converters record
 * their provenance through `options.source` rather than deriving from command.
 */
export interface CreateTopicIdentityOptions {
    source?: TopicIdentitySource;
}
export declare function createTopicIdentity(workspaceRoot: string, topic: string, options?: CreateTopicIdentityOptions): TopicIdentity;
export declare function sameTopicIdentity(left: TopicIdentity, right: TopicIdentity): boolean;
