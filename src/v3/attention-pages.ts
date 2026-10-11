import { GraphSourceChangedError, pageGraphData, pageGraphSnapshotText } from './result-receipt.ts';

export interface AttentionReadIdentity {
 graphId:string; runInstanceId:string; ownerSessionId:string; readerSessionId:string;
 readerSessionFile?:string; runDir:string; authorization?:"owner"|"readonly";
}
type Entry = { serialized:string; expires:number; created:number; bytes:number };
/** Session-local, read-only snapshots. Never carries authorization across reads. */
export class AttentionPageSnapshots {
 private readonly entries = new Map<string,Entry>();
 private bytes=0;
 private readonly options:{now?:()=>number;ttlMs?:number;maxAgeMs?:number;maxEntries?:number;maxBytes?:number};
 constructor(options:{now?:()=>number;ttlMs?:number;maxAgeMs?:number;maxEntries?:number;maxBytes?:number}={}) {this.options=options;}
 private scope(identity:AttentionReadIdentity):string {return JSON.stringify([identity.graphId,identity.runInstanceId,identity.ownerSessionId,identity.readerSessionId,identity.readerSessionFile??'',identity.runDir,identity.authorization??'owner']);}
 private prune(now:number):void {
  for(const [key,entry] of this.entries)if(entry.expires<=now||entry.created+(this.options.maxAgeMs??600000)<=now){this.entries.delete(key);this.bytes-=entry.bytes;}
 }
 /** latest must have passed the normal authorization/identity read on EVERY call. */
 read(identity:AttentionReadIdentity,latest:unknown,offset=0,limit=4096,expectedSha256?:string) {
  const now=this.options.now?.()??Date.now();this.prune(now);
  // Validate offsets, limits and hash before consulting any cached source.
  const latestPage=pageGraphData(latest,0,limit,{action:'attention',id:identity.graphId});
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid page offset or limit');
  if(expectedSha256!==undefined&&!/^[a-fA-F0-9]{64}$/u.test(expectedSha256))throw new Error('expectedSha256 must be 64 hexadecimal characters');
  const prefix=this.scope(identity),key=prefix+'|'+latestPage.sha256;
  if(offset>0){
   const entry=expectedSha256?this.entries.get(prefix+'|'+expectedSha256.toLowerCase()):undefined;
   if(!entry)throw new GraphSourceChangedError({action:'attention',id:identity.graphId,offset:0,limit},latestPage.sha256);
   const frozen=JSON.parse(entry.serialized);
   const page=pageGraphData(frozen,offset,limit,{action:'attention',id:identity.graphId},expectedSha256);
   entry.expires=Math.min(now+(this.options.ttlMs??120000),entry.created+(this.options.maxAgeMs??600000));
   return {...page,requestCount:Array.isArray(frozen?.requests)?frozen.requests.length:undefined};
  }
  const page=pageGraphData(latest,0,limit,{action:'attention',id:identity.graphId},expectedSha256);
  const serialized=JSON.stringify(latest),bytes=Buffer.byteLength(serialized),maxBytes=this.options.maxBytes??16*1024*1024;
  if(bytes>maxBytes)throw new Error('Attention snapshot exceeds the bounded read cache; inspect individual nodes or mailbox requests.');
  const existing=this.entries.get(key);
  if(existing){this.entries.delete(key);this.bytes-=existing.bytes;}
  while(this.entries.size>=(this.options.maxEntries??32)||this.bytes+bytes>maxBytes){
   const first=this.entries.entries().next().value as [string,Entry]|undefined;
   if(!first)break;this.entries.delete(first[0]);this.bytes-=first[1].bytes;
  }
  this.entries.set(key,{serialized,bytes,created:existing?.created??now,expires:Math.min(now+(this.options.ttlMs??120000),(existing?.created??now)+(this.options.maxAgeMs??600000))});this.bytes+=bytes;
  return {...page,requestCount:Array.isArray((latest as {requests?:unknown})?.requests)?(latest as {requests:unknown[]}).requests.length:undefined};
 }
 /** Caller must freshly validate raw snapshot structure and run identity before EVERY read. */
 readSnapshot(identity:AttentionReadIdentity,text:string,offset=0,limit=4096,expectedSha256?:string) {
  const now=this.options.now?.()??Date.now();this.prune(now);
  const latestPage=pageGraphSnapshotText(text,identity.graphId,0,limit);
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid page offset or limit');
  if(expectedSha256!==undefined&&!/^[a-fA-F0-9]{64}$/u.test(expectedSha256))throw new Error('expectedSha256 must be 64 hexadecimal characters');
  const prefix='result-snapshot|'+this.scope(identity),key=prefix+'|'+latestPage.sha256;
  if(offset>0){
   const entry=expectedSha256?this.entries.get(prefix+'|'+expectedSha256.toLowerCase()):undefined;
   if(!entry)throw new GraphSourceChangedError({action:'result',id:identity.graphId,offset:0,limit},latestPage.sha256);
   const page=pageGraphSnapshotText(entry.serialized,identity.graphId,offset,limit,expectedSha256);
   entry.expires=Math.min(now+(this.options.ttlMs??120000),entry.created+(this.options.maxAgeMs??600000));
   return page;
  }
  const page=pageGraphSnapshotText(text,identity.graphId,0,limit,expectedSha256),bytes=Buffer.byteLength(text),maxBytes=this.options.maxBytes??16*1024*1024;
  if(bytes>maxBytes)throw new Error('Result snapshot exceeds the bounded read cache; inspect individual nodes.');
  const existing=this.entries.get(key);if(existing){this.entries.delete(key);this.bytes-=existing.bytes;}
  while(this.entries.size>=(this.options.maxEntries??32)||this.bytes+bytes>maxBytes){const first=this.entries.entries().next().value as [string,Entry]|undefined;if(!first)break;this.entries.delete(first[0]);this.bytes-=first[1].bytes;}
  this.entries.set(key,{serialized:text,bytes,created:existing?.created??now,expires:Math.min(now+(this.options.ttlMs??120000),(existing?.created??now)+(this.options.maxAgeMs??600000))});this.bytes+=bytes;return page;
 }
 clear():void {this.entries.clear();this.bytes=0;}
}
