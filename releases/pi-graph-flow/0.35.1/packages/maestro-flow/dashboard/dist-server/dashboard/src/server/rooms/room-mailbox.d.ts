import type { RoomMailboxMessage, MessagePriority } from './room-types.js';
export declare class RoomMailbox {
    private readonly messages;
    /** Write a message into the session mailbox. Returns the generated message. */
    write(sessionId: string, from: string, to: string, content: string, priority?: MessagePriority): RoomMailboxMessage;
    /**
     * Atomically read all unread messages for an agent in a session.
     * Marks returned messages as read so subsequent calls won't return them again.
     * Pass `to = '*'` to read broadcast messages only.
     */
    readUnread(sessionId: string, agentRole: string): RoomMailboxMessage[];
    /** Get full message history for a session */
    getHistory(sessionId: string): RoomMailboxMessage[];
    /** Get message history filtered to a specific agent (sent or received) */
    getHistoryForAgent(sessionId: string, agentRole: string): RoomMailboxMessage[];
    /** Clear all messages for a session */
    clear(sessionId: string): void;
}
