import { readFile, stat } from "node:fs/promises";
import { appendDurable, atomicWriteJson } from "./durable.ts";
import { canonicalJson } from "./digests.ts";
import type { V3ShadowEvent } from "./types.ts";

export const V3_EVENT_MAX_BYTES = 16 * 1024;
export const V3_EVENT_MAX_COUNT = 10_000;
export const V3_EVENT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export type V3EventTruncationReason = "event-too-large" | "event-count-limit" | "event-bytes-limit";

export interface V3EventTruncationRecord {
	schemaVersion: 1;
	unverified: true;
	at: string;
	reason: V3EventTruncationReason;
	acceptedEvents: number;
	acceptedBytes: number;
}

export type V3EventHealth = "healthy" | "truncated" | "capacity-limit" | "unknown";

export interface V3EventLogDiagnostics {
	health: V3EventHealth;
	events: number;
	bytes: number;
	truncated?: V3EventTruncationRecord;
}

const TRUNCATION_FIELDS = new Set(["schemaVersion", "unverified", "at", "reason", "acceptedEvents", "acceptedBytes"]);

export function validateV3EventTruncationRecord(value: unknown): V3EventTruncationRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const field of Object.keys(record)) {
		if (!TRUNCATION_FIELDS.has(field)) return undefined;
	}
	if (record.schemaVersion !== 1 || record.unverified !== true) return undefined;
	if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) return undefined;
	if (typeof record.reason !== "string" || !["event-too-large", "event-count-limit", "event-bytes-limit"].includes(record.reason)) return undefined;
	if (typeof record.acceptedEvents !== "number" || !Number.isInteger(record.acceptedEvents) || record.acceptedEvents < 0) return undefined;
	if (typeof record.acceptedBytes !== "number" || !Number.isInteger(record.acceptedBytes) || record.acceptedBytes < 0) return undefined;
	return record as unknown as V3EventTruncationRecord;
}

interface EventFileState {
	events: number;
	bytes: number;
}

async function readEventFileState(path: string): Promise<EventFileState | undefined> {
	try {
		const fileStat = await stat(path);
		if (!fileStat.isFile()) return undefined;
		const contents = await readFile(path, "utf8");
		let events = 0;
		if (contents.length > 0 && !contents.endsWith("\n")) return undefined;
		for (const line of contents.split("\n")) {
			if (line.length === 0) continue;
			if (!isValidEventLine(line)) return undefined;
			events += 1;
		}
		return { events, bytes: Buffer.byteLength(contents, "utf8") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

function isValidEventLine(line: string): boolean {
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		return typeof value === "object" && value !== null && value.schemaVersion === 1 && value.unverified === true;
	} catch {
		return false;
	}
}

export class V3EventWriter {
	private readonly eventsPath: string;
	private readonly truncatedPath: string;
	private state: EventFileState = { events: 0, bytes: 0 };
	private latched: V3EventTruncationReason | undefined;
	private initialized = false;
	private writeInFlight: Promise<boolean> = Promise.resolve(true);

	constructor(eventsPath: string, truncatedPath: string) {
		this.eventsPath = eventsPath;
		this.truncatedPath = truncatedPath;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		try {
			const truncatedRaw = await readFile(this.truncatedPath, "utf8").catch(() => undefined);
			if (truncatedRaw !== undefined) {
				const record = validateV3EventTruncationRecord(JSON.parse(truncatedRaw));
				if (record) {
					this.latched = record.reason;
					this.state = { events: record.acceptedEvents, bytes: record.acceptedBytes };
					return;
				}
			}
		} catch {
			// An unreadable sidecar must not break the event log; fall through to mechanical recount.
		}
		const fileState = await readEventFileState(this.eventsPath);
		if (fileState) this.state = fileState;
	}

	async append(event: Omit<V3ShadowEvent, "schemaVersion" | "unverified" | "seq">): Promise<boolean> {
		await this.initialize();
		if (this.latched) return false;
		const write: Promise<boolean> = this.writeInFlight.then(async () => {
			if (this.latched) return false;
			const line = canonicalJson({ schemaVersion: 1, unverified: true, seq: this.state.events + 1, ...event });
			const lineBytes = Buffer.byteLength(line, "utf8") + 1;
			let reason: V3EventTruncationReason | undefined;
			if (lineBytes > V3_EVENT_MAX_BYTES) reason = "event-too-large";
			else if (this.state.events >= V3_EVENT_MAX_COUNT) reason = "event-count-limit";
			else if (this.state.bytes + lineBytes > V3_EVENT_MAX_TOTAL_BYTES) reason = "event-bytes-limit";
			if (reason) {
				await this.writeTruncationSidecar(reason);
				return false;
			}
			await appendDurable(this.eventsPath, `${line}\n`);
			this.state = { events: this.state.events + 1, bytes: this.state.bytes + lineBytes };
			return true;
		});
		this.writeInFlight = write.catch(() => false);
		return write;
	}

	private async writeTruncationSidecar(reason: V3EventTruncationReason): Promise<void> {
		this.latched = reason;
		const record: V3EventTruncationRecord = {
			schemaVersion: 1,
			unverified: true,
			at: new Date().toISOString(),
			reason,
			acceptedEvents: this.state.events,
			acceptedBytes: this.state.bytes,
		};
		try {
			await atomicWriteJson(this.truncatedPath, record);
		} catch {
			// Sidecar creation must never fail the Graph.
		}
	}

	async diagnostics(): Promise<V3EventLogDiagnostics> {
		await this.initialize();
		if (this.latched) {
			return { health: "truncated", events: this.state.events, bytes: this.state.bytes, truncated: { schemaVersion: 1, unverified: true, at: new Date().toISOString(), reason: this.latched, acceptedEvents: this.state.events, acceptedBytes: this.state.bytes } };
		}
		const fileState = await readEventFileState(this.eventsPath);
		if (!fileState) return { health: "unknown", events: this.state.events, bytes: this.state.bytes };
		if (fileState.events >= V3_EVENT_MAX_COUNT || fileState.bytes >= V3_EVENT_MAX_TOTAL_BYTES) {
			return { health: "capacity-limit", events: fileState.events, bytes: fileState.bytes };
		}
		return { health: "healthy", events: fileState.events, bytes: fileState.bytes };
	}
}
