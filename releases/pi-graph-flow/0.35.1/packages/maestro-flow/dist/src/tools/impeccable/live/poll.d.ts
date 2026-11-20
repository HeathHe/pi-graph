export interface PollOpts {
    timeout?: string;
    reply?: string;
    status?: string;
    message?: string;
}
interface ReplyPayload {
    token: string;
    id: string;
    type: string;
    message?: string;
    file?: string;
    data?: Record<string, unknown>;
}
export declare function buildPollReplyPayload(token: string, reply: {
    id: string;
    type: string;
    message?: string;
    file?: string;
    data?: Record<string, unknown>;
}): ReplyPayload;
export declare function pollCli(opts?: PollOpts): Promise<void>;
export {};
//# sourceMappingURL=poll.d.ts.map