import assert from "node:assert/strict";
import test from "node:test";
import {createJiti} from "jiti";
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join,resolve} from "node:path";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {interactionUiCapture} from "./helpers/interaction-ui-capture.ts";

// Independent acceptance: actual command, Inspector, Graph widget and own work inventory.
// Only terminal I/O and durable fixture records are simulated; no model/provider/host tasks.
const jiti=createJiti(import.meta.url);
const {setGraphDisplayGoal}=await jiti.import<any>("../src/v3/ui/presentation.ts");
const {GraphInspector}=await jiti.import<any>("../src/v3/ui/inspector.ts");
const {default:register,V3GraphNativeUiCommitter}=await jiti.import<any>("../extensions/pi-graph.ts");
const {visibleWidth}=await jiti.import<any>("@earendil-works/pi-tui");
const theme={fg:(_c:string,s:string)=>s,bg:(_c:string,s:string)=>s,bold:(s:string)=>s,italic:(s:string)=>s};
function snapshot(id="status-a",session="session-a"):any {
 return {schemaVersion:3,graphId:id,runInstanceId:id,graphDigest:"a".repeat(64),sourceGraphSpecDigest:"b".repeat(64),status:"running",sessionId:session,supervisorEpoch:"epoch",createdAt:"2026-09-09T00:00:00.000Z",updatedAt:"2026-09-09T00:00:01.000Z",nodes:{
  active:{phase:"running",attempt:1,agent:"native-graph-child",dependsOn:[],observation:{asyncId:"child-a",observedAt:"2026-09-09T00:00:01.000Z",actualModel:"fixture/ACTUAL",progress:{currentTool:"read",currentPath:"/fixture/ACTIVITY.ts",toolCount:7,turnCount:3,lastActivityAt:"2026-09-09T00:00:00.000Z"},supervision:{activity:"active",checkedAt:"2026-09-09T00:00:01.000Z",probe:"available",runtimeLimit:"unlimited"}}},
  pending:{phase:"queued",attempt:0,dependsOn:["active"]}
 }};
}
function mountUi(){
 const widgets=new Map<string,any>(),writes:string[]=[];
 const tui={terminal:{rows:40,columns:160},requestRender(){},focusedComponent:{render(){return[];},invalidate(){},handleInput(){},getText(){return"";},setText(){}}};
 const ui:any={setStatus(){},setWidget(key:string,factory:any){writes.push(key);widgets.get(key)?.dispose?.();if(factory)widgets.set(key,factory(tui,theme));else widgets.delete(key);},onTerminalInput(){return()=>{};},getEditorText(){return"";},notify(){}};
 return{ui,widgets,writes,text(key="pi-graph",width=160){return widgets.get(key)?.render(width).join("\n")??"";},dispose(){for(const w of widgets.values())w.dispose?.();}};
}
test("real committer displays both Graph summaries, dependency reasons and no duplicate active rows; unchanged activity cannot remount",()=>{
 const a=snapshot(),b=snapshot("status-b","session-b");b.nodes.active.observation.asyncId="child-b";
 const before=JSON.stringify([a,b]),m=mountUi(),c=new V3GraphNativeUiCommitter();
 try{c.commit(m.ui,undefined,[a,b],"session-a");const rendered=m.text();
  assert.equal((rendered.match(/◆ Graph 摘要/g)??[]).length,2);assert.doesNotMatch(rendered,/status-a|status-b/);assert.match(rendered,/pending/);assert.match(rendered,/当前：active · native-graph-child\n\s+模型：fixture\/ACTUAL · 工具 read/);assert.match(rendered,/graphs/);
  assert.match(rendered,/fixture\/ACTUAL/);assert.match(rendered,/工具 read/);assert.doesNotMatch(rendered,/正在执行|ACTIVITY\.ts/);
  assert.equal((rendered.match(/当前：active · native-graph-child/g)??[]).length,2,"one owned execution row per Graph, no duplicate fleet row");
  assert.equal(m.writes.length,1);
  const changed=structuredClone(a);changed.updatedAt="2026-09-09T00:00:02.000Z";changed.nodes.active.observation.progress.toolCount=8;
  c.commit(m.ui,undefined,[changed,b],"session-a");assert.equal(m.writes.length,1,"observations invisible in summary must not remount widget");
  for(const width of [24,45,80,120])for(const line of m.widgets.get("pi-graph").render(width))assert.ok(visibleWidth(line)<=width);
  c.commit(m.ui,undefined,[a,b],"session-a",undefined,true);assert.equal(m.text(),"");
  c.commit(m.ui,undefined,[a,b],"session-a",undefined,false);assert.match(m.text(),/当前：active · native-graph-child/);
  assert.equal(JSON.stringify([a,b]),before);
 }finally{m.dispose();}
});

