import {frozen} from '../contracts.ts';
import type {UsageRecord} from './contracts.ts';
import {usageTotals,type UsageTotals} from './aggregate.ts';
/** Revision comes from the actual session entry producer, including middle-entry edits. */
export class UsageTotalsCache {
 private key?:string;private value?:UsageTotals;
 get(sessionId:string,revision:number,records:readonly UsageRecord[]):Readonly<UsageTotals>{const key=JSON.stringify([sessionId,revision]);if(key!==this.key){this.value=usageTotals(records);this.key=key;}return frozen(this.value!);}
 clear():void{this.key=undefined;this.value=undefined;}
}
