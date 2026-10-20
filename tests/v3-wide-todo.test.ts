import assert from "node:assert/strict";
import test from "node:test";
import {createJiti} from "jiti";
// Wide-screen todo stack acceptance: tree lines with stable numbering, adjacent status,
// project/Agent/model metadata rows, mutually exclusive overview counts, folded-group
// summaries, executing highlight distinct from focus, bounded height and ANSI safety.
// Fixture text renders only; no terminal screenshot claims.
const jiti=createJiti(import.meta.url);
const {terminalStack,stackTasks,leafStatusStats,formatLeafStats,TODO_READING_CAP}=await jiti.import<any>("../src/v3/ui/terminal-stack.ts");
const {PlanInspector}=await jiti.import<any>("../src/v3/ui/plan-inspector.ts");
const {setDisplayEvidence}=await jiti.import<any>("../src/v3/ui/presentation.ts");
const {visibleWidth}=await jiti.import<any>("@earendil-works/pi-tui");
const theme={fg:(_c:string,s:string)=>s,bold:(s:string)=>s,strikethrough:(s:string)=>s};
const NOW="2026-01-01T00:00:01.000Z";
const link=(graph:string,taskId:string)=>({graphId:graph,runInstanceId:graph,taskId});
function node(phase:string,o:any={}):any{
 const n:any={phase,attempt:phase==="queued"?0:1,...(o.agent?{agent:o.agent}:{}),dependsOn:o.dependsOn??[]};
 if(o.observation)n.observation={asyncId:`async-${phase}`,observedAt:NOW,...o.observation};
 return n;
}
const activeSupervision=(extra:any={})=>({activity:"active",checkedAt:NOW,runtimeLimit:"unlimited",...extra});
function snap(id:string,nodes:any,project?:string):any{
 const s:any={schemaVersion:3,graphId:id,runInstanceId:id,graphDigest:"a".repeat(64),sourceGraphSpecDigest:"b".repeat(64),status:"running",sessionId:"stack-session",createdAt:NOW,updatedAt:NOW,nodes};
 // Display evidence is the only honest project source: the identity-checked authorization's sourceCwd basename, never the viewer's cwd.
 setDisplayEvidence(s,{failures:{},neverDispatched:new Set(),...(project?{project}:{})});
 return s;
}
function group(id:string,title:string):any{
 return {id,title,status:"pending",derivedStatus:"pending",links:[],dependsOn:[],source:"分组汇总"};
}
function item(id:string,title:string,o:any={}):any{
 return {id,title,status:o.status??"pending",derivedStatus:o.derivedStatus??o.status??"pending",links:o.links??[],dependsOn:o.dependsOn??[],source:o.source??"Graph验收",...(o.assignee?{assignee:o.assignee}:{}) ,...(o.parentId?{parentId:o.parentId}:{})};
}
const input=(over:any={}):any=>({snapshots:[],plan:{revision:1,items:[],persistence:"memory"},expanded:true,sessionId:"stack-session",...over});
const todoText=(out:any)=>out.todo.join("\n");