test("owned work providers remain isolated beside one Graph summary without duplicate fleet panels",async()=>{
 const {registerBackgroundWorkProvider,listBackgroundWorkProviders}=await jiti.import<any>('../src/runtime/background-work.ts');
 const jobs=[{id:'ordinary',sessionId:'isolated-status-ui'},{id:'child-a',sessionId:'isolated-status-ui'}];const before=JSON.stringify(jobs);
 const unregister=registerBackgroundWorkProvider({name:'fixture-other-work',listActiveWork:()=>jobs});
 const m=mountUi(),c=new V3GraphNativeUiCommitter();
 try{c.commit(m.ui,undefined,[snapshot()],'isolated-status-ui');const graph=m.text();assert.match(graph,/pending/);assert.match(graph,/当前：active · native-graph-child\n\s+模型：fixture\/ACTUAL · 工具 read/);assert.match(graph,/fixture\/ACTUAL/);assert.match(graph,/工具 read/);assert.doesNotMatch(graph,/ACTIVITY\.ts|正在执行/);assert.equal((graph.match(/当前：active · native-graph-child/g)??[]).length,1);assert.equal(m.widgets.has('subagent-fleet-status'),false);assert.equal(m.writes.length,1);assert.deepEqual(listBackgroundWorkProviders().find((p:any)=>p.name==='fixture-other-work').listActiveWork(),jobs);assert.equal(JSON.stringify(jobs),before);c.commit(m.ui,undefined,[],'another-session');assert.equal(JSON.stringify(jobs),before);}finally{unregister();m.dispose();}
});

test("real Inspector reports observed activity, escapes controls and preserves scroll/phase through stable polling",async()=>{
 const s=snapshot();s.nodes.active.observation.progress.currentTool="read\x1b[2J";s.nodes.active.observation.progress.currentPath="/fixture/ACTIVITY.ts\x1b]52;c;BAD\x07";
 const before=JSON.stringify(s);let reads=0,renders=0,closed=0,unsubscribe=0;let accept:any;
 const panel=new GraphInspector({snapshot:s,selectedId:"active",theme,rows:()=>40,requestRender(){renders++;},onClose(){closed++;},read:async()=>{reads++;return s;},subscribe(fn:any){accept=fn;return()=>unsubscribe++;},pollMs:60000});
 try{panel.handleInput("\r");const detail=panel.render(140).join("\n");
  for(const term of [/fixture\/ACTUAL/,/read/,/ACTIVITY\.ts/,/7/,/最近活动/])assert.match(detail,term);
  assert.doesNotMatch(detail,/\x1b|BAD|NaN|Infinity/);
  panel.options.rows=()=>16;panel.handleInput("j");const scrolled=panel.render(70).join("\n");
  await panel.refresh();const afterFirst=renders;await panel.refresh();assert.equal(renders,afterFirst);assert.equal(panel.render(70).join("\n"),scrolled);
  accept({...snapshot("other-graph"),updatedAt:"2030-01-01T00:00:00Z"});assert.equal(panel.render(70).join("\n"),scrolled);
  for(const width of [24,45,80])for(const line of panel.render(width))assert.ok(visibleWidth(line)<=width);
  panel.handleInput("\x1b");panel.handleInput("\x1b");assert.equal(closed,1);const stoppedReads=reads;await panel.refresh();assert.equal(reads,stoppedReads);assert.equal(unsubscribe,1);assert.equal(JSON.stringify(s),before);
 }finally{panel.dispose();}
});

for(const variant of ["missing","invalid","future","terminal"]){test(`Inspector activity ${variant} does not fabricate model or activity age, mutate phase or stop execution`,()=>{
 const s=snapshot();delete s.nodes.active.observation.actualModel;const p=s.nodes.active.observation.progress;
 if(variant==="missing")delete p.lastActivityAt;
 if(variant==="invalid")p.lastActivityAt="not-a-timestamp";
 if(variant==="future")p.lastActivityAt="2999-01-01T00:00:00Z";
 if(variant==="terminal"){s.nodes.active.phase="failed";s.nodes.active.terminalStatus="failed";}
 const before=JSON.stringify(s),panel=new GraphInspector({snapshot:s,selectedId:"active",theme,rows:()=>40,requestRender(){},onClose(){},read:async()=>s,pollMs:60000});
 try{panel.handleInput("\r");const text=panel.render(160).join("\n");assert.doesNotMatch(text,/fixture\/ACTUAL|NaN|Invalid Date|Infinity|自動停止|自动停止|卡死/);if(variant==="future")assert.doesNotMatch(text,/-\d+\s*(秒|分钟)/);assert.equal(JSON.stringify(s),before);}finally{panel.dispose();}
});}

