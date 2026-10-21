import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {TodoLifecycle,projectLifecycle,restoreLifecycle}=await jiti.import<any>('../src/v3/ui/todo-lifecycle.ts');
const {projectTodo}=await jiti.import<any>('../src/v3/ui/todo.ts');
const {terminalStack}=await jiti.import<any>('../src/v3/ui/terminal-stack.ts');
const {setDisplayEvidence}=await jiti.import<any>('../src/v3/ui/presentation.ts');
const theme={fg:(_:string,s:string)=>s,bg:(_:string,s:string)=>s,bold:(s:string)=>s};
function fixture(){
 const items=Array.from({length:22},(_,i)=>({id:'work-'+i,title:'当前待处理工作'+i,status:'pending',dependsOn:[],links:[{graphId:'graph',runInstanceId:'run',taskId:'task-'+i}]}));
 const entries:any[]=Array.from({length:22},(_,i)=>({id:'old-'+i,type:'custom',customType:'pi-graph-todo/1',data:{version:1,revision:i+1,planId:'old-'+i,updatedAt:'2026-01-01T00:00:00Z',items:[{id:'old',title:'历史义务',status:'blocked',links:[]}]}}));
 entries.push({id:'current',type:'custom',customType:'pi-graph-todo/1',data:{version:1,revision:23,planId:'current',updatedAt:'2026-01-01T00:00:00Z',items}});
 const manager={getSessionId:()=> 'session',getSessionFile:()=>undefined,getEntries:()=>entries,getBranch:()=>entries};
 const snapshot:any={sessionId:'session',graphId:'graph',runInstanceId:'run',status:'needs_attention',nodes:Object.fromEntries(items.filter((_,i)=>i%2===0).map((_,i)=>['task-'+i*2,{phase:'failed',attempt:1,error:'受控失败'}]))};
 setDisplayEvidence(snapshot,{failures:{},neverDispatched:new Set(),sideEffects:Object.fromEntries(items.map((_,i)=>['task-'+i,'none']))});
 return {items,entries,manager,snapshot,read:async()=>snapshot,append:(customType:string,data:any)=>entries.push({id:'entry-'+entries.length,type:'custom',customType,data})};
}
test('many blocked/unknown current leaves remain visible with old history and no active Graph in both AltT modes',async()=>{
 const h=fixture(),service=new TodoLifecycle();const before=JSON.stringify(h.snapshot);
 const view=await service.decorate(h.manager,{revision:23,planId:'current',items:await projectTodo(h.items,'session',h.read),persistence:'memory'},h.read);
 assert.equal(view.lifecycle.display,'full');assert.ok(view.items.some((x:any)=>x.derivedStatus==='blocked'));assert.ok(view.items.some((x:any)=>x.derivedStatus==='unknown'));assert.equal(view.lifecycle.historyOmitted,14);
 for(const expanded of [true,false])for(const width of [45,80,240]){
  const rows=terminalStack({sessionId:'session',plan:view,snapshots:[h.snapshot],expanded},width,24,theme).todo.join('\n');
  assert.match(rows,/当前待处理工作/);assert.match(rows,/#/);assert.match(rows,/历史待核/);assert.doesNotMatch(rows,/当前执行/);
 }
 assert.equal(JSON.stringify(h.snapshot),before);assert.equal(h.entries.length,23);
});
test('explicit hide and explain still collapse unresolved current work, show restores it',async()=>{
 for(const operation of ['hide','explain']){
  const h=fixture(),service=new TodoLifecycle();await service.operate(h.manager,{action:'lifecycle',planEntryId:'current',expectedRevision:23,expectedLifecycleRevision:0,operation,reason:'明确收起并说明当前失败'},h.read,h.append,()=>{},'intent');
  const raw={revision:23,planId:'current',items:await projectTodo(h.items,'session',h.read),persistence:'memory'};
  assert.equal((await service.decorate(h.manager,raw,h.read)).lifecycle.display,'summary');
  await service.operate(h.manager,{action:'lifecycle',planEntryId:'current',expectedRevision:23,expectedLifecycleRevision:1,operation:'show'},h.read,h.append,()=>{});
  assert.equal((await service.decorate(h.manager,raw,h.read)).lifecycle.display,'full');
  assert.equal(restoreLifecycle(h.manager,'current').explained,undefined,'intent alone is not delivered explanation');
 }
});
test('genuine delivered success remains hidden; changed issue cannot inherit success hiding',()=>{
 const observed:any={snapshot:{items:[{id:'work',title:'工作'}]},digest:'a'.repeat(64),leaves:[{ref:{planEntryId:'plan',itemId:'work'},identityDigest:'b'.repeat(64),done:true,issue:false,active:false,unsettled:false,unknownEffects:false}]};
 const state:any={version:1,sessionId:'session',planEntryId:'plan',planId:'plan',revision:1,visibility:'shown',dispositions:{},replacements:[],delivery:observed.digest};
 assert.equal(projectLifecycle(state,observed).display,'hidden');
 observed.digest='c'.repeat(64);observed.leaves[0].done=false;observed.leaves[0].issue=true;
 assert.equal(projectLifecycle(state,observed).display,'full');assert.equal(projectLifecycle(state,observed).delivered,false);
});
