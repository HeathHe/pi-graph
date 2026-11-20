import type {Availability,Header,Scope} from '../contracts.ts';
export type UsageField='input'|'output'|'cacheRead'|'cacheWrite';
export type TokenCounts=Partial<Record<UsageField,number>>;
export type CostCounts=Partial<Record<UsageField|'total',number>>;
export interface UsageRecordV1 {ts:number;model:string;provider:string;sessionId:string;cwd:string;usage:TokenCounts;cost:CostCounts;messageIdentity?:string;identityStrength?:'host'|'weak';unknownFields?:string[]}
export type UsageRecord=UsageRecordV1;
export interface UsageFact {header:Header;messageIdentity?:string;model:string;provider:string;cwd:string;usage:TokenCounts;cost?:CostCounts;contentDigest?:string}
export interface SessionIndexEntry {sessionId:string;firstTs:number;lastTs:number;recordCount:number;totalCost?:number;modelCount:number;unknownFields:string[]}
export interface SessionIndex {sessions:SessionIndexEntry[]}
export type ReadScope={kind:'session';sessionId:string}|{kind:'workspace';cwd:string}|{kind:'all'};
export interface ReadOptions {since?:number;limit?:number}
/** Host validates regular/private files, exact directory ownership and lock liveness. */
export interface UsageFile {id:string;revision:string;sizeBytes:number;regular:boolean;private:boolean;active:boolean;/** Explicit Host evidence for an owned non-writable-by-others legacy store, not private permission proof. */trustedLegacyStore?:boolean}
export interface UsageHistoryTransaction {
 assertOwned():Promise<void>;list():Promise<UsageFile[]>;read(id:string,maxBytes:number):Promise<string|null>;
 replace(id:string,contents:string):Promise<void>;remove(id:string):Promise<void>;
}
export interface UsageHistoryPort {transact<T>(fn:(tx:UsageHistoryTransaction)=>Promise<T>):Promise<T>}
export interface UsageData {
 session?:number;weekly?:number;quotaHidden?:boolean;sessionHidden?:boolean;weeklyHidden?:boolean;
 accountBalance?:AccountBalance;accountBalanceDetails?:AccountBalance[];accountSpend?:AccountSpend;
 sessionResetsIn?:string;weeklyResetsIn?:string;sessionResetsAt?:string;weeklyResetsAt?:string;
 extraSpend?:number;extraLimit?:number;sessionLabel?:string;weeklyLabel?:string;
 notice?:string;warning?:string;stale?:boolean;fetchedAt?:number;error?:string;
}
export interface AccountBalance {amount:number;unit:string;label:string}
export interface AccountSpend {unit:string;daily?:number;weekly?:number;monthly?:number;lifetime?:number}
export type ProviderKey='chatgpt'|'codex'|'claude'|'zai'|'zai-cn'|'kimi'|'minimax'|'minimax-cn'|'openrouter'|'deepseek'|'moonshot'|'moonshot-cn';
export interface QuotaObservation {status:Availability;data?:UsageData;retryAfterMs?:number;errorCode?:'rate-limit'|'auth'|'unavailable'|'invalid-response'|'timeout';observedAt:number}
export interface QuotaProviderPort {fetch(request:{scope:Scope;provider:ProviderKey;accountRevision:string;signal:AbortSignal;deadline:number}):Promise<QuotaObservation>}