for(const phase of ["running","failed","blocked","waiting_user","accepted","unknown"]){test(`real Inspector queued dependency identifies ${phase} evidence without guessing concurrency`,()=>{
 const s=snapshot();const n=s.nodes.active;
 if(phase==="unknown")delete s.nodes.active;
 else if(phase==="waiting_user")n.observation.supervision.attention="waiting_user";
 else {n.phase=phase;if(["failed","blocked","accepted"].includes(phase))n.terminalStatus=phase;}
 const panel=new GraphInspector({snapshot:s,selectedId:"pending",theme,rows:()=>40,requestRender(){},onClose(){},read:async()=>s,pollMs:60000});
 try{panel.handleInput("\r");const text=panel.render(160).join("\n");assert.doesNotMatch(text,/并发|名额|slot/i);
  const reason=text.split("\n").find((line:string)=>line.includes("前置任务"))??"";
  if(phase!=="accepted")assert.match(reason,/active/);
  if(phase==="failed")assert.match(reason,/失败|未通过/);
  if(phase==="blocked")assert.match(reason,/未执行|受阻|阻塞/);
  if(phase==="waiting_user")assert.match(reason,/待主 Agent 决策/);
  if(phase==="accepted")assert.match(text,/待调度|等待调度/);
 }finally{panel.dispose();}
});}

test("registered /graphs view reaches actual activity detail and preserves l/o/Esc/m safety without dispatch",async()=>{
 const root=await mkdtemp(join(tmpdir(),"graph-status-public-")),home=join(root,"agent"),s=snapshot();await mkdir(home);await mkdir(join(root,s.graphId));
 await writeFile(join(home,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:root}}));const file=join(root,s.graphId,"snapshot.json");await writeFile(file,JSON.stringify(s));
 const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=home;
 const commands=new Map<string,any>();let emits=0;
 try{register({events:{on(){return()=>{};},emit(){emits++;}},on(){},registerTool(){},registerCommand(name:string,c:any){commands.set(name,c);},sendMessage(){throw Error("unexpected message");}});
  const capture=interactionUiCapture([["\r","l","\x1b","o","\x1b","m","q"]],{stepDelayMs:10});
  await commands.get("graphs").handler("view status-a",{mode:"tui",cwd:root,sessionManager:{getSessionId:()=>"session-a",getSessionFile:()=>undefined,getEntries:()=>[]},ui:capture.ui});
  const text=capture.trace.filter(r=>r.kind==="render").map(r=>r.text).join("\n");assert.equal(capture.customCount,1,JSON.stringify(capture.trace));assert.match(text,/fixture\/ACTUAL/);assert.match(text,/ACTIVITY\.ts/);assert.match(text,/原始状态记录/);assert.equal(capture.inputCount,0);assert.equal(emits,0);assert.equal(await readFile(file,"utf8"),JSON.stringify(s));
 }finally{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});}
});


test("registered /graphs focuses one inspected Graph, counts others and reopens hidden details",async()=>{
 const root=await mkdtemp(join(tmpdir(),"graph-status-two-")),home=join(root,"agent"),a=snapshot(),b=snapshot("status-b");
 b.nodes.active.observation.actualModel="fixture/SECOND";await mkdir(home);
 for(const s of [a,b]){await mkdir(join(root,s.graphId));await writeFile(join(root,s.graphId,"snapshot.json"),JSON.stringify(s));}
 await writeFile(join(home,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:root}}));
 const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=home;
 const commands=new Map<string,any>(),m=mountUi();
 try{register({events:{on(){return()=>{};},emit(){throw Error("unexpected RPC");}},on(){},registerTool(){},registerCommand(name:string,c:any){commands.set(name,c);}});
  const capture=interactionUiCapture([["q"],["\r","q"],["\r","q"]]);Object.assign(capture.ui,{setWidget:m.ui.setWidget,setStatus:m.ui.setStatus,theme});
  const ctx={mode:"tui",cwd:root,sessionManager:{getSessionId:()=>"session-a",getSessionFile:()=>undefined,getEntries:()=>[]},ui:capture.ui};
  const call=(arg:string)=>commands.get("graphs").handler(arg,ctx);
  await call("view status-a");await call("expand");assert.match(m.text(),/当前任务（未建总计划）/);assert.match(m.text("pi-graph-agents"),/运行 分配Agent native-graph-child · 模型 fixture\/ACTUAL/);assert.match(m.text("pi-graph-agents"),/fixture\/ACTUAL/);
  await call("view status-b");assert.equal((m.text().match(/当前任务（未建总计划）/g)??[]).length,1);assert.equal((m.text("pi-graph-agents").match(/运行 分配Agent native-graph-child/g)??[]).length,2);assert.match(m.text("pi-graph-agents"),/fixture\/SECOND/);assert.match(m.text(),/其他记录1\/待处理图0/);
  await call("hide");assert.equal((m.text().match(/当前任务（未建总计划）/g)??[]).length,1);assert.match(m.text("pi-graph-agents"),/fixture\/ACTUAL/);assert.doesNotMatch(m.text("pi-graph-agents"),/fixture\/SECOND/);
  await call("view status-b");assert.match(m.text("pi-graph-agents"),/fixture\/SECOND/);assert.match(m.text(),/其他记录1/);
  const details=capture.trace.filter(r=>r.kind==="render").map(r=>r.text).join("\n");assert.match(details,/fixture\/SECOND/);assert.equal(capture.customCount,3);
  for(const s of [a,b])assert.equal(await readFile(join(root,s.graphId,"snapshot.json"),"utf8"),JSON.stringify(s));
 }finally{m.dispose();if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});}
});

