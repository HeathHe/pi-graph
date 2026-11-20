import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../config/paths.js';
const require = createRequire(import.meta.url);
const DEFAULT_BROKER_STATE_PATH = join(paths.data, 'async', 'delegate-broker.json');
const DEFAULT_BROKER_DB_PATH = join(paths.data, 'async', 'delegate-broker.sqlite');
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_PURGE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
function createEmptyState() {
    return {
        version: 1,
        nextEventId: 1,
        sessions: {},
        jobs: {},
        eventsByJob: {},
    };
}
function inferStatus(type, explicitStatus, currentStatus) {
    if (explicitStatus) {
        return explicitStatus;
    }
    switch (type) {
        case 'queued':
            return 'queued';
        case 'input_required':
            return 'input_required';
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        default:
            return currentStatus ?? 'running';
    }
}
function ensureDirectoryFor(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}
function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stripStoredEvent(event) {
    const { ackedBy: _ackedBy, ...publicEvent } = event;
    return publicEvent;
}
function mergeJsonObjects(base, patch) {
    if (!base && !patch) {
        return undefined;
    }
    if (!base) {
        return patch ? { ...patch } : undefined;
    }
    if (!patch) {
        return { ...base };
    }
    return { ...base, ...patch };
}
function isTerminalStatus(status) {
    return status !== undefined && TERMINAL_STATUSES.has(status);
}
function buildCancelMetadata(existing, input, now) {
    return {
        ...(existing ?? {}),
        cancelRequestedAt: now,
        ...(input.requestedBy ? { cancelRequestedBy: input.requestedBy } : {}),
        ...(input.reason ? { cancelReason: input.reason } : {}),
    };
}
function buildCancelPayload(input) {
    return {
        summary: input.reason ? `Cancellation requested: ${input.reason}` : 'Cancellation requested',
        ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
    };
}
/** Accept current + legacy delivery values for backward-compat deserialization */
function isLegacyDelivery(value) {
    return value === 'inject' || value === 'after_complete'
        || value === 'streaming' || value === 'interrupt_resume';
}
/** Normalize legacy delivery values to current type */
function normalizeDelivery(value) {
    if (value === 'streaming' || value === 'interrupt_resume')
        return 'inject';
    return value;
}
function isDelegateMessageStatus(value) {
    return value === 'queued' || value === 'dispatched' || value === 'dropped' || value === 'injected';
}
function readQueuedMessages(metadata) {
    const raw = metadata?.queuedMessages;
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .filter((value) => isJsonObject(value))
        .map((value) => {
        const messageId = typeof value.messageId === 'string' ? value.messageId : '';
        const createdAt = typeof value.createdAt === 'string' ? value.createdAt : '';
        const delivery = isLegacyDelivery(value.delivery) ? normalizeDelivery(value.delivery) : null;
        const message = typeof value.message === 'string' ? value.message : '';
        const status = isDelegateMessageStatus(value.status) ? value.status : null;
        if (!messageId || !createdAt || !delivery || !message || !status) {
            return null;
        }
        return {
            messageId,
            createdAt,
            delivery,
            message,
            status,
            ...(typeof value.requestedBy === 'string' ? { requestedBy: value.requestedBy } : {}),
            ...(typeof value.dispatchedAt === 'string' ? { dispatchedAt: value.dispatchedAt } : {}),
            ...(typeof value.dispatchReason === 'string' ? { dispatchReason: value.dispatchReason } : {}),
        };
    })
        .filter((value) => value !== null);
}
function writeQueuedMessages(metadata, messages) {
    const next = { ...(metadata ?? {}) };
    if (messages.length === 0) {
        delete next.queuedMessages;
    }
    else {
        next.queuedMessages = messages.map((message) => ({
            messageId: message.messageId,
            createdAt: message.createdAt,
            delivery: message.delivery,
            message: message.message,
            status: message.status,
            ...(message.requestedBy ? { requestedBy: message.requestedBy } : {}),
            ...(message.dispatchedAt ? { dispatchedAt: message.dispatchedAt } : {}),
            ...(message.dispatchReason ? { dispatchReason: message.dispatchReason } : {}),
        }));
    }
    return Object.keys(next).length > 0 ? next : undefined;
}
function readJsonObject(raw) {
    if (!raw) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        return isJsonObject(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function writeJson(value) {
    if (!value) {
        return null;
    }
    return JSON.stringify(value);
}
function requireSqlite() {
    return require('node:sqlite');
}
function sqliteAvailable() {
    try {
        requireSqlite();
        return true;
    }
    catch {
        return false;
    }
}
export function defaultDelegateBrokerDbPath() {
    return DEFAULT_BROKER_DB_PATH;
}
export class FileDelegateBroker {
    statePath;
    constructor(options = {}) {
        this.statePath = options.statePath ?? DEFAULT_BROKER_STATE_PATH;
        ensureDirectoryFor(this.statePath);
        if (!existsSync(this.statePath)) {
            this.writeState(createEmptyState());
        }
    }
    registerSession(input) {
        const now = input.now ?? new Date().toISOString();
        return this.updateState((state) => {
            const existing = state.sessions[input.sessionId];
            const nextSession = {
                sessionId: input.sessionId,
                channelId: input.channelId ?? existing?.channelId,
                metadata: mergeJsonObjects(existing?.metadata, input.metadata),
                registeredAt: existing?.registeredAt ?? now,
                lastSeenAt: now,
            };
            state.sessions[input.sessionId] = nextSession;
            return nextSession;
        });
    }
    heartbeat(input) {
        const now = input.now ?? new Date().toISOString();
        return this.updateState((state) => {
            const session = state.sessions[input.sessionId];
            if (!session) {
                throw new Error(`Unknown delegate session: ${input.sessionId}`);
            }
            const nextSession = {
                ...session,
                lastSeenAt: now,
            };
            state.sessions[input.sessionId] = nextSession;
            return nextSession;
        });
    }
    publishEvent(input) {
        const now = input.now ?? new Date().toISOString();
        return this.updateState((state) => {
            const existingJob = state.jobs[input.jobId];
            const events = state.eventsByJob[input.jobId] ?? [];
            const eventId = state.nextEventId++;
            const snapshot = input.snapshot ?? (isJsonObject(input.payload?.snapshot) ? input.payload.snapshot : undefined);
            const metadata = mergeJsonObjects(existingJob?.metadata, input.jobMetadata);
            const event = {
                eventId,
                sequence: events.length + 1,
                jobId: input.jobId,
                type: input.type,
                createdAt: now,
                status: input.status,
                snapshot,
                payload: input.payload ?? {},
                metadata,
                ackedBy: {},
            };
            events.push(event);
            state.eventsByJob[input.jobId] = events;
            state.jobs[input.jobId] = {
                jobId: input.jobId,
                status: inferStatus(input.type, input.status, existingJob?.status),
                createdAt: existingJob?.createdAt ?? now,
                updatedAt: now,
                lastEventId: eventId,
                lastEventType: input.type,
                latestSnapshot: snapshot ?? existingJob?.latestSnapshot ?? null,
                metadata,
            };
            return stripStoredEvent(event);
        });
    }
    pollEvents(input) {
        const now = input.now ?? new Date().toISOString();
        const limit = Math.max(1, input.limit ?? 100);
        return this.updateState((state) => {
            const session = state.sessions[input.sessionId];
            if (!session) {
                throw new Error(`Unknown delegate session: ${input.sessionId}`);
            }
            state.sessions[input.sessionId] = {
                ...session,
                lastSeenAt: now,
            };
            const jobIds = input.jobId ? [input.jobId] : Object.keys(state.eventsByJob);
            return jobIds
                .flatMap((jobId) => state.eventsByJob[jobId] ?? [])
                .filter((event) => !event.ackedBy[input.sessionId])
                .filter((event) => input.afterEventId === undefined || event.eventId > input.afterEventId)
                .sort((left, right) => left.eventId - right.eventId)
                .slice(0, limit)
                .map(stripStoredEvent);
        });
    }
    ack(input) {
        const now = input.now ?? new Date().toISOString();
        const eventIds = new Set(input.eventIds);
        return this.updateState((state) => {
            const session = state.sessions[input.sessionId];
            if (!session) {
                throw new Error(`Unknown delegate session: ${input.sessionId}`);
            }
            state.sessions[input.sessionId] = {
                ...session,
                lastSeenAt: now,
            };
            let ackedCount = 0;
            for (const events of Object.values(state.eventsByJob)) {
                for (const event of events) {
                    if (!eventIds.has(event.eventId) || event.ackedBy[input.sessionId]) {
                        continue;
                    }
                    event.ackedBy[input.sessionId] = now;
                    ackedCount += 1;
                }
            }
            return ackedCount;
        });
    }
    getJob(jobId) {
        const state = this.readState();
        return state.jobs[jobId] ?? null;
    }
    listJobEvents(jobId) {
        const state = this.readState();
        return (state.eventsByJob[jobId] ?? []).map(stripStoredEvent);
    }
    requestCancel(input) {
        const now = input.now ?? new Date().toISOString();
        return this.updateState((state) => {
            const existingJob = state.jobs[input.jobId];
            if (existingJob && (isTerminalStatus(existingJob.status) || existingJob.metadata?.cancelRequestedAt)) {
                return existingJob;
            }
            const metadata = buildCancelMetadata(existingJob?.metadata, input, now);
            const events = state.eventsByJob[input.jobId] ?? [];
            const eventId = state.nextEventId++;
            const status = existingJob?.status ?? 'queued';
            const event = {
                eventId,
                sequence: events.length + 1,
                jobId: input.jobId,
                type: 'cancel_requested',
                createdAt: now,
                status,
                snapshot: existingJob?.latestSnapshot ?? undefined,
                payload: buildCancelPayload(input),
                metadata,
                ackedBy: {},
            };
            events.push(event);
            state.eventsByJob[input.jobId] = events;
            const job = {
                jobId: input.jobId,
                status,
                createdAt: existingJob?.createdAt ?? now,
                updatedAt: now,
                lastEventId: eventId,
                lastEventType: 'cancel_requested',
                latestSnapshot: existingJob?.latestSnapshot ?? null,
                metadata,
            };
            state.jobs[input.jobId] = job;
            return job;
        });
    }
    queueMessage(input) {
        const now = input.now ?? new Date().toISOString();
        return this.updateState((state) => {
            const existingJob = state.jobs[input.jobId];
            if (!existingJob) {
                throw new Error(`Unknown delegate job: ${input.jobId}`);
            }
            const queuedMessages = readQueuedMessages(existingJob.metadata);
            const queuedMessage = {
                messageId: `msg-${state.nextEventId}`,
                createdAt: now,
                delivery: input.delivery,
                message: input.message,
                status: 'queued',
                ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
            };
            const metadata = writeQueuedMessages(existingJob.metadata, [...queuedMessages, queuedMessage]);
            const events = state.eventsByJob[input.jobId] ?? [];
            const eventId = state.nextEventId++;
            const event = {
                eventId,
                sequence: events.length + 1,
                jobId: input.jobId,
                type: 'message_queued',
                createdAt: now,
                status: existingJob.status,
                snapshot: existingJob.latestSnapshot ?? undefined,
                payload: {
                    summary: `Queued ${input.delivery} follow-up message`,
                    delivery: input.delivery,
                    messageId: queuedMessage.messageId,
                },
                metadata,
                ackedBy: {},
            };
            events.push(event);
            state.eventsByJob[input.jobId] = events;
            state.jobs[input.jobId] = {
                ...existingJob,
                updatedAt: now,
                lastEventId: eventId,
                lastEventType: 'message_queued',
                metadata,
            };
            return queuedMessage;
        });
    }
    listMessages(jobId) {
        return readQueuedMessages(this.getJob(jobId)?.metadata);
    }
    updateMessage(input) {
        const now = input.now ?? new Date().toISOString();
        return this.updateState((state) => {
            const existingJob = state.jobs[input.jobId];
            if (!existingJob) {
                return null;
            }
            const queuedMessages = readQueuedMessages(existingJob.metadata);
            const index = queuedMessages.findIndex((message) => message.messageId === input.messageId);
            if (index === -1) {
                return null;
            }
            const updatedMessage = {
                ...queuedMessages[index],
                status: input.status,
                ...(input.status === 'dispatched' ? { dispatchedAt: now } : {}),
                ...(input.dispatchReason ? { dispatchReason: input.dispatchReason } : {}),
            };
            queuedMessages[index] = updatedMessage;
            const metadata = writeQueuedMessages(existingJob.metadata, queuedMessages);
            const events = state.eventsByJob[input.jobId] ?? [];
            const eventId = state.nextEventId++;
            const eventType = input.status === 'dispatched'
                ? 'message_dispatched'
                : input.status === 'injected'
                    ? 'message_injected'
                    : 'message_dropped';
            const event = {
                eventId,
                sequence: events.length + 1,
                jobId: input.jobId,
                type: eventType,
                createdAt: now,
                status: existingJob.status,
                snapshot: existingJob.latestSnapshot ?? undefined,
                payload: {
                    summary: input.status === 'dispatched'
                        ? `Dispatched ${updatedMessage.delivery} follow-up message`
                        : input.status === 'injected'
                            ? `Injected ${updatedMessage.delivery} follow-up message`
                            : `Dropped ${updatedMessage.delivery} follow-up message`,
                    delivery: updatedMessage.delivery,
                    messageId: updatedMessage.messageId,
                    ...(input.dispatchReason ? { reason: input.dispatchReason } : {}),
                },
                metadata,
                ackedBy: {},
            };
            events.push(event);
            state.eventsByJob[input.jobId] = events;
            state.jobs[input.jobId] = {
                ...existingJob,
                updatedAt: now,
                lastEventId: eventId,
                lastEventType: eventType,
                metadata,
            };
            return updatedMessage;
        });
    }
    checkTimeouts(input) {
        const timeoutMs = input?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const now = input?.now ?? new Date().toISOString();
        const nowMs = new Date(now).getTime();
        return this.updateState((state) => {
            const timedOut = [];
            for (const job of Object.values(state.jobs)) {
                if (isTerminalStatus(job.status)) {
                    continue;
                }
                const createdMs = new Date(job.createdAt).getTime();
                if (nowMs - createdMs < timeoutMs) {
                    continue;
                }
                const events = state.eventsByJob[job.jobId] ?? [];
                const eventId = state.nextEventId++;
                const event = {
                    eventId,
                    sequence: events.length + 1,
                    jobId: job.jobId,
                    type: 'failed',
                    createdAt: now,
                    status: 'failed',
                    snapshot: job.latestSnapshot ?? undefined,
                    payload: { summary: 'Timed out', reason: 'timeout' },
                    metadata: job.metadata,
                    ackedBy: {},
                };
                events.push(event);
                state.eventsByJob[job.jobId] = events;
                const updatedJob = {
                    ...job,
                    status: 'failed',
                    updatedAt: now,
                    lastEventId: eventId,
                    lastEventType: 'failed',
                };
                state.jobs[job.jobId] = updatedJob;
                timedOut.push(updatedJob);
            }
            return timedOut;
        });
    }
    purgeExpiredEvents(input) {
        const maxAgeMs = input?.maxAgeMs ?? DEFAULT_PURGE_MAX_AGE_MS;
        const now = input?.now ?? new Date().toISOString();
        const nowMs = new Date(now).getTime();
        const cutoff = nowMs - maxAgeMs;
        return this.updateState((state) => {
            let purgedEventCount = 0;
            let purgedJobCount = 0;
            let purgedSessionCount = 0;
            // Purge events and jobs for terminal jobs older than cutoff
            for (const [jobId, job] of Object.entries(state.jobs)) {
                if (!isTerminalStatus(job.status)) {
                    continue;
                }
                if (new Date(job.updatedAt).getTime() > cutoff) {
                    continue;
                }
                const events = state.eventsByJob[jobId];
                purgedEventCount += events?.length ?? 0;
                delete state.eventsByJob[jobId];
                delete state.jobs[jobId];
                purgedJobCount += 1;
            }
            // Purge stale sessions not seen since cutoff
            for (const [sessionId, session] of Object.entries(state.sessions)) {
                if (new Date(session.lastSeenAt).getTime() > cutoff) {
                    continue;
                }
                delete state.sessions[sessionId];
                purgedSessionCount += 1;
            }
            return { purgedEventCount, purgedJobCount, purgedSessionCount };
        });
    }
    updateState(updater) {
        const state = this.readState();
        const result = updater(state);
        this.writeState(state);
        return result;
    }
    readState() {
        try {
            const raw = readFileSync(this.statePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.version === 1) {
                return parsed;
            }
        }
        catch {
            // fall through
        }
        return createEmptyState();
    }
    writeState(state) {
        ensureDirectoryFor(this.statePath);
        const tmpPath = `${this.statePath}.${process.pid}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
        renameSync(tmpPath, this.statePath);
    }
}
export class SqliteDelegateBroker {
    dbPath;
    db;
    constructor(options = {}) {
        this.dbPath = options.dbPath ?? DEFAULT_BROKER_DB_PATH;
        ensureDirectoryFor(this.dbPath);
        const { DatabaseSync } = requireSqlite();
        this.db = new DatabaseSync(this.dbPath);
        this.initialize();
    }
    registerSession(input) {
        const now = input.now ?? new Date().toISOString();
        return this.transaction(() => {
            const existing = this.getSessionRow(input.sessionId);
            const metadata = mergeJsonObjects(readJsonObject(existing?.metadata), input.metadata);
            this.db.prepare(`
        INSERT INTO delegate_sessions (session_id, channel_id, metadata, registered_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          metadata = excluded.metadata,
          last_seen_at = excluded.last_seen_at
      `).run(input.sessionId, input.channelId ?? existing?.channel_id ?? null, writeJson(metadata), existing?.registered_at ?? now, now);
            return {
                sessionId: input.sessionId,
                channelId: input.channelId ?? existing?.channel_id ?? undefined,
                metadata,
                registeredAt: existing?.registered_at ?? now,
                lastSeenAt: now,
            };
        });
    }
    heartbeat(input) {
        const now = input.now ?? new Date().toISOString();
        return this.transaction(() => {
            const existing = this.getSessionRow(input.sessionId);
            if (!existing) {
                throw new Error(`Unknown delegate session: ${input.sessionId}`);
            }
            this.db.prepare('UPDATE delegate_sessions SET last_seen_at = ? WHERE session_id = ?').run(now, input.sessionId);
            return this.sessionFromRow({ ...existing, last_seen_at: now });
        });
    }
    publishEvent(input) {
        const now = input.now ?? new Date().toISOString();
        return this.transaction(() => {
            const existingJob = this.getJob(input.jobId);
            const metadata = mergeJsonObjects(existingJob?.metadata, input.jobMetadata);
            const snapshot = input.snapshot ?? (isJsonObject(input.payload?.snapshot) ? input.payload.snapshot : undefined);
            const sequenceRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM delegate_events WHERE job_id = ?').get(input.jobId);
            const sequence = Number(sequenceRow?.value ?? 0) + 1;
            const eventResult = this.db.prepare(`
        INSERT INTO delegate_events (sequence, job_id, type, created_at, status, snapshot, payload, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sequence, input.jobId, input.type, now, input.status ?? null, writeJson(snapshot), JSON.stringify(input.payload ?? {}), writeJson(metadata));
            const eventId = Number(eventResult.lastInsertRowid ?? 0);
            const status = inferStatus(input.type, input.status, existingJob?.status);
            this.db.prepare(`
        INSERT INTO delegate_jobs (job_id, status, created_at, updated_at, last_event_id, last_event_type, latest_snapshot, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          last_event_id = excluded.last_event_id,
          last_event_type = excluded.last_event_type,
          latest_snapshot = excluded.latest_snapshot,
          metadata = excluded.metadata
      `).run(input.jobId, status, existingJob?.createdAt ?? now, now, eventId, input.type, writeJson(snapshot ?? existingJob?.latestSnapshot ?? null), writeJson(metadata));
            return {
                eventId,
                sequence,
                jobId: input.jobId,
                type: input.type,
                createdAt: now,
                status: input.status,
                snapshot,
                payload: input.payload ?? {},
                metadata,
            };
        });
    }
    pollEvents(input) {
        const now = input.now ?? new Date().toISOString();
        const limit = Math.max(1, input.limit ?? 100);
        return this.transaction(() => {
            const session = this.getSessionRow(input.sessionId);
            if (!session) {
                throw new Error(`Unknown delegate session: ${input.sessionId}`);
            }
            this.db.prepare('UPDATE delegate_sessions SET last_seen_at = ? WHERE session_id = ?').run(now, input.sessionId);
            const params = [input.sessionId];
            let where = 'a.event_id IS NULL';
            if (input.jobId) {
                where += ' AND e.job_id = ?';
                params.push(input.jobId);
            }
            if (input.afterEventId !== undefined) {
                where += ' AND e.event_id > ?';
                params.push(input.afterEventId);
            }
            params.push(limit);
            const rows = this.db.prepare(`
        SELECT
          e.event_id,
          e.sequence,
          e.job_id,
          e.type,
          e.created_at,
          e.status,
          e.snapshot,
          e.payload,
          e.metadata
        FROM delegate_events e
        LEFT JOIN delegate_event_acks a
          ON a.event_id = e.event_id AND a.session_id = ?
        WHERE ${where}
        ORDER BY e.event_id ASC
        LIMIT ?
      `).all(...params);
            return rows.map((row) => this.eventFromRow(row));
        });
    }
    ack(input) {
        const now = input.now ?? new Date().toISOString();
        if (input.eventIds.length === 0) {
            return 0;
        }
        return this.transaction(() => {
            const session = this.getSessionRow(input.sessionId);
            if (!session) {
                throw new Error(`Unknown delegate session: ${input.sessionId}`);
            }
            this.db.prepare('UPDATE delegate_sessions SET last_seen_at = ? WHERE session_id = ?').run(now, input.sessionId);
            const statement = this.db.prepare(`
        INSERT OR IGNORE INTO delegate_event_acks (session_id, event_id, acked_at)
        VALUES (?, ?, ?)
      `);
            let acked = 0;
            for (const eventId of input.eventIds) {
                const result = statement.run(input.sessionId, eventId, now);
                if (Number(result.lastInsertRowid ?? 0) > 0) {
                    acked += 1;
                }
                else {
                    const exists = this.db.prepare(`
            SELECT 1 AS value FROM delegate_event_acks WHERE session_id = ? AND event_id = ?
          `).get(input.sessionId, eventId);
                    if (exists) {
                        continue;
                    }
                }
            }
            return acked;
        });
    }
    getJob(jobId) {
        const row = this.getJobRow(jobId);
        return row ? this.jobFromRow(row) : null;
    }
    listJobEvents(jobId) {
        const rows = this.db.prepare(`
      SELECT event_id, sequence, job_id, type, created_at, status, snapshot, payload, metadata
      FROM delegate_events
      WHERE job_id = ?
      ORDER BY event_id ASC
    `).all(jobId);
        return rows.map((row) => this.eventFromRow(row));
    }
    requestCancel(input) {
        const now = input.now ?? new Date().toISOString();
        return this.transaction(() => {
            const existingJob = this.getJob(input.jobId);
            if (existingJob && (isTerminalStatus(existingJob.status) || existingJob.metadata?.cancelRequestedAt)) {
                return existingJob;
            }
            const metadata = buildCancelMetadata(existingJob?.metadata, input, now);
            const sequenceRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM delegate_events WHERE job_id = ?').get(input.jobId);
            const sequence = Number(sequenceRow?.value ?? 0) + 1;
            const status = existingJob?.status ?? 'queued';
            const eventResult = this.db.prepare(`
        INSERT INTO delegate_events (sequence, job_id, type, created_at, status, snapshot, payload, metadata)
        VALUES (?, ?, 'cancel_requested', ?, ?, ?, ?, ?)
      `).run(sequence, input.jobId, now, status, writeJson(existingJob?.latestSnapshot ?? null), JSON.stringify(buildCancelPayload(input)), writeJson(metadata));
            const eventId = Number(eventResult.lastInsertRowid ?? 0);
            this.db.prepare(`
        INSERT INTO delegate_jobs (job_id, status, created_at, updated_at, last_event_id, last_event_type, latest_snapshot, metadata)
        VALUES (?, ?, ?, ?, ?, 'cancel_requested', ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          last_event_id = excluded.last_event_id,
          last_event_type = excluded.last_event_type,
          latest_snapshot = excluded.latest_snapshot,
          metadata = excluded.metadata
      `).run(input.jobId, status, existingJob?.createdAt ?? now, now, eventId, writeJson(existingJob?.latestSnapshot ?? null), writeJson(metadata));
            const updated = this.getJob(input.jobId);
            if (!updated) {
                throw new Error(`Failed to request cancellation for: ${input.jobId}`);
            }
            return updated;
        });
    }
    queueMessage(input) {
        const now = input.now ?? new Date().toISOString();
        return this.transaction(() => {
            const existingJob = this.getJob(input.jobId);
            if (!existingJob) {
                throw new Error(`Unknown delegate job: ${input.jobId}`);
            }
            const queuedMessages = readQueuedMessages(existingJob.metadata);
            const queuedMessage = {
                messageId: `msg-${existingJob.lastEventId + 1}`,
                createdAt: now,
                delivery: input.delivery,
                message: input.message,
                status: 'queued',
                ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
            };
            const metadata = writeQueuedMessages(existingJob.metadata, [...queuedMessages, queuedMessage]);
            const sequenceRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM delegate_events WHERE job_id = ?').get(input.jobId);
            const sequence = Number(sequenceRow?.value ?? 0) + 1;
            const eventResult = this.db.prepare(`
        INSERT INTO delegate_events (sequence, job_id, type, created_at, status, snapshot, payload, metadata)
        VALUES (?, ?, 'message_queued', ?, ?, ?, ?, ?)
      `).run(sequence, input.jobId, now, existingJob.status, writeJson(existingJob.latestSnapshot ?? null), JSON.stringify({
                summary: `Queued ${input.delivery} follow-up message`,
                delivery: input.delivery,
                messageId: queuedMessage.messageId,
            }), writeJson(metadata));
            const eventId = Number(eventResult.lastInsertRowid ?? 0);
            this.db.prepare(`
        UPDATE delegate_jobs
        SET updated_at = ?, last_event_id = ?, last_event_type = 'message_queued', metadata = ?
        WHERE job_id = ?
      `).run(now, eventId, writeJson(metadata), input.jobId);
            return queuedMessage;
        });
    }
    listMessages(jobId) {
        return readQueuedMessages(this.getJob(jobId)?.metadata);
    }
    updateMessage(input) {
        const now = input.now ?? new Date().toISOString();
        return this.transaction(() => {
            const existingJob = this.getJob(input.jobId);
            if (!existingJob) {
                return null;
            }
            const queuedMessages = readQueuedMessages(existingJob.metadata);
            const index = queuedMessages.findIndex((message) => message.messageId === input.messageId);
            if (index === -1) {
                return null;
            }
            const updatedMessage = {
                ...queuedMessages[index],
                status: input.status,
                ...(input.status === 'dispatched' ? { dispatchedAt: now } : {}),
                ...(input.dispatchReason ? { dispatchReason: input.dispatchReason } : {}),
            };
            queuedMessages[index] = updatedMessage;
            const metadata = writeQueuedMessages(existingJob.metadata, queuedMessages);
            const sequenceRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM delegate_events WHERE job_id = ?').get(input.jobId);
            const sequence = Number(sequenceRow?.value ?? 0) + 1;
            const eventType = input.status === 'dispatched' ? 'message_dispatched' : input.status === 'injected' ? 'message_injected' : 'message_dropped';
            const eventResult = this.db.prepare(`
        INSERT INTO delegate_events (sequence, job_id, type, created_at, status, snapshot, payload, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sequence, input.jobId, eventType, now, existingJob.status, writeJson(existingJob.latestSnapshot ?? null), JSON.stringify({
                summary: input.status === 'dispatched'
                    ? `Dispatched ${updatedMessage.delivery} follow-up message`
                    : input.status === 'injected'
                        ? `Injected ${updatedMessage.delivery} follow-up message`
                        : `Dropped ${updatedMessage.delivery} follow-up message`,
                delivery: updatedMessage.delivery,
                messageId: updatedMessage.messageId,
                ...(input.dispatchReason ? { reason: input.dispatchReason } : {}),
            }), writeJson(metadata));
            const eventId = Number(eventResult.lastInsertRowid ?? 0);
            this.db.prepare(`
        UPDATE delegate_jobs
        SET updated_at = ?, last_event_id = ?, last_event_type = ?, metadata = ?
        WHERE job_id = ?
      `).run(now, eventId, eventType, writeJson(metadata), input.jobId);
            return updatedMessage;
        });
    }
    checkTimeouts(input) {
        const timeoutMs = input?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const now = input?.now ?? new Date().toISOString();
        const nowMs = new Date(now).getTime();
        return this.transaction(() => {
            const rows = this.db.prepare(`
        SELECT job_id, status, created_at, updated_at, last_event_id, last_event_type, latest_snapshot, metadata
        FROM delegate_jobs
        WHERE status NOT IN ('completed', 'failed', 'cancelled')
      `).all();
            const timedOut = [];
            for (const row of rows) {
                const createdMs = new Date(row.created_at).getTime();
                if (nowMs - createdMs < timeoutMs) {
                    continue;
                }
                const metadata = readJsonObject(row.metadata);
                const snapshot = readJsonObject(row.latest_snapshot);
                const sequenceRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM delegate_events WHERE job_id = ?').get(row.job_id);
                const sequence = Number(sequenceRow?.value ?? 0) + 1;
                const eventResult = this.db.prepare(`
          INSERT INTO delegate_events (sequence, job_id, type, created_at, status, snapshot, payload, metadata)
          VALUES (?, ?, 'failed', ?, 'failed', ?, ?, ?)
        `).run(sequence, row.job_id, now, writeJson(snapshot), JSON.stringify({ summary: 'Timed out', reason: 'timeout' }), writeJson(metadata));
                const eventId = Number(eventResult.lastInsertRowid ?? 0);
                this.db.prepare(`
          UPDATE delegate_jobs
          SET status = 'failed', updated_at = ?, last_event_id = ?, last_event_type = 'failed'
          WHERE job_id = ?
        `).run(now, eventId, row.job_id);
                timedOut.push({
                    jobId: row.job_id,
                    status: 'failed',
                    createdAt: row.created_at,
                    updatedAt: now,
                    lastEventId: eventId,
                    lastEventType: 'failed',
                    latestSnapshot: snapshot ?? null,
                    metadata,
                });
            }
            return timedOut;
        });
    }
    purgeExpiredEvents(input) {
        const maxAgeMs = input?.maxAgeMs ?? DEFAULT_PURGE_MAX_AGE_MS;
        const now = input?.now ?? new Date().toISOString();
        const nowMs = new Date(now).getTime();
        const cutoffIso = new Date(nowMs - maxAgeMs).toISOString();
        return this.transaction(() => {
            // Find terminal jobs older than cutoff
            const expiredJobs = this.db.prepare(`
        SELECT job_id FROM delegate_jobs
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND updated_at <= ?
      `).all(cutoffIso);
            let purgedEventCount = 0;
            for (const { job_id } of expiredJobs) {
                const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM delegate_events WHERE job_id = ?').get(job_id);
                purgedEventCount += Number(countRow?.cnt ?? 0);
                this.db.prepare(`
          DELETE FROM delegate_event_acks
          WHERE event_id IN (SELECT event_id FROM delegate_events WHERE job_id = ?)
        `).run(job_id);
                this.db.prepare('DELETE FROM delegate_events WHERE job_id = ?').run(job_id);
                this.db.prepare('DELETE FROM delegate_jobs WHERE job_id = ?').run(job_id);
            }
            // Purge stale sessions
            const sessionCountRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM delegate_sessions WHERE last_seen_at <= ?').get(cutoffIso);
            const purgedSessionCount = Number(sessionCountRow?.cnt ?? 0);
            this.db.prepare('DELETE FROM delegate_sessions WHERE last_seen_at <= ?').run(cutoffIso);
            return {
                purgedEventCount,
                purgedJobCount: expiredJobs.length,
                purgedSessionCount,
            };
        });
    }
    close() {
        this.db.close();
    }
    initialize() {
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS delegate_sessions (
        session_id TEXT PRIMARY KEY,
        channel_id TEXT,
        metadata TEXT,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS delegate_jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_id INTEGER NOT NULL,
        last_event_type TEXT NOT NULL,
        latest_snapshot TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS delegate_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT,
        snapshot TEXT,
        payload TEXT NOT NULL,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS delegate_event_acks (
        session_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        acked_at TEXT NOT NULL,
        PRIMARY KEY (session_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_delegate_events_job_id ON delegate_events(job_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_delegate_events_event_id ON delegate_events(event_id);
    `);
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    getSessionRow(sessionId) {
        const row = this.db.prepare(`
      SELECT session_id, channel_id, metadata, registered_at, last_seen_at
      FROM delegate_sessions
      WHERE session_id = ?
    `).get(sessionId);
        return row ?? null;
    }
    getJobRow(jobId) {
        const row = this.db.prepare(`
      SELECT job_id, status, created_at, updated_at, last_event_id, last_event_type, latest_snapshot, metadata
      FROM delegate_jobs
      WHERE job_id = ?
    `).get(jobId);
        return row ?? null;
    }
    sessionFromRow(row) {
        return {
            sessionId: row.session_id,
            channelId: row.channel_id ?? undefined,
            metadata: readJsonObject(row.metadata),
            registeredAt: row.registered_at,
            lastSeenAt: row.last_seen_at,
        };
    }
    jobFromRow(row) {
        return {
            jobId: row.job_id,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastEventId: Number(row.last_event_id),
            lastEventType: row.last_event_type,
            latestSnapshot: readJsonObject(row.latest_snapshot) ?? null,
            metadata: readJsonObject(row.metadata),
        };
    }
    eventFromRow(row) {
        const payload = readJsonObject(row.payload) ?? {};
        return {
            eventId: Number(row.event_id),
            sequence: Number(row.sequence),
            jobId: row.job_id,
            type: row.type,
            createdAt: row.created_at,
            status: row.status ? row.status : undefined,
            snapshot: readJsonObject(row.snapshot),
            payload,
            metadata: readJsonObject(row.metadata),
        };
    }
}
export function createDefaultDelegateBroker(options = {}) {
    const preferSqlite = options.preferSqlite ?? !options.statePath;
    if (preferSqlite && sqliteAvailable()) {
        return new SqliteDelegateBroker(options);
    }
    return new FileDelegateBroker(options);
}
//# sourceMappingURL=delegate-broker.js.map