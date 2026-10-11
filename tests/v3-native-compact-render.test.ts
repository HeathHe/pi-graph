import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {compactGraphLines,setDisplayEvidence}=await jiti.import<any>('../src/v3/ui/presentation.ts');
const {GraphInspector}=await jiti.import<any>('../src/v3/ui/inspector.ts');
const {visibleWidth}=await import('@earendil-works/pi-tui');
const theme={fg:(_c:string,s:string)=>s,bg:(_c:string,s:string)=>s,bold:(s:string)=>s,italic:(s:string)=>s};
test('owned Graph compact single/multiple/parallel/dependency views suppress verbose text and preserve detailed facts without mutations',()=>{
 const root=mkdtempSync(join(tmpdir(),'owned-compact-'));const log=join(root,'output.log');writeFileSync(log,'UNCHANGED-LOG-BYTES');
 const node=(id:string,phase='running'):any=>({phase,attempt:1,agent:id,dependsOn:[],task:'SECRET-TASK-FULL-TEXT',observation:{asyncId:id,actualAgent:id,actualModel:'fixture/ACTUAL-MODEL',thinking:'high',observedAt:new Date().toISOString(),progress:{currentTool:'read',currentPath:'/secret/long/PRIVATE-PATH.ts',turnCount:3,toolCount:6,lastActivityAt:new Date().toISOString()},supervision:{activity:'active',probe:'available',checkedAt:new Date().toISOString(),runtimeLimit:'unlimited',error:'REAL-ERROR'}}});
 const graph=(id:string,n=1):any=>({schemaVersion:3,graphId:id,runInstanceId:id,sessionId:'owner',status:'running',nodes:Object.fromEntries(Array.from({length:n},(_,i)=>[`${id}-agent-${i}`,node(`${id}-agent-${i}`)]))});
 const ordinary=graph('ordinary'),parallel=graph('parallel',3),dependency=graph('parent');dependency.nodes.nested=node('nested-agent','failed');dependency.nodes['parent-agent-0'].dependsOn=['nested'];setDisplayEvidence(dependency,{failures:{nested:'NESTED-ERROR'},neverDispatched:new Set()});
 try{for(const jobs of [[ordinary],[graph('graph-child'),ordinary],[parallel],[dependency],[{...graph('empty'),nodes:{}}]]){
  const before=JSON.stringify(jobs);const compact=jobs.flatMap((g:any)=>compactGraphLines(g)).join('\n');
  assert.doesNotMatch(compact,/SECRET-TASK|PRIVATE-PATH|task:|output:|Press ctrl\+o/);
  if(jobs[0].graphId==='parallel')assert.match(compact,/运行 3/);
  if(jobs[0].graphId==='parent')assert.match(compact,/失败 1/);
  for(const g of jobs)for(const id of Object.keys(g.nodes)){
   const panel=new GraphInspector({snapshot:g,selectedId:id,theme,rows:()=>80,requestRender(){},onClose(){},read:async()=>g,pollMs:60000});
   try{panel.handleInput('\r');const details=panel.render(1000).join('\n');assert.match(details,/ACTUAL-MODEL/);assert.match(details,/6 次/);assert.match(details,/read/);assert.match(details,/PRIVATE-PATH/);if(id==='nested')assert.match(details,/NESTED-ERROR/);assert.equal(panel.render(1000).join('\n'),details,'unchanged expanded facts render identically');}finally{panel.dispose();}
  }
  assert.equal(JSON.stringify(jobs),before);assert.equal(readFileSync(log,'utf8'),'UNCHANGED-LOG-BYTES');
 }}finally{rmSync(root,{recursive:true,force:true});}
});


test('compact owned rows omit absent observations, show recent completed tools, and keep completed execution separate from detail read errors',()=>{
 const s:any={schemaVersion:3,graphId:'fixture',status:'running',nodes:{pending:{phase:'running',attempt:1,dependsOn:[]}}};
 let out=compactGraphLines(s).join('\n');assert.match(out,/当前：pending/);assert.doesNotMatch(out,/尚未|未观测|未提供|undefined|模型/);
 s.nodes.pending.agent='backend-developer';s.nodes.pending.observation={actualModel:'fixture/local',progress:{lastTool:'write'}};
 out=compactGraphLines(s).join('\n');assert.match(out,/backend-developer/);assert.doesNotMatch(out,/当前：pending/);assert.match(out,/fixture\/local/);assert.match(out,/最近工具 write/);
 s.status='complete';s.nodes.pending.phase='accepted';s.nodes.pending.observation.supervision={attention:'result_unavailable',error:'OLD-EXECUTION-ERROR'};
 setDisplayEvidence(s,{failures:{},neverDispatched:new Set(),readError:'fixture artifact changed'});
 const before=JSON.stringify(s);out=compactGraphLines(s).join('\n');assert.match(out,/已完成/);assert.match(out,/成功 1/);assert.match(out,/详情读取异常：fixture artifact changed/);assert.doesNotMatch(out,/OLD-EXECUTION-ERROR|尚未验收|原因/);assert.equal(JSON.stringify(s),before);
});

test('compact task facts cap width and remove terminal controls without guessing task names',()=>{
 const s:any={schemaVersion:3,graphId:'fixture',status:'running',nodes:{['task-'+ 'x'.repeat(200)]:{phase:'running',attempt:1,agent:'role-'+ 'y'.repeat(200),dependsOn:[],observation:{actualModel:'fixture/'+ 'z'.repeat(200),progress:{currentTool:'read\u001b[31m'+ 'q'.repeat(200)}}}}};
 const out=compactGraphLines(s);const row=out.find((x:string)=>x.includes('当前：'));assert.ok(row);assert.ok(visibleWidth(row)<=80);assert.match(row,/工具 read/);assert.doesNotMatch(row,/task-xxx/);assert.doesNotMatch(row,/\u001b|尚未|未观测/);
});


test('compact next task label stays bounded at eighty columns',()=>{
 const s:any={schemaVersion:3,graphId:'fixture',status:'queued',nodes:{['next-'+ 'x'.repeat(200)]:{phase:'queued',attempt:0,dependsOn:[]}}};
 const row=compactGraphLines(s).find((x:string)=>x.includes('下一项：'));assert.ok(row);assert.ok(visibleWidth(row)<=80);assert.match(row,/next-/);
});