/** Mockup-shaped fixture: goal → groups → leaves, real bound project, mixed states. */
function wideFixture(){
 const g=snap("g-wide",{
  a:node("accepted",{observation:{actualAgent:"code-scout",actualModel:"wisdomrouter/glm-5.3-flash"}}),
  b:node("accepted",{observation:{actualAgent:"code-scout",actualModel:"wisdomrouter/glm-5.3-flash"}}),
  c:node("running",{observation:{actualAgent:"backend-developer",actualModel:"wisdomrouter/glm-5.3",supervision:activeSupervision()}}),
  d:node("queued",{dependsOn:["c"],agent:"backend-developer",observation:{resolvedAgent:"backend-developer",resolvedModel:"wisdomrouter/glm-5.3"}}),
  e:node("queued",{dependsOn:["d"],agent:"backend-developer",observation:{resolvedAgent:"backend-developer",resolvedModel:"wisdomrouter/glm-5.3"}}),
  f:node("queued",{dependsOn:["e"],agent:"reviewer",observation:{resolvedAgent:"reviewer",resolvedModel:"wisdomrouter/glm-5.3"}}),
  x:node("queued",{dependsOn:["f"],agent:"qa",observation:{resolvedAgent:"qa",requestedModel:"wisdomrouter/glm-5.3"}}),
 },"example-project");
 const items=[
  group("g1","核对接入条件"),
  item("l1","核对历史接入证据",{status:"done",derivedStatus:"done",links:[link("g-wide","a")],parentId:"g1"}),
  item("l2","核对目标项目源码与配置",{status:"done",derivedStatus:"done",links:[link("g-wide","b")],parentId:"g1"}),
  item("l3","确认平台身份与登录契约",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-wide","c")],parentId:"g1"}),
  group("g2","实施基础数据接入"),
  item("l4","核对登录接入配置与环境差异",{dependsOn:["l3"],links:[link("g-wide","d")],parentId:"g2"}),
  item("l5","实现登录接入与必要的异常处理",{dependsOn:["l4"],links:[link("g-wide","e")],parentId:"g2"}),
  group("g3","验证与交付"),
  item("l6","独立审查",{dependsOn:["l5"],links:[link("g-wide","f")],parentId:"g3"}),
  item("l7","交付汇总",{dependsOn:["l6"],links:[link("g-wide","x")],parentId:"g3"}),
 ];
 return input({snapshots:[g],plan:{revision:1,goal:"完成基础数据平台登录接入",items,persistence:"memory"}});
}

test("wide 160/240: tree lines, adjacent status, one metadata row, exclusive overview counts, adaptive width",()=>{
 const inp=wideFixture(),before=JSON.stringify(inp);
 for(const w of [160,240]){
  const out=terminalStack(inp,w,40,theme),todo=todoText(out);
  assert.match(todo,/总目标 · 完成基础数据平台登录接入 · 已完成 2\/7 · 执行中 1 · 等待依赖 4/,`exclusive overview at w${w}`);
  assert.match(todo,/Alt\+T 收起/);
  assert.match(todo,/▾ #1 核对接入条件 已完成 2\/3 · 执行中 1/,"group rollup counts descendant leaves, never the group itself");
  assert.match(todo,/ {2}│ ├─ #1\.1 已完成 核对历史接入证据/,"ancestor continuation bar plus a real ├─ connector for a non-last sibling");
  assert.match(todo,/ {2}│ └─ #1\.3 执行中 确认平台身份与登录契约/,"the last sibling properly ends with └─");
  assert.match(todo,/ {4}└─ #3\.2 等待 交付汇总/,"a last root group's last child draws no ancestor bar");
  assert.match(todo,/项目 example-project · @code-scout · wisdomrouter\/glm-5\.3-flash/,"one metadata row: project · Agent · actual model");
  assert.match(todo,/项目 example-project · @backend-developer · wisdomrouter\/glm-5\.3/);
  assert.match(todo,/项目 example-project · 分配@backend-developer · 〔计划〕wisdomrouter\/glm-5\.3/,"planned model stays labelled");
  assert.match(todo,/等待 #1\.3 完成/,"dependency cause keeps its own short row");
  assert.match(todo,/├─ #3\.1 等待 独立审查/);
  assert.doesNotMatch(todo,/另\d+项/,"no repeated fabricated omission count inside rows");
  for(const line of [...out.todo,...out.agents]){
   assert.ok(visibleWidth(line)<=w-1,`reading area capped at w${w}: ${JSON.stringify(line)}`);
   assert.ok(visibleWidth(line)<=w);
  }
 }
 assert.equal(JSON.stringify(inp),before,"rendering never mutates the plan or snapshots");
});

test("expanded keeps completed leaves in place next to running siblings; folding never renumbers",()=>{
 const inp=wideFixture();
 const out=todoText(terminalStack(inp,160,40,theme));
 const i1=out.indexOf("#1.1 已完成 核对历史接入证据"),i3=out.indexOf("#1.3 执行中 确认平台身份与登录契约");
 assert.ok(i1>=0&&i3>i1,"completed leaves keep their original position");
 const folded=todoText(terminalStack({...inp,foldedIds:new Set(["g2"])},160,40,theme));
 assert.match(folded,/▸ #2 实施基础数据接入 已完成 0\/2 · 等待依赖 2/,"manual fold keeps the aggregate row");
 assert.doesNotMatch(folded,/#2\.1 等待/,"folded leaves hide");
 assert.match(folded,/#3\.1 等待 独立审查/,"numbering after the folded group is unchanged");
 assert.match(folded,/已完成 2\/7 · 执行中 1 · 等待依赖 4/,"folding never changes the totals");
});

test("folded group keeps a summary of hidden exceptions with an accurate count; healthy running stays in the rollup only",()=>{
 const g=snap("g-fold",{
  r1:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M1",supervision:activeSupervision()}}),
  r2:node("running",{observation:{actualAgent:"qa",actualModel:"fixture/M2",supervision:activeSupervision()}}),
  bad:node("failed",{observation:{actualAgent:"reviewer",actualModel:"fixture/M3",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"review role unconfirmed"}}}),
  warn:node("running",{observation:{actualAgent:"qa",actualModel:"fixture/M4",supervision:activeSupervision({error:"probe exploded"})}}),
  free:node("queued",{}),
 },"basic-data");
 const items=[
  group("g1","验证与交付"),
  item("l1","联调核对",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-fold","r1")],parentId:"g1"}),
  item("l2","回归核对",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-fold","r2")],parentId:"g1"}),
  item("l3","独立审查",{links:[link("g-fold","bad")],parentId:"g1"}),
  item("l5","探针异常",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-fold","warn")],parentId:"g1"}),
  item("l4","组外任务",{links:[link("g-fold","free")]}),
 ];
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"},foldedIds:new Set(["g1"])}),before=JSON.stringify(inp);
 const out=todoText(terminalStack(inp,160,40,theme));
 assert.match(out,/▸ #1 验证与交付 已完成 0\/4 · 失败 1 · 待处理 1 · 执行中 2/,"folded group row keeps the mutually exclusive rollup, exceptions leading");
 assert.match(out,/⚠ #1\.3 独立审查 · 失败 · 等 2 项需关注 · 组内 4 项已折叠 · Alt\+Shift\+T 详情/,"real exceptions keep an accurate folded count");
 assert.equal([...out.matchAll(/⚠/g)].length,1,"healthy running leaves are never listed as ⚠ exceptions");
 assert.doesNotMatch(out,/联调核对|回归核对/,"healthy hidden running work stays in the rollup counts, not the alert");
 assert.match(out,/#2 就绪 组外任务/,"numbering outside the folded group is unchanged");
 assert.equal(JSON.stringify(inp),before);
 // Without exception work a folded group needs no summary row, but the rollup stays.
 const quiet=input({snapshots:[g],plan:{revision:1,items:[group("h1","等待组"),item("w1","等待中",{dependsOn:["l4"],links:[link("g-fold","free")],parentId:"h1"}),item("l4","组外任务",{links:[link("g-fold","free")]})],persistence:"memory"},foldedIds:new Set(["h1"])});
 const quietOut=todoText(terminalStack(quiet,160,40,theme));
 assert.doesNotMatch(quietOut,/⚠/,"no fabricated alert for a quiet folded group");
 assert.match(quietOut,/▸ #1 等待组 已完成 0\/1 · 等待依赖 1/);
 // A folded group with only healthy running work gets the same honest treatment: no ⚠, rollup keeps 执行中.
 const runningOnly=input({snapshots:[g],plan:{revision:1,items:[group("h2","执行组"),item("w2","健康执行",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-fold","r1")],parentId:"h2"}),item("l4","组外任务",{links:[link("g-fold","free")]})],persistence:"memory"},foldedIds:new Set(["h2"])});
 const runningOut=todoText(terminalStack(runningOnly,160,40,theme));
 assert.doesNotMatch(runningOut,/⚠/,"healthy running alone never raises an exception alert");
 assert.match(runningOut,/▸ #1 执行组 已完成 0\/1 · 执行中 1/,"the rollup still reports the hidden running work");
});

test("one accurate omission count with the existing detail entry; rows never repeat 另N项",()=>{
 const nodes:any={},items:any[]=[group("g1","批量任务")];
 for(let i=0;i<10;i++){
  nodes[`n${i}`]=node("queued",{});
  items.push(item(`l${i}`,`任务${i}`,{links:[link("g-many",`n${i}`)],parentId:"g1"}));
 }
 const g=snap("g-many",nodes,"basic-data");
 for(const expanded of [true,false]){
  const out=terminalStack(input({snapshots:[g],plan:{revision:1,items,persistence:"memory"},expanded}),80,expanded?24:24,theme),todo=todoText(out);
  const counts=[...todo.matchAll(/另 (\d+) 项 ·/g)].map(m=>Number(m[1]));
  assert.ok(counts.length<=1,`at most one omission count, expanded=${expanded}: ${JSON.stringify(counts)}`);
  if(counts.length)assert.match(todo,/Alt\+Shift\+T|Alt\+T 展开/,"the count keeps the existing detail entry");
 }
});

test("overview buckets are mutually exclusive and sum to the leaf total; completed-with-doubt stays completed",()=>{
 const g=snap("g-stats",{
  done:node("accepted",{observation:{actualAgent:"backend",actualModel:"fixture/M0"}}),
  doubt:node("accepted",{observation:{actualAgent:"qa",actualModel:"fixture/M9",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"exit evidence missing"}}}),
  run:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M1",supervision:activeSupervision()}}),
  next:node("queued",{dependsOn:["run"]}),
  free:node("queued",{}),
  bad:node("failed",{observation:{actualAgent:"reviewer",actualModel:"fixture/M2",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"boom"}}}),
  warn:node("running",{observation:{actualAgent:"qa",actualModel:"fixture/M3",supervision:activeSupervision({error:"probe exploded"})}}),
  skip:node("skipped",{}),
 },"basic-data");
 const items=[
  item("p1","完成项",{status:"done",derivedStatus:"done",links:[link("g-stats","done")]}),
  item("p2","存疑完成项",{status:"done",derivedStatus:"done",links:[link("g-stats","doubt")]}),
  item("p3","执行项",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-stats","run")]}),
  item("p4","等待项",{dependsOn:["p3"],links:[link("g-stats","next")]}),
  item("p5","就绪项",{links:[link("g-stats","free")]}),
  item("p6","失败项",{links:[link("g-stats","bad")]}),
  item("p7","异常执行项",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-stats","warn")]}),
  item("p8","跳过项",{links:[link("g-stats","skip")]}),
 ];
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}}),before=JSON.stringify(inp);
 const tasks=stackTasks(inp),leaves=tasks.filter((t:any)=>!t.group);
 const stats=leafStatusStats(leaves);
 assert.equal(stats.done+stats.failed+stats.attention+stats.running+stats.waiting+stats.ready+stats.inactive+stats.todo,stats.total,"buckets are mutually exclusive and exhaustive");
 assert.equal(stats.total,8);
 assert.deepEqual({done:stats.done,failed:stats.failed,attention:stats.attention,running:stats.running,waiting:stats.waiting,ready:stats.ready,inactive:stats.inactive,todo:stats.todo,doubt:stats.doubt},{done:2,failed:1,attention:1,running:1,waiting:1,ready:1,inactive:1,todo:0,doubt:1});
 const overview=formatLeafStats(stats);
 assert.equal(overview,"已完成 2/8 · 失败 1 · 待处理 1 · 其中待核实 1 · 执行中 1 · 等待依赖 1 · 就绪 1 · 未执行 1");
 const todo=todoText(terminalStack(inp,160,40,theme));
 assert.match(todo,/总计划 · 已完成 2\/8 · 失败 1 · 待处理 1 · 其中待核实 1 · 执行中 1 · 等待依赖 1 · 就绪 1 · 未执行 1/);
 assert.match(todo,/#02 已完成 · 待核实 存疑完成项/,"completed-with-doubt still counts as completed, never as failed");
 assert.match(todo,/#04 等待 等待项/,"a waiting dependency is its own bucket, never failure");
 assert.match(todo,/#08 已跳过 跳过项/,"skipped/cancelled/not_started are their own terminal bucket, never 待办");
 assert.equal(JSON.stringify(inp),before);
});

test("project identity comes from bound display evidence and is honestly unbound when absent",()=>{
 const bound=snap("g-bound",{a:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M1",supervision:activeSupervision()}})},"basic-data");
 const plain=snap("g-plain",{a:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M1",supervision:activeSupervision()}})});
 const items=[item("p1","绑定项目任务",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-bound","a")]}),item("p2","未绑定项目任务",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-plain","a")]})];
 const out=todoText(terminalStack(input({snapshots:[bound,plain],plan:{revision:1,items,persistence:"memory"}}),160,40,theme));
 assert.match(out,/项目 basic-data · @backend · fixture\/M1/);
 assert.match(out,/项目 未绑定 · @backend · fixture\/M1/,"missing binding is stated, never the viewer cwd or a fabricated name");
 assert.doesNotMatch(out,/graph-runs|workspace|shadow/,"the tool's own working directory never impersonates the business project");
});

test("executing highlight uses the theme semantic background, capped and distinct from focus; stub themes stay compatible",()=>{
 const inp=wideFixture(),before=JSON.stringify(inp);
 const bgCalls:string[]=[];
 const bgTheme={fg:(_c:string,s:string)=>s,bold:(s:string)=>s,strikethrough:(s:string)=>s,bg:(color:string,s:string)=>{bgCalls.push(color);return `\x1b[7m${s}\x1b[27m`;}};
 const out=terminalStack(inp,240,40,bgTheme as any);
 assert.ok(bgCalls.length>0,"executing rows are highlighted when the theme offers bg");
 assert.ok(bgCalls.every(c=>c==="customMessageBg"),`highlight stays on the message semantic, never selection/focus: ${JSON.stringify([...new Set(bgCalls)])}`);
 const highlighted=out.todo.filter((l:string)=>l.includes("\x1b[7m"));
 assert.ok(highlighted.length>=1,"combined title and identity executing row is highlighted");
 for(const line of highlighted)assert.equal(visibleWidth(line),239,"highlight pads to the capped reading width, not the full terminal");
 assert.ok(highlighted.some((l:string)=>l.includes("#1.3 执行中 确认平台身份与登录契约")));
 // A theme stub without bg (the old contract) renders the same text with no highlight.
 const plain=terminalStack(inp,240,40,theme);
 assert.equal(todoText(plain).replace(/ +$/gm,""),todoText(out).replace(/\x1b\[7m|\x1b\[27m/g,"").replace(/ +$/gm,""),"optional bg never changes the content");
 assert.ok(plain.todo.every((l:string)=>visibleWidth(l)<=239));
 assert.equal(JSON.stringify(inp),before);
});

test("narrow 80/45/24 wrap/truncate keeps number, status and tree lines; deep indent compresses behind an ellipsis",()=>{
 const nodes:any={r:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M1",supervision:activeSupervision()}})};
 const items=[
  group("a","一级分组"),
  group("b","二级分组"),
  group("c","三级分组"),
  group("d","四级分组"),
  item("leaf","深层叶任务",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-deep","r")],parentId:"d"}),
  // Siblings keep every ancestor off the last-child edge so continuation bars render.
  item("b2","二级后续",{parentId:"a"}),
  item("c2","三级后续",{parentId:"b"}),
  item("d2","四级后续",{parentId:"c"}),
  item("z","根级后续",{}),
 ];
 items[1].parentId="a";items[2].parentId="b";items[3].parentId="c";
 const g=snap("g-deep",nodes,"basic-data");
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}}),before=JSON.stringify(inp);
 for(const w of [80,45,24])for(const h of [24,40]){
  const out=terminalStack(inp,w,h,theme),todo=todoText(out);
  assert.match(todo,/#1\.1\.1\.1\.1 执行中/,`number and status survive at w${w} h${h}`);
  assert.match(todo,/[├└]─/,`a real tree connector survives at w${w} h${h}`);
  for(const line of [...out.todo,...out.agents])assert.ok(visibleWidth(line)<=w,`width w${w} h${h}: ${JSON.stringify(line)}`);
 }
 const compressed=todoText(terminalStack(inp,45,40,theme));
 assert.match(compressed,/…/,"deep indent compresses behind an ellipsis at 45 columns");
 const wide=todoText(terminalStack(inp,160,40,theme));
 assert.match(wide,/ {2}│ │ │ │ └─ #1\.1\.1\.1\.1 执行中 深层叶任务/,"full ancestor bars plus the last-sibling └─ render when width allows");
 assert.match(wide,/项目 basic-data · @backend · fixture\/M1/);
 assert.equal(JSON.stringify(inp),before);
});

test("height stays bounded with input space reserved at 8/24/40/60 rows",()=>{
 const inp=wideFixture(),before=JSON.stringify(inp);
 for(const h of [8,24,40,60])for(const expanded of [true,false]){
  const out=terminalStack({...inp,expanded},160,h,theme);
  assert.ok(out.todo.length+out.agents.length<=Math.max(0,Math.min(expanded?24:8,h-6)),`row budget h${h} expanded=${expanded}`);
 }
 // An explicit reservation (editor draft lines) further shrinks the widget.
 const reserved=terminalStack({...inp,reservedRows:30},160,40,theme);
 assert.ok(reserved.todo.length+reserved.agents.length<=10,"reserved input rows are honored");
 assert.equal(JSON.stringify(inp),before);
});

test("ANSI/control bytes in titles, roles, models and project evidence never leak; rows stay within width",()=>{
 const g=snap("g-ansi",{
  a:node("running",{observation:{actualAgent:"backend\x1b[2J",actualModel:"fixture/\x1b]52;c;BAD\x07MODEL",supervision:activeSupervision()}}),
 },"bad\x1b[31m-project");
 const items=[group("g1","\x1b[31m分组"),item("p1",`\x1b[31m${"长".repeat(120)}`,{status:"in_progress",derivedStatus:"in_progress",links:[link("g-ansi","a")],parentId:"g1"})];
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}}),before=JSON.stringify(inp);
 for(const w of [24,45,80,160])for(const line of [...terminalStack(inp,w,24,theme).todo,...terminalStack(inp,w,24,theme).agents]){
  assert.doesNotMatch(line,/\x1b\[31m|\x1b\[2J|\x1b\]52|BAD/,`input control bytes leaked: ${JSON.stringify(line)}`);
  assert.ok(visibleWidth(line)<=w);
 }
 assert.equal(JSON.stringify(inp),before);
});

test("existing operations survive in the new layout: Alt+T toggle hint, Alt+Shift+T detail entry, Alt+R exception entry",()=>{
 const g=snap("g-keys",{
  bad:node("running",{observation:{actualAgent:"worker",actualModel:"fixture/MQ",supervision:activeSupervision({attention:"waiting_user",error:"probe exploded"})}}),
 },"basic-data");
 const items=[item("p1","决策请求任务",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-keys","bad")]})];
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}});
 const expanded=todoText(terminalStack({...inp,expanded:true},80,24,theme));
 assert.match(expanded,/Alt\+T 收起/);
 assert.match(expanded,/异常：probe exploded · Alt\+R/,"exception reason row keeps the existing detail entry");
 const collapsed=todoText(terminalStack({...inp,expanded:false},80,24,theme));
 assert.match(collapsed,/已收起 · Alt\+T 展开/);
 assert.match(collapsed,/Alt\+R/);
 // The one-row degradation keeps an accurate count plus the detail entry instead of a per-row repetition.
 const g2=snap("g-keys2",{a:node("running",{observation:{actualAgent:"qa",actualModel:"fixture/M1",supervision:activeSupervision()}}),b:node("queued",{})});
 const two=input({snapshots:[g2],plan:{revision:1,items:[item("p1","一",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-keys2","a")]}),item("p2","二",{links:[link("g-keys2","b")]})],persistence:"memory"},expanded:true});
 const single=todoText(terminalStack(two,80,7,{...theme}));
 assert.match(single,/另1项 · Alt\+R/,"the single cramped row carries the one accurate count and the detail entry");
});

test("completed titles are never struck through, even when the theme offers strikethrough",()=>{
 const inp=wideFixture(),before=JSON.stringify(inp);
 const marked={fg:(_c:string,s:string)=>s,bold:(s:string)=>s,strikethrough:(s:string)=>`\x1b[9m${s}\x1b[29m`};
 for(const w of [80,160]){
  const out=todoText(terminalStack(inp,w,40,marked));
  assert.match(out,/#1\.1 已完成 核对历史接入证据/,`completed leaf stays in place at w${w}`);
  assert.doesNotMatch(out,/\x1b\[9m/,"approved design: a finished title is shown in place, never struck through");
 }
 assert.equal(JSON.stringify(inp),before);
});

test("folded group surfaces completed-with-doubt as a real exception: rollup, critical state and ⚠ summary all keep it",()=>{
 const g=snap("g-doubt",{
  ok:node("accepted",{observation:{actualAgent:"backend",actualModel:"fixture/M1"}}),
  doubt:node("accepted",{observation:{actualAgent:"qa",actualModel:"fixture/M2",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"exit evidence missing"}}}),
  run:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M3",supervision:activeSupervision()}}),
 },"basic-data");
 const items=[
  group("g1","交付组"),
  item("l1","正常完成",{status:"done",derivedStatus:"done",links:[link("g-doubt","ok")],parentId:"g1"}),
  item("l2","存疑完成",{status:"done",derivedStatus:"done",links:[link("g-doubt","doubt")],parentId:"g1"}),
  item("l3","健康执行",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-doubt","run")],parentId:"g1"}),
 ];
 // The doubt feeds the group's exception state even though no leaf failed or needs attention.
 const groupRow=stackTasks(input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}})).find((t:any)=>t.id==="g1");
 assert.equal(groupRow.critical,true,"stats.doubt feeds the group exception state");
 assert.equal(groupRow.tone,"warning");
 assert.match(groupRow.label,/已完成 2\/3 · 其中待核实 1 · 执行中 1/);
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"},foldedIds:new Set(["g1"])}),before=JSON.stringify(inp);
 for(const w of [160,80]){
  const folded=todoText(terminalStack(inp,w,40,theme));
  assert.match(folded,/▸ #1 交付组 已完成 2\/3 · 其中待核实 1 · 执行中 1/,`folded rollup keeps the doubt count at w${w}`);
  assert.match(folded,/⚠ #1\.2 存疑完成/,`the doubt leaf keeps a real ⚠ exception summary at w${w}`);
  assert.match(folded,/组内 3 项已折叠 · Alt\+Shift\+T 详情/,`accurate folded count with the detail entry at w${w}`);
  assert.equal([...folded.matchAll(/⚠/g)].length,1,`healthy running is never flagged ⚠ at w${w}`);
  assert.doesNotMatch(folded,/健康执行/,`healthy hidden running work is not listed as an exception at w${w}`);
 }
 // Narrow: the summary and rollup truncate gracefully but the exception itself is never dropped.
 const narrow=todoText(terminalStack(inp,45,40,theme));
 assert.match(narrow,/▸ #1 交付组 已完成 2\/3/);
 assert.match(narrow,/⚠ #1\.2 存疑完成/);
 assert.match(narrow,/其中待核/,"the doubt annotation keeps a recognizable share at w45");
 assert.equal([...narrow.matchAll(/⚠/g)].length,1);
 assert.doesNotMatch(narrow,/健康执行/);
 assert.equal(JSON.stringify(inp),before);
});

test("a long goal yields first: status/exception counts and the detail entry survive at 80/45/24 columns",()=>{
 const inp=wideFixture();
 inp.plan={...inp.plan,goal:"非常".repeat(60)+"冗长的总目标标题"};
 for(const expanded of [true,false]){
  for(const w of [80,45,24]){
   const todo=todoText(terminalStack({...inp,expanded},w,24,theme));
   assert.match(todo,/完成 2\/7/,`completion fraction survives at w${w} expanded=${expanded}`);
   assert.match(todo,/Alt\+T/,`detail entry survives at w${w} expanded=${expanded}`);
   for(const line of [...terminalStack({...inp,expanded},w,24,theme).todo])assert.ok(visibleWidth(line)<=w);
  }
  for(const w of [80,45])assert.match(todoText(terminalStack({...inp,expanded},w,24,theme)),/执行中 1/,`running count survives at w${w} expanded=${expanded}`);
  assert.match(todoText(terminalStack({...inp,expanded},80,24,theme)),/总目标 · 非常/,`a recognizable goal share survives at w80 expanded=${expanded}`);
 }
});

function allBucketsFixture(goal?:string){
 const g=snap("g-all",{
  done:node("accepted",{observation:{actualAgent:"backend",actualModel:"fixture/M0"}}),
  doubt:node("accepted",{observation:{actualAgent:"qa",actualModel:"fixture/M9",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"exit evidence missing"}}}),
  run:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M1",supervision:activeSupervision()}}),
  next:node("queued",{dependsOn:["run"]}),
  free:node("queued",{}),
  bad:node("failed",{observation:{actualAgent:"reviewer",actualModel:"fixture/M2",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"boom"}}}),
  warn:node("running",{observation:{actualAgent:"qa",actualModel:"fixture/M3",supervision:activeSupervision({error:"probe exploded"})}}),
  skip:node("skipped",{}),
 },"basic-data");
 const items=[
  item("p1","完成项",{status:"done",derivedStatus:"done",links:[link("g-all","done")]}),
  item("p2","存疑完成项",{status:"done",derivedStatus:"done",links:[link("g-all","doubt")]}),
  item("p3","执行项",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-all","run")]}),
  item("p4","等待项",{dependsOn:["p3"],links:[link("g-all","next")]}),
  item("p5","就绪项",{links:[link("g-all","free")]}),
  item("p6","失败项",{links:[link("g-all","bad")]}),
  item("p7","异常执行项",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-all","warn")]}),
  item("p8","跳过项",{links:[link("g-all","skip")]}),
 ];
 return input({snapshots:[g],plan:{revision:1,...(goal?{goal}:{}),items,persistence:"memory"}});
}

test("80 columns with every bucket non-zero and a long goal: exception counts lead and the Alt+T entry keeps an explicit share",()=>{
 const inp=allBucketsFixture("非常".repeat(60)+"冗长的总目标标题"),before=JSON.stringify(inp);
 for(const w of [160,240]){
  const full=todoText(terminalStack(inp,w,40,theme));
  assert.match(full,/总目标 · 非常/,`a recognizable goal share survives when width allows at w${w}`);
  assert.match(full,/已完成 2\/8 · 失败 1 · 待处理 1 · 其中待核实 1 · 执行中 1 · 等待依赖 1 · 就绪 1 · 未执行 1/,`mutually exclusive full classification unchanged at w${w}; exceptions lead, never trailing into truncation`);
 }
 for(const expanded of [true,false]){
  const out=terminalStack({...inp,expanded},80,24,theme),todo=todoText(out);
  assert.match(todo,/需关注 3 · 完成 2\/8/,`the orthogonal aggregate pair survives at w80 expanded=${expanded} (focus total 3 = 失败1+待处理1+待核实1 and may overlap completion)`);
  assert.doesNotMatch(todo,/其他|-\d/,`no derived 其他 remainder and never a negative count at w80 expanded=${expanded}`);
  assert.match(todo,/Alt\+T/,`detail entry survives at w80 expanded=${expanded}`);
  for(const line of out.todo)assert.ok(visibleWidth(line)<=80,`width w80 expanded=${expanded}: ${JSON.stringify(line)}`);
 }
 assert.equal(JSON.stringify(inp),before);
});

test("45/24-column degradation keeps the orthogonal focus/completion pair and never overflows",()=>{
 const inp=allBucketsFixture(),before=JSON.stringify(inp);
 for(const expanded of [true,false])for(const w of [45,24]){
  const out=terminalStack({...inp,expanded},w,24,theme),todo=todoText(out);
  assert.match(todo,w===45?/需关注 3 · 完成 2\/8/:/关注3 完2\/8/,`complete aggregate pair at w${w} expanded=${expanded} — never a half-cut field`);
  assert.doesNotMatch(todo,/其他|-\d/,`no 其他 remainder or negative count at w${w} expanded=${expanded}`);
  assert.match(todo,/Alt\+T/,`detail entry at w${w} expanded=${expanded}`);
  if(w===24)assert.equal(out.todo[0],expanded?"关注3 完2/8  Alt+T 收起":"关注3 完2/8  Alt+T 展开",`exact whole 24-column overview string expanded=${expanded}: focus count, completion fraction and Alt+T all complete`);
  for(const line of [...out.todo,...out.agents])assert.ok(visibleWidth(line)<=w,`width w${w} expanded=${expanded}: ${JSON.stringify(line)}`);
 }
 assert.equal(JSON.stringify(inp),before);
});

test("doubt overlapping completion can never yield a negative remainder: 6 doubtful completions plus 6 other buckets aggregate as orthogonal dimensions",()=>{
 const doubtSpec=()=>({observation:{actualAgent:"qa",actualModel:"fixture/M9",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"exit evidence missing"}}});
 const g=snap("g-overlap",{
  d1:node("accepted",doubtSpec()),d2:node("accepted",doubtSpec()),d3:node("accepted",doubtSpec()),
  d4:node("accepted",doubtSpec()),d5:node("accepted",doubtSpec()),d6:node("accepted",doubtSpec()),
  run:node("running",{observation:{actualAgent:"backend",actualModel:"fixture/M1",supervision:activeSupervision()}}),
  next:node("queued",{dependsOn:["run"]}),
  free:node("queued",{}),
  bad:node("failed",{observation:{actualAgent:"reviewer",actualModel:"fixture/M2",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"boom"}}}),
  warn:node("running",{observation:{actualAgent:"qa",actualModel:"fixture/M3",supervision:activeSupervision({error:"probe exploded"})}}),
  skip:node("skipped",{}),
 },"basic-data");
 const items=[
  ...[1,2,3,4,5,6].map(i=>item(`d${i}`,`存疑完成${i}`,{status:"done",derivedStatus:"done",links:[link("g-overlap",`d${i}`)]})),
  item("p6","失败项",{links:[link("g-overlap","bad")]}),
  item("p7","异常执行项",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-overlap","warn")]}),
  item("p3","执行项",{status:"in_progress",derivedStatus:"in_progress",links:[link("g-overlap","run")]}),
  item("p4","等待项",{dependsOn:["p3"],links:[link("g-overlap","next")]}),
  item("p5","就绪项",{links:[link("g-overlap","free")]}),
  item("p8","未执行项",{links:[link("g-overlap","skip")]}),
 ];
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}}),before=JSON.stringify(inp);
 const stats=leafStatusStats(stackTasks(inp).filter((t:any)=>!t.group));
 assert.equal(stats.total,12);
 assert.equal(stats.done,6);
 assert.equal(stats.doubt,6,"doubt is a subset of done");
 assert.equal(stats.failed+stats.attention+stats.doubt,8,"focus total = 6 doubt + 1 failed + 1 attention");
 // done(6) + focus(8) = 14 > total(12): any exclusive-bucket remainder arithmetic would produce -2.
 for(const expanded of [true,false]){
  const out=terminalStack({...inp,expanded},80,24,theme),todo=todoText(out);
  assert.match(todo,/需关注 8 · 完成 6\/12/,`orthogonal aggregate at w80 expanded=${expanded}; the focus count overlaps completion`);
  assert.doesNotMatch(todo,/其他|-\d/,`no remainder copy and no negative count at w80 expanded=${expanded}`);
  for(const line of out.todo)assert.ok(visibleWidth(line)<=80,`width w80 expanded=${expanded}: ${JSON.stringify(line)}`);
 }
 assert.equal(JSON.stringify(inp),before);
});

test("multi-digit counts stay width-safe: 128 doubtful completions keep the completion fraction and Alt+T inside every width",()=>{
 const nodes:any={},items:any[]=[];
 for(let i=1;i<=128;i++){
  nodes[`d${i}`]=node("accepted",{observation:{actualAgent:"qa",actualModel:"fixture/M9",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"exit evidence missing"}}});
  items.push(item(`d${i}`,`存疑完成${i}`,{status:"done",derivedStatus:"done",links:[link("g-big",`d${i}`)]}));
 }
 const g=snap("g-big",nodes,"basic-data");
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}}),before=JSON.stringify(inp);
 for(const expanded of [true,false])for(const w of [24,45,80,160]){
  const out=terminalStack({...inp,expanded},w,24,theme),todo=todoText(out);
  assert.match(todo,/完成 128\/128|完128\/128/,`completion fraction survives at w${w} expanded=${expanded}`);
  assert.match(todo,/Alt\+T/,`detail entry survives at w${w} expanded=${expanded}`);
  for(const line of [...out.todo,...out.agents])assert.ok(visibleWidth(line)<=w,`width w${w} expanded=${expanded}: ${JSON.stringify(line)}`);
 }
 assert.equal(JSON.stringify(inp),before);
});

test("未执行 with an uncertain dependency counts once in the inactive bucket; its warning stays an explicit subset annotation",()=>{
 const g=snap("g-uncertain",{
  bad:node("failed",{observation:{actualAgent:"backend",actualModel:"fixture/MX",supervision:{activity:"terminal",checkedAt:NOW,runtimeLimit:"unlimited",error:"disk exploded"}}}),
  // An authoritative blocked phase whose second Graph dependency is unresolvable: blocked-not-executed stays truthful, the uncertainty stays visible.
  down:node("blocked",{dependsOn:["bad","ghost"]}),
 },"basic-data");
 const items=[
  item("p1","失败前置",{links:[link("g-uncertain","bad")]}),
  item("p2","下游未执行",{dependsOn:["p1"],links:[link("g-uncertain","down")]}),
 ];
 const inp=input({snapshots:[g],plan:{revision:1,items,persistence:"memory"}}),before=JSON.stringify(inp);
 const leaves=stackTasks(inp).filter((t:any)=>!t.group),down=leaves.find((t:any)=>t.id==="p2");
 assert.equal(down.label,"未执行","the truthful blocked-not-executed label is kept");
 assert.equal(down.tone,"warning","the uncertain dependency keeps the warning tone on the row");
 const stats=leafStatusStats(leaves);
 assert.equal(stats.inactive,1,"the 未执行 leaf counts in the inactive bucket");
 assert.equal(stats.attention,0,"the same leaf is never double-counted as attention");
 assert.equal(stats.failed,1);
 assert.equal(stats.doubt,1,"its warning survives as the explicit subset annotation");
 assert.equal(stats.done+stats.failed+stats.attention+stats.running+stats.waiting+stats.ready+stats.inactive+stats.todo,stats.total,"buckets stay mutually exclusive and exhaustive");
 const todo=todoText(terminalStack(inp,160,40,theme));
 assert.match(todo,/已完成 0\/2 · 失败 1 · 其中待核实 1 · 未执行 1/,"the overview keeps both the inactive truth and the exception annotation");
 assert.match(todo,/#02 未执行 下游未执行/);
 assert.match(todo,/另有依赖待核实/,"the uncertainty cause keeps its own visible row");
 assert.equal(JSON.stringify(inp),before);
});