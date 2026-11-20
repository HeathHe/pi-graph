// ---------------------------------------------------------------------------
// RoomMailbox — in-memory message store with atomic readUnread
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
export class RoomMailbox {
    messages = new Map();
    /** Write a message into the session mailbox. Returns the generated message. */
    write(sessionId, from, to, content, priority = 'normal') {
        const msg = {
            id: randomUUID(),
            sessionId,
            from,
            to,
            content,
            priority,
            read: false,
            createdAt: new Date().toISOString(),
        };
        let list = this.messages.get(sessionId);
        if (!list) {
            list = [];
            this.messages.set(sessionId, list);
        }
        list.push(msg);
        return msg;
    }
    /**
     * Atomically read all unread messages for an agent in a session.
     * Marks returned messages as read so subsequent calls won't return them again.
     * Pass `to = '*'` to read broadcast messages only.
     */
    readUnread(sessionId, agentRole) {
        const list = this.messages.get(sessionId);
        if (!list)
            return [];
        const unread = [];
        for (const msg of list) {
            if (msg.read)
                continue;
            if (msg.to === agentRole || msg.to === '*') {
                msg.read = true;
                unread.push(msg);
            }
        }
        return unread;
    }
    /** Get full message history for a session */
    getHistory(sessionId) {
        return this.messages.get(sessionId) ?? [];
    }
    /** Get message history filtered to a specific agent (sent or received) */
    getHistoryForAgent(sessionId, agentRole) {
        const list = this.messages.get(sessionId);
        if (!list)
            return [];
        return list.filter((msg) => msg.from === agentRole || msg.to === agentRole || msg.to === '*');
    }
    /** Clear all messages for a session */
    clear(sessionId) {
        this.messages.delete(sessionId);
    }
}
//# sourceMappingURL=room-mailbox.js.map