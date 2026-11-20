import {readableUsageFile,sessionIndexEntry,inventoryUsage,deleteUsagePreview,selectBackfillRecords,UsageHistoryOwner,usageSessionBasename,planSessionMigration,extractSessionUsage,mergeUsageRecords,toLegacyUsageRecord,aggregateByModel as coreByModel,aggregateByTurn as coreByTurn,usageTotals as coreTotals,aggregateByTimeBucket as coreByTime,daySeries as coreDays} from 'pi-graph-observability/usage';
import type {UsageHistoryTransaction,UsageHistoryPort,UsageRecordV1} from 'pi-graph-observability/usage';
/**
 * Token usage history — append-only JSONL store with per-session isolation.
 *
 * Every finalized assistant message is recorded with its model, provider,
 * session id, token counts, and the cost pi-ai already computed
 * (`usage.cost.total`). Records append to `~/.pi/usage-history/<sessionId>.jsonl`;
 * a lightweight `index.json` tracks session metadata for fast listing.
 *
 * All writes are best-effort: a failed append must never break the agent turn.
 * Reads are explicit (called from the stats panel), so the hot path stays
 * cheap — the footer sparkline keeps an in-memory buffer and never reads here.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, appendFile, lstat, readFile, rename, readdir, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
	acquirePrivateStateLock,
	defaultProcessIdentity,
	type PrivateStateLock,
	type ProcessIdentity,
 type ProcessLiveness,
} from "../gateway/private-state-transaction.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageRecord {
	/** Unix timestamp (ms) of the finalized assistant message. */
	ts: number;
	/** Model id as reported by the provider. */
	model: string;
	/** Provider id. */
	provider: string;
	/** Owning session id (partition key). */
	sessionId: string;
	/** Working directory when the message was recorded (workspace filter key). */
	cwd: string;
	/** Raw token counts from the message. */
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	/** Cost in USD (pi-ai computes this from model cost rates). */
	cost: {
		total: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface SessionIndexEntry {
	sessionId: string;
	firstTs: number;
	lastTs: number;
	recordCount: number;
	totalCost: number;
	modelCount: number;
}

export interface SessionIndex {
	sessions: SessionIndexEntry[];
}

export type ReadScope =
	| { kind: "session"; sessionId: string }
	| { kind: "workspace"; cwd: string }
	| { kind: "all" };

export interface ReadOptions {
	/** Only records with ts >= since (ms). */
	since?: number;
	/** Maximum number of records to return (most recent first). */
	limit?: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function usageHistoryDir(): string {
	return join(getAgentDir(), "usage-history");
}

function fullDigest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Canonical filenames retain the complete SHA-256 digest of the session id. */
export function usageSessionFile(sessionId: string): string {
	return join(usageHistoryDir(), usageSessionBasename(sessionId));
}

function indexPath(): string {
	return join(usageHistoryDir(), "index.json");
}

const STORE_LOCK_NAME = ".usage-history-store.lock";
const STORE_LOCK_DURABILITY = {
	async syncFile(_path: string): Promise<void> {},
	async syncDirectory(_path: string): Promise<void> {},
};
let currentProcessIdentity: Promise<string | null> | undefined;

const resolveUsageHistoryProcessIdentity: ProcessIdentity = async (pid, platform) => {
	if (pid !== process.pid || platform !== process.platform) return defaultProcessIdentity(pid, platform);
	const pending = currentProcessIdentity ??= defaultProcessIdentity(pid, platform);
	const identity = await pending;
	if (!identity && currentProcessIdentity === pending) currentProcessIdentity = undefined;
	return identity;
};

export interface UsageHistoryHostIdentity {processIdentity?:ProcessIdentity;processLiveness?:ProcessLiveness;pid?:number}
async function withUsageHistoryLock<T>(operation: (lock: PrivateStateLock) => Promise<T>,host:UsageHistoryHostIdentity={}): Promise<T> {
	const directory = usageHistoryDir();
	await mkdir(directory, { recursive: true,mode:0o700 });
	const lock = await acquirePrivateStateLock({
		directory,
		name: STORE_LOCK_NAME,
		processIdentity: host.processIdentity??resolveUsageHistoryProcessIdentity,
  processLiveness:host.processLiveness,pid:host.pid,
		enforcePrivate: async () => {},
		durability: STORE_LOCK_DURABILITY,
	});
	try {
		await lock.assertOwned();
		const result = await operation(lock);
		await lock.assertOwned();
		return result;
	} finally {
		await lock.release();
	}
}

async function atomicWrite(path: string, contents: string, lock: PrivateStateLock): Promise<void> {
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, contents, {encoding:"utf8",mode:0o600});
		await lock.assertOwned();
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Recording (write path)
// ---------------------------------------------------------------------------

/**
 * Record one finalized assistant message. Best-effort: errors are swallowed
 * so the agent turn never breaks. The append, migration, and index update use
 * the same resource lock as cleanup; a delayed index write can therefore never
 * recreate an entry after guarded deletion.
 */
export async function recordUsage(message:AssistantMessage,sessionId:string,cwd:string,messageIdentity?:string):Promise<void>{
 const timestamp=typeof message.timestamp==='number'?message.timestamp:Date.now();
 await historyOwner().record({header:{version:1,scope:{sessionId,runtimeGeneration:0,ownerId:'flow-usage',incarnation:'message-history'},source:'assistant-message',eventId:messageIdentity??fullDigest(JSON.stringify([sessionId,timestamp,message.provider,message.model,message.content])),sequence:0,observedAt:timestamp},messageIdentity,model:message.model,provider:message.provider,cwd,usage:message.usage?{input:message.usage.input,output:message.usage.output,cacheRead:message.usage.cacheRead,cacheWrite:message.usage.cacheWrite}:{},cost:message.usage?.cost,contentDigest:fullDigest(JSON.stringify(message.content))});
}

async function readIndex(): Promise<SessionIndex> {
	try {
		const raw = await readFile(indexPath(), "utf8");
		const parsed = JSON.parse(raw) as SessionIndex;
		if (!Array.isArray(parsed.sessions)) return { sessions: [] };
		return parsed;
	} catch {
		return { sessions: [] };
	}
}

function indexEntryFor(sessionId:string,records:readonly UsageRecord[]):SessionIndexEntry|undefined{const entry=sessionIndexEntry(sessionId,records);return entry?{...entry,totalCost:entry.totalCost??Number.NaN}:undefined;}

async function refreshIndexEntryLocked(sessionId: string, lock: PrivateStateLock): Promise<void> {
	const current = await readIndex();
	const records = (await readSessionRecordsLocked(sessionId,lock)).filter((record) => record.sessionId === sessionId);
	const next = indexEntryFor(sessionId, records);
	const index = current.sessions.findIndex((entry) => entry.sessionId === sessionId);
	if (next && index >= 0) current.sessions[index] = next;
	else if (next) current.sessions.push(next);
	else if (index >= 0) current.sessions.splice(index, 1);
	await atomicWrite(indexPath(), `${JSON.stringify(current, null, 2)}\n`, lock);
}

// ---------------------------------------------------------------------------
// Reading (read path)
// ---------------------------------------------------------------------------

export async function readHistory(scope:ReadScope,opts:ReadOptions={}):Promise<UsageRecord[]>{
 try{return (await historyOwner().read(scope,opts)).reverse().map(legacyRecord);}catch{return [];}
}

async function listSessionFiles(): Promise<string[]> {
	const dir = usageHistoryDir();
	if (!existsSync(dir)) return [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl")).map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

async function readSessionRecordsLocked(sessionId:string,lock:PrivateStateLock):Promise<UsageRecord[]>{return (await planSessionMigration(usageTransaction(lock),sessionId)).records.map(legacyRecord);}

async function migrateSessionLocked(sessionId:string,lock:PrivateStateLock):Promise<void>{
 const tx=usageTransaction(lock),plan=await planSessionMigration(tx,sessionId);if(!plan.legacyId)return;
 await tx.assertOwned();await tx.replace(plan.id,plan.records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 // Removal preserves the existing explicit legacy migration policy after fully validated canonical persistence.
 await tx.assertOwned();await tx.remove(plan.legacyId);await refreshIndexEntryLocked(sessionId,lock);
}

export async function readSessionIndex(): Promise<SessionIndex> {
	return readIndex();
}

export interface UsageHistoryInventoryEntry {
	path: string;
	fileName: string;
	id: string;
	revision: string;
	sizeBytes: number;
	modified: Date;
	sessionIds: string[];
	cwds: string[];
	cleanupEligible: boolean;
	protectionReason?: string;
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface UsageLiveSessionProtection {
	/** Session ids reported live by the authoritative workspace session directory. */
	liveSessionIds?: ReadonlySet<string>;
	/** False when no authoritative live-session view could be refreshed. */
	evidenceAvailable?: boolean;
}

function maintenanceEvidence(currentSessionId:string|undefined,liveProtection:UsageLiveSessionProtection={}){return {currentSessionId,evidenceAvailable:liveProtection.evidenceAvailable===true,activeSessions:liveProtection.liveSessionIds??new Set<string>()};}
async function scanUsageFilesLocked(cwd:string,currentSessionId:string|undefined,liveProtection:UsageLiveSessionProtection={},lock:PrivateStateLock):Promise<UsageHistoryInventoryEntry[]>{
 const items=await inventoryUsage(usageTransaction(lock),cwd,maintenanceEvidence(currentSessionId,liveProtection));
 return Promise.all(items.map(async item=>{const path=join(usageHistoryDir(),item.id);const info=await lstat(path);return {path,fileName:item.id,id:`usage:${fullDigest(resolve(path))}`,revision:item.previewRevision,sizeBytes:item.sizeBytes,modified:info.mtime,sessionIds:item.sessionIds,cwds:item.cwds,cleanupEligible:item.cleanupEligible,protectionReason:item.protectionReason};}));
}

/** Inventory usage files, migrating unambiguous legacy files under the store lock. */
export async function inventoryUsageHistory(
	cwd: string,
	currentSessionId?: string,
	liveProtection: UsageLiveSessionProtection = {},
 host:UsageHistoryHostIdentity={},
): Promise<UsageHistoryInventoryEntry[]> {
	return withUsageHistoryLock(async (lock) => {
		const initial = await scanUsageFilesLocked(cwd, currentSessionId, liveProtection, lock);
		for (const entry of initial) {
			if (entry.sessionIds.length !== 1) continue;
			const sessionId = entry.sessionIds[0]!;
			if (resolve(entry.path) !== resolve(usageSessionFile(sessionId))) await migrateSessionLocked(sessionId, lock);
		}
		return scanUsageFilesLocked(cwd, currentSessionId, liveProtection, lock);
	},host);
}

export interface DeleteUsageHistoryRequest {
	cwd: string;
	itemId: string;
	revision: string;
	currentSessionId?: string;
	liveProtection?: UsageLiveSessionProtection;
}

export interface DeleteUsageHistoryResult {
	status: "deleted" | "missing" | "protected" | "stale" | "failed";
	reclaimedBytes?: number;
	message?: string;
}

/** Delete only a still-identical, regular, purely current-workspace usage file. */
export async function guardedDeleteUsageHistory(request:DeleteUsageHistoryRequest,host:UsageHistoryHostIdentity={}):Promise<DeleteUsageHistoryResult>{
 try{return await withUsageHistoryLock(async lock=>{
  const tx=usageTransaction(lock),evidence=maintenanceEvidence(request.currentSessionId,request.liveProtection);
  const entry=(await inventoryUsage(tx,request.cwd,evidence)).find(item=>`usage:${fullDigest(resolve(join(usageHistoryDir(),item.id)))}`===request.itemId);
  if(!entry)return {status:'missing'};
  return deleteUsagePreview(tx,{...entry,previewRevision:request.revision},request.cwd,evidence,sessionId=>refreshIndexEntryLocked(sessionId,lock));
 },host);}catch(error){return {status:'failed',message:error instanceof Error?error.message:String(error)};}
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface ModelAggregate {
	model: string;
	records: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
	cacheHitRate: number;
}

/** Aggregate records by model. Cache hit rate = cacheRead / (input + cacheRead). */
export function aggregateByModel(records:readonly UsageRecord[]):ModelAggregate[]{return coreByModel(records).map(value=>({...legacyTotals(value),model:value.model}));}

/** Per-turn series: one point per record, ordered by timestamp. */
export function aggregateByTurn(records:readonly UsageRecord[],metric:'tokens'|'cost'|'cache'):number[]{return coreByTurn(records,metric).map(value=>value??Number.NaN);}

export interface UsageTotals {
	records: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
	cacheHitRate: number;
}

export function usageTotals(records:readonly UsageRecord[]):UsageTotals{return legacyTotals(coreTotals(records));}

// ---------------------------------------------------------------------------
// Time-bucket aggregation (heatmap + time-series line chart)
// ---------------------------------------------------------------------------

export type TimeMetric = "tokens" | "cost" | "cache";
export type BucketGranularity = "hour" | "day";

export interface TimeBucket {
	/** Bucket start timestamp (ms, UTC midnight for day; UTC hour for hour). */
	ts: number;
	/** Aggregated metric value for this bucket. */
	value: number;
}

export function aggregateByTimeBucket(records:readonly UsageRecord[],metric:TimeMetric,granularity:BucketGranularity):TimeBucket[]{return coreByTime(records,metric,granularity).map(b=>({ts:b.ts,value:b.value??Number.NaN}));}

/**
 * Build a complete day-bucket series spanning [startDay, endDay] inclusive,
 * filling missing days with 0. Used for the monthly heatmap and the
 * "30 days" line-chart range. Both bounds are UTC midnight timestamps.
 */
export function daySeries(records:readonly UsageRecord[],metric:TimeMetric,startDay:number,endDay:number):TimeBucket[]{return coreDays(records,metric,startDay,endDay).map(b=>({ts:b.ts,value:b.value??Number.NaN}));}



// ---------------------------------------------------------------------------
// Backfill from Pi session files (incremental, per-workspace isolated)
// ---------------------------------------------------------------------------

/**
 * Pi persists every session as `<sessionsDir>/<cwdSlug>/<timestamp>_<id>.jsonl`.
 * Each line is an entry; `type:"session"` carries the `cwd`, and `type:"message"`
 * entries with `message.role === "assistant"` carry the full usage/cost we need.
 * This backfill scans those files once, extracts assistant usage records, and
 * merges them into the usage-history store so the stats panel can show the
 * full history — not just messages recorded after this extension loaded.
 *
 * Incremental: a cache file (`backfill-cache.json`) records which session files
 * have been scanned, so re-runs only process new files. Per-workspace isolation
 * is preserved because records carry the `cwd` from the session header and
 * `readHistory({kind:"workspace", cwd})` filters on it.
 */

interface BackfillCache {
	/** Full SHA-256 digests of absolute session paths already scanned. */
	scannedFiles: string[];
	/** Map: cwd -> count of records extracted. */
	workspaceCounts: Record<string, number>;
}

function backfillCachePath(): string {
	return join(usageHistoryDir(), "backfill-cache.json");
}

async function readBackfillCache(): Promise<BackfillCache> {
	try {
		const raw = await readFile(backfillCachePath(), "utf8");
		const parsed = JSON.parse(raw) as BackfillCache;
		return {
			scannedFiles: Array.isArray(parsed.scannedFiles) ? parsed.scannedFiles : [],
			workspaceCounts: typeof parsed.workspaceCounts === "object" && parsed.workspaceCounts ? parsed.workspaceCounts : {},
		};
	} catch {
		return { scannedFiles: [], workspaceCounts: {} };
	}
}

async function writeBackfillCache(cache: BackfillCache, lock: PrivateStateLock): Promise<void> {
	try {
		await mkdir(usageHistoryDir(), { recursive: true,mode:0o700 });
		await atomicWrite(backfillCachePath(), `${JSON.stringify(cache, null, 2)}\n`, lock);
	} catch {
		// Best-effort cache.
	}
}

function backfillPathKey(file: string): string {
	return fullDigest(resolve(file));
}

/** Parse one Pi session file into usage records. Returns [] on any error. */
async function parseSessionFile(file:string):Promise<UsageRecord[]>{try{return extractSessionUsage(await readFile(file,'utf8')).map(legacyRecord);}catch{return [];}}

/**
 * Incrementally backfill usage records from Pi session files. Scans only files
 * not yet in the cache and appends their records to the usage-history store
 * (deduplicated by sessionId so repeated runs are idempotent). Returns the
 * number of new records extracted. Safe to call repeatedly; no-op when up to date.
 */
export async function backfillFromSessions(host:UsageHistoryHostIdentity={}): Promise<{ newRecords: number; newFiles: number;skippedLegacyAmbiguous:number;partial:boolean }> {
	const sessionsDir = join(getAgentDir(), "sessions");
	if (!existsSync(sessionsDir)) return { newRecords: 0, newFiles: 0,skippedLegacyAmbiguous:0,partial:false };
	return withUsageHistoryLock(async (lock) => {
		const cache = await readBackfillCache();
		// Legacy timestamp ambiguity is conservatively skipped; strong entry IDs deduplicate exactly.
		const scanned = new Set(cache.scannedFiles.filter((key) => /^[a-f0-9]{64}$/.test(key)));
		const files: string[] = [];
		try {
			for (const sub of await readdir(sessionsDir, { withFileTypes: true })) {
				if (!sub.isDirectory() || sub.isSymbolicLink()) continue;
				const subDir = join(sessionsDir, sub.name);
				for (const entry of await readdir(subDir, { withFileTypes: true })) {
					if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl")) files.push(join(subDir, entry.name));
				}
			}
		} catch {
			return { newRecords: 0, newFiles: 0,skippedLegacyAmbiguous:0,partial:false };
		}
		const newFiles = files.filter((file) => !scanned.has(backfillPathKey(file)));
		if (newFiles.length === 0) return { newRecords: 0, newFiles: 0,skippedLegacyAmbiguous:0,partial:false };
		let totalNew = 0,skippedLegacyAmbiguous=0;
		const changedSessions = new Set<string>();
		for (const file of newFiles) {
			const records = await parseSessionFile(file);
			const bySession = new Map<string, UsageRecord[]>();
			for (const record of records) {
				const list = bySession.get(record.sessionId) ?? [];
				list.push(record);
				bySession.set(record.sessionId, list);
			}
			for (const [sessionId, sessionRecords] of bySession) {
				await migrateSessionLocked(sessionId, lock);
				const selection=selectBackfillRecords(await readSessionRecordsLocked(sessionId,lock),sessionRecords);
				skippedLegacyAmbiguous+=selection.skippedLegacyAmbiguous;
				const fresh=selection.records.map(legacyRecord);
				if (fresh.length === 0) continue;
				try {
					await lock.assertOwned();
					await appendFile(usageSessionFile(sessionId), fresh.map((record) => JSON.stringify(record)).join("\n") + "\n", {encoding:"utf8",mode:0o600});
					totalNew += fresh.length;
					changedSessions.add(sessionId);
					const ownerCwd = fresh[0]?.cwd ?? "";
					cache.workspaceCounts[ownerCwd] = (cache.workspaceCounts[ownerCwd] ?? 0) + fresh.length;
				} catch {
					// Best-effort.
				}
			}
			scanned.add(backfillPathKey(file));
		}
		for (const sessionId of changedSessions) await refreshIndexEntryLocked(sessionId, lock);
		const currentKeys = new Set(files.map(backfillPathKey));
		cache.scannedFiles = [...scanned].filter((key) => currentKeys.has(key)).slice(-5000);
		await writeBackfillCache(cache, lock);
		return { newRecords: totalNew, newFiles: newFiles.length,skippedLegacyAmbiguous,partial:skippedLegacyAmbiguous>0 };
	},host);
}

function legacyRecord(record:UsageRecordV1):UsageRecord {const r=toLegacyUsageRecord(record);return {...r,usage:{input:r.usage.input??0,output:r.usage.output??0,cacheRead:r.usage.cacheRead??0,cacheWrite:r.usage.cacheWrite??0},cost:{total:r.cost.total??0,input:r.cost.input??0,output:r.cost.output??0,cacheRead:r.cost.cacheRead??0,cacheWrite:r.cost.cacheWrite??0}};}
function legacyTotals(value:ReturnType<typeof coreTotals>):UsageTotals{return {...value,input:value.input??Number.NaN,output:value.output??Number.NaN,cacheRead:value.cacheRead??Number.NaN,cacheWrite:value.cacheWrite??Number.NaN,totalTokens:value.totalTokens??Number.NaN,totalCost:value.totalCost??Number.NaN,cacheHitRate:value.cacheHitRate??Number.NaN};}
function usageTransaction(lock:PrivateStateLock):UsageHistoryTransaction {
 const path=(id:string)=>{if(id!==id.split(/[\\/]/).at(-1)||!id||id==='.'||id==='..')throw new Error('Invalid usage partition');return join(usageHistoryDir(),id);};
 const directoryFacts=async()=>{const directory=await lstat(usageHistoryDir()),uid=process.getuid?.();return {directory,uid,owned:uid!==undefined&&directory.uid===uid&&directory.isDirectory()&&!directory.isSymbolicLink()};};
 const inspect=async(id:string)=>{const {directory,uid,owned:directoryOwned}=await directoryFacts(),info=await lstat(path(id));const regular=info.isFile()&&!info.isSymbolicLink(),owned=directoryOwned&&uid===info.uid;
  return {id,revision:`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.mode}:${info.uid}:${directory.mode}:${directory.uid}`,sizeBytes:info.size,regular,private:owned&&(directory.mode&0o077)===0&&(info.mode&0o077)===0,active:false,trustedLegacyStore:owned&&regular&&(directory.mode&0o022)===0&&(info.mode&0o022)===0};
 };
 return {assertOwned:()=>lock.assertOwned(),async list(){return Promise.all((await readdir(usageHistoryDir())).map(inspect));},async read(id,max){try{const info=await inspect(id);if(!readableUsageFile(info)||info.sizeBytes>max)throw new Error('Unsafe usage file');return strictUtf8Decoder.decode(await readFile(path(id)));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}},async replace(id,raw){
  const {directory,owned}=await directoryFacts();if(!owned||(directory.mode&0o022)!==0)throw new Error('Unsafe usage directory');
  try{if(!readableUsageFile(await inspect(id)))throw new Error('Unsafe usage file');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await atomicWrite(path(id),raw,lock);
 },async remove(id){if(!readableUsageFile(await inspect(id)))throw new Error('Unsafe usage file');await lock.assertOwned();await unlink(path(id));}};
}
export function createUsageHistoryHostPort():UsageHistoryPort{return {transact:fn=>withUsageHistoryLock(lock=>fn(usageTransaction(lock)))};}
function historyOwner():UsageHistoryOwner{return new UsageHistoryOwner(createUsageHistoryHostPort());}
