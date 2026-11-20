import {Buffer} from 'node:buffer';
import {validHeader} from '../scope.ts';
import type {SupervisionDomain,SupervisionFact} from './contracts.ts';
export function domainOf(f:SupervisionFact):SupervisionDomain {
 if(f.kind==='completion')return 'execution-publication';
 if(f.kind==='notification')return 'notification-receipt';
 if(f.kind==='evaluating')return 'evaluation';
 return f.kind;
}
export function validFact(f:SupervisionFact):boolean {
 try {
 if(!f||!validHeader(f.header)||!['goal','monitor','advisor','completion'].includes(f.source)||!['evaluating','verdict','intervention','notification','completion','physical-close'].includes(f.kind)||!['info','nit','concern','blocker'].includes(f.severity))return false;
 if([f.operationId,f.target,f.message].some(x=>x!==undefined&&(typeof x!=='string'||x.length>4096)))return false;
 if(f.verdict&&(typeof f.verdict.status!=='string'||(f.verdict.pass!==undefined&&typeof f.verdict.pass!=='boolean')))return false;
 if(f.terminalOutcome!==undefined&&!['completed','failed','terminated'].includes(f.terminalOutcome))return false;
 if((f.operationId!==undefined||f.kind==='completion')&&(f.operationStartSequence===undefined||!Number.isSafeInteger(f.operationStartSequence)||f.operationStartSequence<0||f.operationStartSequence>f.header.sequence))return false;
 const d=f.delivery;
 if(d&&(!['attempted','unknown','confirmed','failed'].includes(d.state)||(d.stage!==undefined&&!['transport-enqueued','host-receipt-observed','canonical-result-published'].includes(d.stage))))return false;
 if(d?.state==='confirmed'&&(!d.stage||typeof d.receiptId!=='string'||!d.receiptId.trim()))return false;
 if(f.kind==='completion'&&(d?.state!=='confirmed'||d.stage!=='canonical-result-published'))return false;
 if(f.kind!=='completion'&&d?.stage==='canonical-result-published')return false;
 return Buffer.byteLength(JSON.stringify(f))<=8192;
 }catch{return false;}
}
/** Stable content identity ignores object property insertion order. */
export function canonical(value:unknown):string {
 if(value===undefined)return 'undefined';
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
