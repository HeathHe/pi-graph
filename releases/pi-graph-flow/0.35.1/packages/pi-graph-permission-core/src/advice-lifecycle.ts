import { createPolicyCallBudgets } from "./budget-facts.ts";
export interface AdviceSession {readonly sessionId:string;readonly key:string;readonly generation:number;}
export function createAdviceLifecycle<Entry>() {
 const budgets=createPolicyCallBudgets();
 const sessions=new Map<string,{identity:AdviceSession;cache:Map<string,Entry>}>();
 function current(state:AdviceSession){const row=sessions.get(state.key);if(row?.identity!==state)throw new Error("Decision policy session changed");return row;}
 return {
  acquire(key:string,sessionId:string):AdviceSession {let row=sessions.get(key);if(!row){row={identity:Object.freeze({key,sessionId,generation:0}),cache:new Map()};sessions.set(key,row);}return row.identity;},
  isCurrent(key:string,state:AdviceSession){return sessions.get(key)?.identity===state;},
  invalidateSession(sessionId:string){for(const [key,row] of sessions)if(row.identity.sessionId===sessionId){row.cache.clear();sessions.delete(key);}},
  cached(state:AdviceSession,key:string){return current(state).cache.get(key);},
  cache(state:AdviceSession,key:string,value:Entry){const cache=current(state).cache;if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,value);},
  reserve(state:AdviceSession,kind:"classification"|"advice",limit:number){current(state);budgets.reserve(state.key,kind,limit);},
 };
}
