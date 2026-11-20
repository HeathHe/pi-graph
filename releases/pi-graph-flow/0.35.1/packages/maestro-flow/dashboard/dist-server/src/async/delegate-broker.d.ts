export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
    [key: string]: JsonValue;
}
export type DelegateJobStatus = 'queued' | 'running' | 'input_required' | 'completed' | 'failed' | 'cancelled' | (string & {});
export interface DelegateSessionRecord {
    sessionId: string;
    channelId?: string;
    metadata?: JsonObject;
    registeredAt: string;
    lastSeenAt: string;
}
export interface DelegateJobRecord {
    jobId: string;
    status: DelegateJobStatus;
    createdAt: string;
    updatedAt: string;
    lastEventId: number;
    lastEventType: string;
    latestSnapshot: JsonObject | null;
    metadata?: JsonObject;
}
export interface DelegateJobEvent {
    eventId: number;
    sequence: number;
    jobId: string;
    type: string;
    createdAt: string;
    status?: DelegateJobStatus;
    snapshot?: JsonObject;
    payload: JsonObject;
    metadata?: JsonObject;
}
export interface RegisterSessionInput {
    sessionId: string;
    channelId?: string;
    metadata?: JsonObject;
    now?: string;
}
export interface HeartbeatInput {
    sessionId: string;
    now?: string;
}
export interface PublishJobEventInput {
    jobId: string;
    type: string;
    payload?: JsonObject;
    status?: DelegateJobStatus;
    snapshot?: JsonObject;
    jobMetadata?: JsonObject;
    now?: string;
}
export interface PollEventsInput {
    sessionId: string;
    jobId?: string;
    limit?: number;
    afterEventId?: number;
    now?: string;
}
export interface AckEventsInput {
    sessionId: string;
    eventIds: number[];
    now?: string;
}
export interface RequestCancelInput {
    jobId: string;
    requestedBy?: string;
    reason?: string;
    now?: string;
}
export type DelegateMessageDelivery = 'inject' | 'after_complete';
export type DelegateMessageStatus = 'queued' | 'dispatched' | 'dropped' | 'injected';
export interface DelegateQueuedMessage {
    messageId: string;
    createdAt: string;
    delivery: DelegateMessageDelivery;
    message: string;
    status: DelegateMessageStatus;
    requestedBy?: string;
    dispatchedAt?: string;
    dispatchReason?: string;
}
export interface QueueMessageInput {
    jobId: string;
    message: string;
    delivery: DelegateMessageDelivery;
    requestedBy?: string;
    now?: string;
}
export interface UpdateMessageInput {
    jobId: string;
    messageId: string;
    status: DelegateMessageStatus;
    dispatchReason?: string;
    now?: string;
}
export interface CheckTimeoutsInput {
    timeoutMs?: number;
    now?: string;
}
export interface PurgeExpiredEventsInput {
    /** Max age in milliseconds. Events for terminal jobs older than this are removed. Defaults to 2 hours. */
    maxAgeMs?: number;
    now?: string;
}
export interface PurgeExpiredEventsResult {
    purgedEventCount: number;
    purgedJobCount: number;
    purgedSessionCount: number;
}
export interface DelegateBrokerApi {
    registerSession(input: RegisterSessionInput): DelegateSessionRecord;
    heartbeat(input: HeartbeatInput): DelegateSessionRecord;
    publishEvent(input: PublishJobEventInput): DelegateJobEvent;
    pollEvents(input: PollEventsInput): DelegateJobEvent[];
    ack(input: AckEventsInput): number;
    getJob(jobId: string): DelegateJobRecord | null;
    listJobEvents(jobId: string): DelegateJobEvent[];
    requestCancel(input: RequestCancelInput): DelegateJobRecord;
    queueMessage(input: QueueMessageInput): DelegateQueuedMessage;
    listMessages(jobId: string): DelegateQueuedMessage[];
    updateMessage(input: UpdateMessageInput): DelegateQueuedMessage | null;
    checkTimeouts(input?: CheckTimeoutsInput): DelegateJobRecord[];
    purgeExpiredEvents(input?: PurgeExpiredEventsInput): PurgeExpiredEventsResult;
}
export interface FileDelegateBrokerOptions {
    statePath?: string;
    dbPath?: string;
    preferSqlite?: boolean;
}
export declare function defaultDelegateBrokerDbPath(): string;
export declare class FileDelegateBroker implements DelegateBrokerApi {
    private readonly statePath;
    constructor(options?: FileDelegateBrokerOptions);
    registerSession(input: RegisterSessionInput): DelegateSessionRecord;
    heartbeat(input: HeartbeatInput): DelegateSessionRecord;
    publishEvent(input: PublishJobEventInput): DelegateJobEvent;
    pollEvents(input: PollEventsInput): DelegateJobEvent[];
    ack(input: AckEventsInput): number;
    getJob(jobId: string): DelegateJobRecord | null;
    listJobEvents(jobId: string): DelegateJobEvent[];
    requestCancel(input: RequestCancelInput): DelegateJobRecord;
    queueMessage(input: QueueMessageInput): DelegateQueuedMessage;
    listMessages(jobId: string): DelegateQueuedMessage[];
    updateMessage(input: UpdateMessageInput): DelegateQueuedMessage | null;
    checkTimeouts(input?: CheckTimeoutsInput): DelegateJobRecord[];
    purgeExpiredEvents(input?: PurgeExpiredEventsInput): PurgeExpiredEventsResult;
    private updateState;
    private readState;
    private writeState;
}
export declare class SqliteDelegateBroker implements DelegateBrokerApi {
    private readonly dbPath;
    private readonly db;
    constructor(options?: FileDelegateBrokerOptions);
    registerSession(input: RegisterSessionInput): DelegateSessionRecord;
    heartbeat(input: HeartbeatInput): DelegateSessionRecord;
    publishEvent(input: PublishJobEventInput): DelegateJobEvent;
    pollEvents(input: PollEventsInput): DelegateJobEvent[];
    ack(input: AckEventsInput): number;
    getJob(jobId: string): DelegateJobRecord | null;
    listJobEvents(jobId: string): DelegateJobEvent[];
    requestCancel(input: RequestCancelInput): DelegateJobRecord;
    queueMessage(input: QueueMessageInput): DelegateQueuedMessage;
    listMessages(jobId: string): DelegateQueuedMessage[];
    updateMessage(input: UpdateMessageInput): DelegateQueuedMessage | null;
    checkTimeouts(input?: CheckTimeoutsInput): DelegateJobRecord[];
    purgeExpiredEvents(input?: PurgeExpiredEventsInput): PurgeExpiredEventsResult;
    close(): void;
    private initialize;
    private transaction;
    private getSessionRow;
    private getJobRow;
    private sessionFromRow;
    private jobFromRow;
    private eventFromRow;
}
export declare function createDefaultDelegateBroker(options?: FileDelegateBrokerOptions): DelegateBrokerApi;
