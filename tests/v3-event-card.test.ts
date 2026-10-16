import test from "node:test";import assert from "node:assert/strict";import {createJiti} from "jiti";
const jiti=createJiti(import.meta.url);const {graphEventCard}=await jiti.import<any>("../src/v3/ui/event-card.ts");const {setDisplayEvidence,setGraphDisplayGoal}=await jiti.import<any>("../src/v3/ui/presentation.ts");
const snapshot=(phase:string):any=>({graphId:"g",sessionId:"owner",runInstanceId:"run",status:"running",nodes:{work:{phase,attempt:1,agent:"backend",observation:{actualModel:"fixture/actual",asyncId:"child"}}}});
test("receipt event uses dispatch and acceptance evidence rather than submitted or result-read labels",()=>{
 const queued=snapshot("queued");assert.match(graphEventCard("start",queued,false),/节点覆盖未核实/);assert.doesNotMatch(graphEventCard("start",queued,false),/agent-started/);
 const running=snapshot("running"),before=JSON.stringify(running);assert.match(graphEventCard("start",running,false),/状态证据待核对/);assert.equal(JSON.stringify(running),before);
 const accepted=snapshot("accepted");assert.match(graphEventCard("wait",accepted,false),/状态证据待核对/);assert.doesNotMatch(graphEventCard("wait",accepted,false),/已验收/);
 const failed=snapshot("failed");setDisplayEvidence(failed,{failures:{work:"Graph scope contains a symbolic link: /private/fixture/node_modules/ajv"},neverDispatched:new Set(["work"])});const out=graphEventCard("wait",failed,false);assert.match(out,/隔离范围/);assert.match(out,/隔离范围包含符号链接/);assert.doesNotMatch(out,/agent-started|\/private/);
 const exited=snapshot("running");exited.nodes.work.observation.supervision={processExitConfirmed:true,health:"exited"};assert.doesNotMatch(graphEventCard("wait",exited,false,true),/agent-started/);assert.match(graphEventCard("wait",exited,false,true),/已退出.*核对/);
});

