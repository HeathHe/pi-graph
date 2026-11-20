import type {Header,ReadView,Scope,Subscription} from '../contracts.ts';
export type DeliveryState='attempted'|'unknown'|'confirmed'|'failed';
/** host-receipt-observed proves matching receipt observation only, never SDK persistence or business acceptance. */
export type EvidenceStage='transport-enqueued'|'host-receipt-observed'|'canonical-result-published';
export type SupervisionDomain='execution-publication'|'notification-receipt'|'verdict'|'physical-close'|'evaluation'|'intervention';
export interface SupervisionFact {
 header:Header;source:'goal'|'monitor'|'advisor'|'completion';
 kind:'evaluating'|'verdict'|'intervention'|'notification'|'completion'|'physical-close';
 severity:'info'|'nit'|'concern'|'blocker';operationId?:string;
 /** Producer-captured start sequence; required for multi-stage operations and publication receipts. */
 operationStartSequence?:number;
 delivery?:{state:DeliveryState;stage?:EvidenceStage;receiptId?:string};
 target?:string;message?:string;verdict?:{status:string;pass?:boolean};
 terminalOutcome?:'completed'|'failed'|'terminated';
}
export type AcceptResult='applied'|'duplicate'|'foreign'|'conflict'|'invalid'|'dedup-expired'|'out-of-order'|'closed';
export interface SupervisionProjection {
 scope:Scope;events:SupervisionFact[];
 counts:Record<SupervisionDomain,number>;
 delivery:Record<DeliveryState,number>;
 publications:Record<'completed'|'failed'|'terminated'|'unknown',number>;
 history:HistoryRestoreResult;dropped:number;evicted:number;diagnostics:number;
}
export interface HistoryRestoreResult {status:'available'|'unavailable'|'invalid'|'foreign'|'closed';current:SupervisionFact[];historical:{scope:Scope;events:SupervisionFact[]}[];reason?:string}
export interface SupervisionOwnerView {snapshot():ReadView<SupervisionProjection>;subscribe(listener:()=>void):Subscription}
export interface JournalPartition {workspaceDigest:string;sessionDigest:string}
export interface JournalTransaction {
 readBounded(maxBytes:number):Promise<string|null>;
 replaceAtomically(bytes:string):Promise<void>;
 assertOwned():Promise<void>;
}
export interface JournalPort {transact<T>(scopeKey:string,fn:(tx:JournalTransaction)=>Promise<T>):Promise<T>}