for(const status of ["paused","waiting_input"]){test(`actual queued Inspector prioritizes Graph ${status} over unfinished dependencies`,()=>{
 const s=snapshot();s.status=status;
 const panel=new GraphInspector({snapshot:s,selectedId:"pending",theme,rows:()=>40,requestRender(){},onClose(){},read:async()=>s,pollMs:60000});
 try{panel.handleInput("\r");const detail=panel.render(120).join("\n");assert.match(detail,status==="paused"?/Graph 已暂停，等待恢复/:/Graph 等待输入/);assert.doesNotMatch(detail,/等待前置任务：active/);}finally{panel.dispose();}
});}

test("actual Inspector polling timer stops on dispose and silent observations never rewrite execution state",async()=>{
 const s=snapshot(),before=JSON.stringify(s);let reads=0,paints=0;
 const panel=new GraphInspector({snapshot:s,selectedId:"active",theme,rows:()=>40,requestRender(){paints++;},onClose(){},read:async()=>{reads++;return s;},pollMs:10});
 try{panel.handleInput("\r");const first=panel.render(120).join("\n");await new Promise(resolve=>setTimeout(resolve,45));assert.ok(reads>=2);const rendered=paints;await new Promise(resolve=>setTimeout(resolve,35));assert.equal(paints,rendered,"identical timer reads must not request fresh paints");assert.equal(panel.render(120).join("\n"),first);panel.dispose();const ended=reads;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(reads,ended);assert.equal(JSON.stringify(s),before);}finally{panel.dispose();}
});


test("activity lists suppress undispatched nodes, summarize missing facts once and preserve zero/time evidence",async()=>{
 const {nodeActivityLines}=await jiti.import<any>("../src/v3/ui/presentation.ts");
 for(const phase of ["queued","prepared"])assert.deepEqual(nodeActivityLines({phase,attempt:0}),[]);
 const n:any={phase:"running",observation:{asyncId:"x",observedAt:"2026-01-01T00:00:00.000Z",progress:{toolCount:0}}};
 const lines=nodeActivityLines(n,1000);
 assert.equal(lines.length,2);assert.match(lines[0],/工具调用\s+0 次/);assert.match(lines[1],/本次观测未提供/);
 assert.equal(lines.filter((line:string)=>line.includes("本次观测未提供")).length,1);
 assert.doesNotMatch(lines.join("\n"),/尚未观测到|路径|空闲|未执行|故障/);
 n.observation.progress={currentTool:"bash\x1b[2J",lastTool:"read\x1b]52;c;BAD\x07",lastToolAt:"bad-date",lastActivityAt:"2999-01-01T00:00:00Z",toolCount:0};
 const text=nodeActivityLines(n,1000).join("\n");
 assert.match(text,/最近完成工具\s+read · 时间无效，待核对/);assert.match(text,/时间晚于当前时钟，待核对/);
 assert.doesNotMatch(text,/\x1b|BAD|NaN|Invalid Date/);
 n.phase="accepted";delete n.observation.progress.currentTool;assert.doesNotMatch(nodeActivityLines(n,1000).join("\n"),/正在执行的工具|当前工具/);
 n.observation.progress.lastActivityAt="invalid";assert.match(nodeActivityLines(n,1000).join("\n"),/最近活动\s+时间无效，待核对/);
});