test("native ToolExecutionComponent shares state and removes duplicate call after result without changing machine data",async()=>{
 const {default:register}=await jiti.import<any>("../extensions/pi-graph.ts");let tool:any;register({events:{on(){return()=>{};},emit(){throw Error("no RPC");}},on(){},registerTool:(t:any)=>{if(t.name==="graph")tool=t;},registerCommand(){}});
 const {initTheme}=await jiti.import<any>(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",import.meta.url).href);initTheme("dark",false);
 const {ToolExecutionComponent}=await jiti.import<any>(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js",import.meta.url).href);
 const component=new ToolExecutionComponent("graph","receipt",{action:"start",id:"g"},{},tool,{requestRender(){}},process.cwd());
 const result={content:[{type:"text",text:"unchanged machine payload"}],details:{snapshot:snapshot("running")},isError:false},before=JSON.stringify(result);
 component.updateResult(result,false);const lines=component.render(120).join("\n");assert.match(lines,/状态证据待核对/);assert.doesNotMatch(lines,/准备启动|正在提交|◆ 已提交/);assert.equal(JSON.stringify(result),before);
 component.setExpanded(true);assert.match(component.render(180).join("\n"),/回执快照/);
 component.dispose?.();
});

test("settled native receipt keeps captured identity while machine details stay bounded and later snapshot changes do not alter it",async()=>{
 const {mkdtemp}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=await mkdtemp(join(tmpdir(),"receipt-native-"));
 const {default:register,graphWaitResultV3}=await jiti.import<any>("../extensions/pi-graph.ts");let tool:any;register({events:{on(){return()=>{};},emit(){throw Error("no RPC");}},on(){},registerTool:(t:any)=>{if(t.name==="graph")tool=t;},registerCommand(){}});
 const s=snapshot("accepted");s.status="complete";const value=await graphWaitResultV3("g",{reason:"graph_settled",snapshot:s},root),before=JSON.stringify(value);s.nodes.work.agent="changed-later";
 const context={args:{action:"wait",id:"g"},state:{},toolCallId:"settled",isError:false};const theme={fg:(_:string,s:string)=>s};const text=tool.renderResult(value,{expanded:false,isPartial:false},theme,context).render(200).join("\n");assert.match(text,/状态证据待核对/);assert.doesNotMatch(text,/changed-later/);assert.equal(JSON.stringify(value),before);assert.equal(value.details.snapshot,undefined);
});

test("historical clipped snapshots label only receipt-node coverage and unobserved running is never reported queued",()=>{
 const s=snapshot("running");delete s.runInstanceId;delete s.nodes.work.observation.asyncId;const text=graphEventCard("wait",s,false);assert.match(text,/执行状态待核对/);assert.match(text,/运行身份不完整/);assert.match(text,/另 1 项/);assert.doesNotMatch(text,/agent-started|queued|Graph 已验收/);
});

test("fail-fast never-started remains explicit and large accepted waits collapse without enumerating all tasks",()=>{
 const s=snapshot("failed");setDisplayEvidence(s,{failures:{work:"Graph failed fast before this node started."},neverDispatched:new Set(["work"])});assert.match(graphEventCard("wait",s,false),/其他任务失败后，本任务未启动/);
 const done=snapshot("accepted");for(let i=0;i<12;i++)done.nodes[`accepted-${i}`]=structuredClone(done.nodes.work);const text=graphEventCard("wait",done,false);assert.ok(text.split("\n").length<=4);assert.match(text,/节点覆盖未核实/);assert.doesNotMatch(text,/已验收/);assert.doesNotMatch(text,/@accepted-/);
});

test('healthy complete evidence hides both native call and result while every warning remains visible',async()=>{
 const {default:register}=await jiti.import<any>('../extensions/pi-graph.ts');const {quietGraphEvent}=await jiti.import<any>('../src/v3/ui/event-card.ts');let tool:any;register({events:{on(){return()=>{}},emit(){throw Error('no runtime')}},on(){},registerTool(t:any){if(t.name==='graph')tool=t},registerCommand(){}});
 const themes=await jiti.import<any>(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js',import.meta.url).href);const {ToolExecutionComponent}=await jiti.import<any>(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js',import.meta.url).href);
 for(const palette of ['dark','light'])for(const action of ['start','wait'])for(const phase of ['queued','running','accepted']){themes.initTheme(palette,false);const s=snapshot(phase);if(phase==='accepted')s.status='complete';setGraphDisplayGoal(s,'可读任务目标',['work']);assert.equal(quietGraphEvent(s,false),true);const result={content:[{type:'text',text:'ORIGINAL MODEL CONTENT'}],details:{snapshot:s},isError:false};const before=JSON.stringify(result);const c=new ToolExecutionComponent('graph','quiet',{action},{},tool,{requestRender(){}},process.cwd());for(const streaming of [true,false]){c.updateResult(result,streaming);for(const w of [45,80,120,180])assert.equal(c.render(w).join('').trim(),'');}c.setExpanded(true);assert.ok(c.render(180).join('').trim());assert.equal(JSON.stringify(result),before);c.dispose?.();}
 const cases=[(s:any,r:any)=>s.nodes.work.observation.supervision={attention:'waiting_user'},(s:any,r:any)=>{s.nodes.work.phase='accepted';s.nodes.work.observation.supervision={attention:'storage_error'}},(s:any,r:any)=>s.nodes.work.observation.supervision={error:'Fixture failure'},(s:any,r:any)=>s.nodes.work.observation.supervision={health:'exited'},(s:any,r:any)=>delete s.sessionId,(s:any,r:any)=>delete s.nodes.work,(s:any,r:any)=>s.nodes.extra={phase:'queued'},(s:any,r:any)=>s.nodes.work.phase='blocked',(s:any,r:any)=>r.isError=true,(s:any,r:any)=>r.details.todoBinding={state:'unconfirmed'},(s:any,r:any)=>r.details.todoBinding={reminder:'missing'},(s:any,r:any)=>r.details.stopRequested=true,(s:any,r:any)=>r.details.supervisorRequests=[{requestId:'fixture'}],(s:any,r:any)=>r.details.supervisorDiagnostics=['fixture'],(s:any,r:any)=>r.details.waitReason='attention_required'];
 for(const change of cases){const s=snapshot('running');setGraphDisplayGoal(s,'可读任务目标',['work']);const r:any={content:[{type:'text',text:'Fixture failure'}],details:{snapshot:s},isError:false};change(s,r);const c=new ToolExecutionComponent('graph','warning',{action:'wait'},{},tool,{requestRender(){}},process.cwd());c.updateResult(r,false);assert.ok(c.render(80).join('').trim());c.dispose?.();}
});

test('cancelled wait receipts remain visible without stopping Graph or changing machine facts',async()=>{const {default:register,graphWaitResultV3}=await jiti.import<any>('../extensions/pi-graph.ts');const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'cancelled-wait-view-'));let tool:any;register({events:{on(){return()=>{}},emit(){throw Error('display must not stop or invoke Host')}},on(){},registerTool(t:any){if(t.name==='graph')tool=t},registerCommand(){}});try{for(const reason of ['aborted','session_shutdown']){const s=snapshot('running');setGraphDisplayGoal(s,'当前工作',['work']);const r=await graphWaitResultV3(s.graphId,{reason,snapshot:s},root);const before=JSON.stringify(r);for(const isPartial of [true,false]){const c=tool.renderResult(r,{expanded:false,isPartial},{fg:(_c:string,t:string)=>t},{args:{action:'wait'},state:{},toolCallId:reason,isError:false});assert.match(c.render(120).join('\n'),/已停止等待，Graph可能继续运行/);assert.equal(JSON.stringify(r),before);assert.equal(s.status,'running');}}}finally{await rm(root,{recursive:true,force:true})}});
