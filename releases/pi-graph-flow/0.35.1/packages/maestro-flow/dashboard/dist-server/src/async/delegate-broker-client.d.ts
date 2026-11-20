import type { AckEventsInput, CheckTimeoutsInput, DelegateBrokerApi, DelegateJobEvent, DelegateJobRecord, DelegateSessionRecord, FileDelegateBrokerOptions, HeartbeatInput, PollEventsInput, PublishJobEventInput, PurgeExpiredEventsInput, PurgeExpiredEventsResult, QueueMessageInput, RequestCancelInput, RegisterSessionInput, UpdateMessageInput, DelegateQueuedMessage } from './delegate-broker.js';
export interface DelegateBrokerClientOptions extends FileDelegateBrokerOptions {
    broker?: DelegateBrokerApi;
}
export declare class DelegateBrokerClient implements DelegateBrokerApi {
    private readonly broker;
    constructor(options?: DelegateBrokerClientOptions);
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