test("registered start/wait expanded receipts are explicit historical snapshots with live-detail entry",()=>{
 let tool:any;let emits=0;
 register({events:{on(){return()=>{};},emit(){emits++;}},on(){},registerCommand(){},registerTool(value:any){tool=value;},sendMessage(){throw Error("unexpected message");}});
 const s=snapshot();setGraphDisplayGoal(s,"fixture goal",Object.keys(s.nodes));const before=JSON.stringify(s);
 for(const action of ["start","wait"]){
  const context={args:{action},state:{},toolCallId:`snapshot-${action}`,isError:false};
  const result={content:[{type:"text",text:"historical"}],details:{snapshot:s}};
  assert.equal(tool.renderResult(result,{expanded:false,isPartial:false},theme,context).render(200).join("\n"),"","complete healthy receipts remain quiet");
  const text=tool.renderResult(result,{expanded:true,isPartial:false},theme,context).render(240).join("\n");
  assert.match(text,/回执快照/);assert.match(text,/实时图详情：\/graphs view status-a/);
  assert.match(text,/fixture\/ACTUAL/);assert.doesNotMatch(text,/ACTIVITY\.ts/);assert.match(JSON.stringify(result),/ACTIVITY\.ts/);
  const pending=text.split("\n").findIndex((line:string)=>line.includes("pending"));assert.ok(pending>=0);
 }
 assert.equal(JSON.stringify(s),before);assert.equal(emits,0);
});


test("queued Inspector detail contains waiting reason without an activity placeholder block",()=>{
 const s=snapshot();const panel=new GraphInspector({snapshot:s,selectedId:"pending",theme,rows:()=>40,requestRender(){},onClose(){},read:async()=>s,pollMs:60000});
 try{panel.handleInput("\r");const text=panel.render(200).join("\n");assert.match(text,/等待前置任务/);assert.doesNotMatch(text,/本次观测未提供|本次状态未报告|实际模型|当前工具|当前路径|工具调用|最近活动/);}finally{panel.dispose();}
});
test("registered tasks/agents/plan linked-detail roundtrip preserves tabs and cancelled history selection",async()=>{
 const root=await mkdtemp(join(tmpdir(),"graph-cockpit-tabs-")),home=join(root,"agent"),s=snapshot();await mkdir(home);await mkdir(join(root,s.graphId));await writeFile(join(root,s.graphId,"snapshot.json"),JSON.stringify(s));await writeFile(join(home,"settings.json"),JSON.stringify({graph:{enabled:true,runsDir:root}}));
 const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=home;const commands=new Map<string,any>(),tools=new Map<string,any>(),entries:any[]=[];let writes=0;
 try{register({events:{on(){return()=>{};},emit(){throw Error("unexpected runtime call");}},on(){},registerTool(t:any){tools.set(t.name,t);},registerCommand(name:string,c:any){commands.set(name,c);},appendEntry(customType:string,data:any){writes++;entries.push({id:`entry-${entries.length+1}`,type:"custom",customType,data});}});
 const capture=interactionUiCapture([["a","g"],["p"],["\r","\r"],["\x1b"],["q"]]);capture.ui.select=async()=>undefined;capture.ui.theme=theme;
 const ctx:any={mode:"tui",cwd:root,sessionManager:{getSessionId:()=>"session-a",getSessionFile:()=>undefined,getEntries:()=>entries,getBranch:()=>entries},ui:capture.ui};
 await tools.get("graph_todo").execute("set",{action:"set",expectedRevision:0,items:[{id:"goal",title:"独立总目标",status:"pending",links:[{graphId:s.graphId,runInstanceId:s.runInstanceId,taskId:"active"}]}]},undefined,undefined,ctx);
 await commands.get("graphs").handler("tasks status-a",ctx);assert.equal(capture.customCount,5);const renders=capture.trace.filter(r=>r.kind==="render").map(r=>String(r.text));assert.match(renders[2],/成员/);assert.match(renders[3],/总计划/);assert.match(renders[5],/active/);assert.match(renders.at(-1)!,/总计划/);assert.equal(writes,1);assert.equal(await readFile(join(root,s.graphId,"snapshot.json"),"utf8"),JSON.stringify(s));
 if(process.env.PI_GRAPH_RENDER_ARTIFACT_DIR){await mkdir(process.env.PI_GRAPH_RENDER_ARTIFACT_DIR,{recursive:true});await writeFile(join(process.env.PI_GRAPH_RENDER_ARTIFACT_DIR,"registered-tabs.txt"),renders.join("\n\n--- next native render ---\n\n"));}
 }finally{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});}
});
