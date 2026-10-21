import test from 'node:test';import assert from 'node:assert/strict';import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url),{terminalStack,stackTasks}=await jiti.import<any>('../src/v3/ui/terminal-stack.ts');const {visibleWidth}=await jiti.import<any>('@earendil-works/pi-tui');
const theme={fg:(_:string,t:string)=>t};
const item=(id:string,deps:string[]=[])=>({id,title:'任务'+id,status:'pending',derivedStatus:deps.length?'blocked':'in_progress',reason:deps.length?'计划前置项未完成：'+deps.join('、'):undefined,dependsOn:deps,links:[]});
const input=()=>({sessionId:'owner',snapshots:[] as any[],plan:{planId:'plan-one',items:[item('C',['A','B']),item('A'),item('B',['A'])]},expanded:true});
const graph=()=>({sessionId:'owner',graphId:'graph',runInstanceId:'run',status:'running',updatedAt:'2026-10-17T00:00:00Z',nodes:{A:{phase:'running',agent:'frontend',attempt:1,dependsOn:[],observation:{asyncId:'fixture',actualAgent:'frontend',actualModel:'official/actual',requestedModel:'SECRET_REQUESTED'}},B:{phase:'queued',agent:'reviewer',attempt:0,dependsOn:['A']},C:{phase:'queued',agent:'reviewer',attempt:0,dependsOn:['B']}}});
const link=(taskId:string)=>({graphId:'graph',runInstanceId:'run',taskId});
test('numbers precede status sorting, remain stable after updates, and multiple dependencies use only numbers',()=>{
 const i=input(),before=JSON.stringify(i),tasks=stackTasks(i);assert.deepEqual(tasks.map((t:any)=>[t.id,t.number]),[['C','#01'],['A','#02'],['B','#03']]);assert.equal(tasks[0].tail,'等待 #02、#03 完成');
 const text=terminalStack(i,120,40,theme).todo.join('\n');assert.ok(text.indexOf('#01 等待 任务C')<text.indexOf('#02 执行中 任务A'));assert.doesNotMatch(text,/计划前置项|←/);assert.equal(JSON.stringify(i),before);
 i.plan.items[1].derivedStatus='done';assert.deepEqual(stackTasks(i).map((t:any)=>t.number),['#01','#02','#03']);
});
test('exact Graph links allow multi-hop waiting without a plan reason prefix',()=>{
 const i:any=input(),s:any=graph();i.snapshots=[s];i.plan.items=['C','B','A'].map(id=>({...item(id),derivedStatus:id==='A'?'in_progress':'pending',links:[link(id)]}));
 const tasks=stackTasks(i);assert.deepEqual(tasks.map((t:any)=>t.label),['等待','等待','执行中']);assert.equal(tasks[0].tail,'等待 #02 完成');assert.equal(tasks[1].tail,'等待 #03 完成');
 s.runInstanceId='foreign';assert.ok(stackTasks(i).every((t:any)=>t.tone==='warning'));assert.ok(stackTasks(i).every((t:any)=>t.identityMissing));assert.match(terminalStack(i,120,40,theme).todo.join(''),/未关联总计划/);assert.match(terminalStack(i,120,40,theme).todo.join(''),/official\/actual/);
});
test('only failed node is red and all paused descendants cite the true failed ancestor',()=>{
 const i:any=input(),s:any=graph();s.nodes.A.phase='failed';s.nodes.B.phase='blocked';s.nodes.C.phase='blocked';i.snapshots=[s];i.plan.items=['A','B','C'].map(id=>({...item(id),derivedStatus:'blocked',links:[link(id)]}));
 const tasks=stackTasks(i);assert.deepEqual(tasks.map((t:any)=>t.label),['失败','未执行','未执行']);assert.deepEqual(tasks.map((t:any)=>t.tone),['error','muted','muted']);assert.equal(tasks[2].tail,'受阻于 #01 · 未执行');assert.doesNotMatch(tasks[2].tail,/#02 失败/);
});
test('waiting_user and running supervision errors are yellow, with no title-based login inference',()=>{
 const i:any=input(),s:any=graph();i.snapshots=[s];i.plan.items=[{...item('A'),title:'登录并确认',links:[link('A')]}];
 assert.equal(stackTasks(i)[0].label,'执行中');s.nodes.A.observation.supervision={attention:'waiting_user'};let t=stackTasks(i)[0];assert.equal(t.tone,'warning');assert.equal(t.tail,'待主 Agent 决策 · Alt+R');assert.doesNotMatch(t.tail,/登录/);
 s.nodes.A.observation.supervision={error:'fixture issue'};t=stackTasks(i)[0];assert.equal(t.tone,'warning');assert.match(t.label,/执行中/);
 s.nodes.A.phase='accepted';i.plan.items[0].derivedStatus='done';assert.equal(stackTasks(i)[0].label,'已完成 · 待核实');assert.equal(stackTasks(i)[0].tone,'warning');
});
test('manual block, missing dependency and cycles remain yellow rather than healthy waiting',()=>{
 for(const mode of ['manual','missing','cycle']){const i:any=input();if(mode==='manual')i.plan.items[1].status='blocked';if(mode==='missing')i.plan.items=i.plan.items.filter((t:any)=>t.id!=='A');if(mode==='cycle'){i.plan.items[1].derivedStatus='blocked';i.plan.items[1].dependsOn=['C'];}const t=stackTasks(i).find((t:any)=>t.id==='C');assert.equal(t.tone,'warning',mode);assert.equal(t.label,'待处理',mode);}
});
test('Graph fallback numbers original nodes and does not invent a number for an absent reference',()=>{
 const i:any={snapshots:[graph()],plan:{items:[]},expanded:true};let tasks=stackTasks(i);assert.deepEqual(tasks.map((t:any)=>t.number),['#01','#02','#03']);assert.equal(tasks[2].tail,'等待 #02 完成');
 i.snapshots[0].nodes.C.dependsOn=['missing'];tasks=stackTasks(i);assert.equal(tasks[2].tone,'warning');assert.equal(tasks[2].dependencies[0].number,undefined);
});
test('long Chinese ANSI titles wrap naturally, retain the actual model and identity on an indented row, and keep input immutable',async()=>{
 const i:any=input(),s:any=graph();i.snapshots=[s];const title='核查筛选条件在查询、重置与返回列表时是否一致，并记录现有页面与改版预览之间的差异';i.plan.items=[{...item('A'),title,links:[link('A')]}];const before=JSON.stringify(i);
 const themes=await jiti.import<any>(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js',import.meta.url).href);
 for(const palette of ['dark','light'])for(const width of [45,80,120,180])for(const height of [8,24,40]){themes.initTheme(palette,false);const view=terminalStack(i,width,height,themes.theme);assert.ok(view.todo.length+view.agents.length<=height-6);assert.ok([...view.todo,...view.agents].every((l:string)=>visibleWidth(l)<width));if(height>=24){const plain=view.todo.join('\n').replace(/\x1b\[[0-9;]*m/g,'');assert.match(plain,/@frontend · official\/actual/);assert.doesNotMatch(plain,/SECRET_REQUESTED/);if(width===45)assert.ok(view.todo.length>3,'narrow long title must wrap');}}
 assert.equal(JSON.stringify(i),before);
});
test('limited rows keep real issues ahead of ordinary tasks and explicitly show hidden count',()=>{
 const i:any=input(),s:any=graph();s.nodes.A.phase='failed';s.nodes.B.phase='running';s.nodes.B.observation={asyncId:'user',actualAgent:'reviewer',actualModel:'official/second',supervision:{attention:'waiting_user'}};i.snapshots=[s];i.plan.items=[...Array.from({length:9},(_,n)=>({...item('ready'+n),derivedStatus:'pending'})),{...item('fail'),links:[link('A')]},{...item('human'),links:[link('B')]}];
 for(const h of [8,24]){const text=terminalStack(i,80,h,theme).todo.join('\n');assert.match(text,/失败/);if(h===8){assert.match(text,/Alt\+R/);assert.ok(terminalStack(i,80,h,theme).todo.length<=h-6);}if(h===24)assert.match(text,/待主 Agent 决策/);}
});


test('a known failed ancestor remains visible alongside another uncertain dependency',()=>{
 const i:any=input(),s:any=graph();s.nodes.A.phase='failed';i.snapshots=[s];i.plan.items=[{...item('A'),derivedStatus:'blocked',links:[link('A')]},{...item('B'),derivedStatus:'unknown'},{...item('C',['A','B'])}];
 const t=stackTasks(i)[2];assert.equal(t.label,'待处理');assert.equal(t.tone,'warning');assert.match(t.tail,/#01 失败/);assert.match(t.tail,/执行条件待核实|前置任务待核实/);
});
test('cycles are conservative even through running and completed display inputs, while true failure stays red',()=>{
 for(const status of ['in_progress','done']){const i:any=input();i.plan.items=[{...item('A',['B']),derivedStatus:status},{...item('B',['A'])}];assert.ok(stackTasks(i).every((t:any)=>t.tone==='warning'));}
 const s:any=graph();s.nodes.A.dependsOn=['B'];const i:any={sessionId:'owner',snapshots:[s],plan:{items:[]},expanded:true};assert.ok(stackTasks(i).slice(0,2).every((t:any)=>t.tone==='warning'));s.nodes.A.phase='failed';assert.equal(stackTasks(i)[0].tone,'error');
});
test('source snapshot never-dispatched proof cannot turn into red when linked to a plan',async()=>{
 const {setDisplayEvidence}=await jiti.import<any>('../src/v3/ui/presentation.ts');const s:any=graph();s.nodes.A.phase='failed';setDisplayEvidence(s,{neverDispatched:new Set(['A']),failures:{A:'Graph failed fast before this node started.'}});const i:any=input();i.snapshots=[s];i.plan.items=[{...item('A'),derivedStatus:'blocked',links:[link('A')]}];assert.notEqual(stackTasks(i)[0].tone,'error');assert.equal(stackTasks(i)[0].identities[0].phase,'not_started');
});


test('two-row task body preserves an explicit detail pointer when identity occupies the remaining line',()=>{
 const s:any=graph();s.nodes.A.phase='queued';s.nodes.A.dependsOn=['unmapped'];const i:any=input();i.snapshots=[s];i.plan.items=[{...item('A'),derivedStatus:'pending',links:[link('A')]}];const text=terminalStack(i,120,10,theme).todo.join('\n');assert.match(text,/待处理/);assert.match(text,/Alt\+R/);assert.match(text,/@frontend/);
});


test('ambiguous Graph dependency mappings never receive another item number',()=>{
 const i:any=input(),s:any=graph();i.snapshots=[s];i.plan.items=[{...item('one'),links:[link('A')]},{...item('two'),links:[link('A')]},{...item('next'),derivedStatus:'pending',links:[link('B')]}];const next=stackTasks(i)[2];assert.equal(next.dependencies[0].number,undefined);assert.equal(next.tone,'warning');
});
test('truncated dependency tails explicitly point to details instead of silently dropping numbers',()=>{
 const i:any=input();const rest=Array.from({length:40},(_,n)=>({...item('d'+n),derivedStatus:'pending'}));i.plan.items=[{...item('current',rest.map(t=>t.id)),title:'核查汇总'},...rest];const lines=terminalStack(i,45,40,theme).todo;assert.ok(lines.some((l:string)=>l.includes('Alt+Shift+T')));assert.match(lines.join(''),/等待/);assert.ok(lines.length<=40-6);
});


test('missing dependency cannot hide a known failure root or erase it farther downstream',()=>{
 const i:any=input(),s:any=graph();s.nodes.A.phase='failed';i.snapshots=[s];i.plan.items=[{...item('A'),derivedStatus:'blocked',links:[link('A')]},{...item('C',['A','missing'])},{...item('D',['C'])}];
 const tasks=stackTasks(i);for(const t of tasks.slice(1)){assert.equal(t.label,'待处理');assert.equal(t.tone,'warning');assert.match(t.tail,/前置 #01 失败/);assert.match(t.tail,/执行条件待核实/);assert.equal(t.failedNumbers,undefined);}assert.equal(tasks[1].dependencies[1].number,undefined);
});

test('tree preorder has hierarchical numbers, leaf totals, and shared group fold keeps summary',()=>{const i:any={sessionId:'owner',snapshots:[],expanded:true,plan:{goal:'完成配送方案',items:[{id:'g',title:'产品规划',status:'pending',derivedStatus:'in_progress',source:'分组汇总',links:[],rollup:{total:2,done:1,manualDone:1,running:1,waiting:0,blocked:0,unknown:0}},{id:'a',parentId:'g',title:'需求梳理',status:'done',derivedStatus:'done',source:'人工',links:[]},{id:'b',parentId:'g',title:'交互方案',status:'pending',derivedStatus:'in_progress',source:'人工',links:[]}]}};i.expandedCompletedGroupIds=new Set(['g']);const before=JSON.stringify(i),rows=terminalStack(i,120,40,theme).todo.join('\n');assert.match(rows,/完成配送方案/);assert.match(rows,/#1\.1/);assert.match(rows,/#1\.2/);assert.match(rows,/1\/2/);assert.doesNotMatch(rows,/1\/3/);i.foldedIds=new Set(['g']);const folded=terminalStack(i,120,40,theme).todo.join('\n');assert.match(folded,/产品规划/);assert.doesNotMatch(folded,/需求梳理|交互方案/);delete i.foldedIds;assert.equal(JSON.stringify(i),before);});

test('tree right column, ancestry and exact identities survive narrow urgency and group fold',()=>{const s:any=graph();s.nodes.A.phase='failed';const i:any={sessionId:'owner',snapshots:[s],expanded:true,plan:{goal:'整体目标',items:[{id:'g',title:'分组',status:'pending',derivedStatus:'blocked',source:'分组汇总',links:[]},...Array.from({length:12},(_,n)=>({...item('p'+n),parentId:'g',derivedStatus:'pending',title:'普通事项'+n})),{...item('critical'),parentId:'g',derivedStatus:'blocked',links:[link('A')],title:'真实错误'}]}};const before=JSON.stringify(i);for(const width of [45,80,120,180])for(const height of [8,24,40]){const out=terminalStack(i,width,height,theme);assert.ok(out.todo.length+out.agents.length<=height-6);assert.ok(out.todo.every((l:string)=>visibleWidth(l)<width));assert.match(out.todo.join('\n'),/失败|异常/);assert.match(out.todo.join('\n'),/Alt\+/);if(height>=24)assert.match(out.todo.join('\n'),/分组/);}i.foldedIds=new Set(['g']);const folded=terminalStack(i,120,40,theme).todo.join('\n');assert.match(folded,/失败/);assert.match(folded,/真实错误/);assert.equal(stackTasks(i).find((t:any)=>t.id==='critical').tone,'error');delete i.foldedIds;assert.equal(JSON.stringify(i),before);});


test('wrapped Chinese title finishes before actual identity and short budgets keep identity or details',()=>{const i:any=input(),s:any=graph();i.snapshots=[s];const title='核对筛选交互体验和查询重置结果';i.plan.items=[{...item('A'),title,links:[link('A')]}];const rows=terminalStack(i,45,40,theme).todo;const identity=rows.findIndex((r:string)=>r.includes('@frontend'));assert.ok(identity>1);const start=rows.findIndex((r:string)=>r.includes('#01 运行'));const prior=rows.slice(start,identity).join('').replace(/\s/g,'').replace(/#01|运行/g,'');assert.equal(prior,title);const treeIdentity=rows.findLastIndex((r:string)=>r.includes('@frontend'));assert.ok(treeIdentity>=identity);for(const height of [7,8,10]){const out=terminalStack(i,45,height,theme);assert.ok(out.todo.length+out.agents.length<=height-6);assert.match(out.todo.join(''),/actual|Alt\+R/);}});


test('completed history collapses without hiding real errors or renumbering and explicit bucket opens',()=>{const items:any[]=[{id:'g',title:'主组',status:'pending',derivedStatus:'in_progress',links:[],source:'分组汇总'},...Array.from({length:10},(_,n)=>({id:'d'+n,parentId:'g',title:'旧完成'+n,status:'done',derivedStatus:'done',links:[],source:'人工'})),{id:'live',parentId:'g',title:'当前工作',status:'in_progress',derivedStatus:'in_progress',links:[],source:'人工'},{id:'bad',parentId:'g',title:'完成但证据未知',status:'done',derivedStatus:'done',links:[{graphId:'missing',runInstanceId:'missing',taskId:'x'}],source:'Graph验收'}];const i:any={sessionId:'owner',snapshots:[],plan:{goal:'交付',items},expanded:true};let text=terminalStack(i,120,24,theme).todo.join('');assert.match(text,/已完成 11\/12/);assert.match(text,/当前工作/);assert.match(text,/完成但证据未知|待核实/);assert.match(text,/旧完成0/);const numbers=stackTasks(i).map((t:any)=>t.number);i.recentCompletedIds=['d8','d9'];text=terminalStack(i,120,40,theme).todo.join('');assert.match(text,/旧完成8|旧完成9/);i.expandedCompletedGroupIds=new Set(['g']);assert.match(terminalStack(i,120,40,theme).todo.join(''),/旧完成0/);assert.deepEqual(stackTasks(i).map((t:any)=>t.number),numbers);i.plan.items=items.slice(0,11);delete i.expandedCompletedGroupIds;text=terminalStack(i,120,40,theme).todo.join('');assert.match(text,/已完成 10\/10/);assert.match(text,/旧完成0/);assert.ok(terminalStack(i,120,40,theme).todo.length>1);});


test('failed leaf stays red while all ancestor summaries remain warning and unsafe done stays visible',()=>{const s:any=graph();s.nodes.A.phase='failed';const i:any={sessionId:'owner',snapshots:[s],expanded:true,plan:{items:[{id:'outer',title:'外层',status:'pending',derivedStatus:'blocked',links:[]},{id:'inner',parentId:'outer',title:'内层',status:'pending',derivedStatus:'blocked',links:[]},{id:'bad',parentId:'inner',title:'真正失败',status:'done',derivedStatus:'done',links:[link('A')]},{id:'uncertain',parentId:'inner',title:'完成待核实',status:'done',derivedStatus:'done',links:[{graphId:'absent',runInstanceId:'x',taskId:'x'}]}]}};const ts=stackTasks(i);for(const t of ts.filter((t:any)=>t.group)){assert.equal(t.tone,'warning');assert.equal(t.critical,true);assert.equal(t.hasError,true);}assert.equal(ts.find((t:any)=>t.id==='bad').tone,'error');const text=terminalStack(i,120,40,theme).todo.join('');assert.match(text,/真正失败/);assert.match(text,/完成待核实/);assert.doesNotMatch(text,/已完成 2 项/);});


test('all-safe completed plan condenses only Todo and preserves unrelated live roster and parent',()=>{const s:any=graph();s.nodes={A:s.nodes.A};s.nodes.A.observation.actualAgent='live-worker';s.nodes.A.observation.actualModel='wr/live-model';const i:any={sessionId:'owner',snapshots:[s],expanded:true,parent:{active:true,sessionId:'owner'},plan:{goal:'旧计划',items:[{id:'old',title:'旧完成事项',status:'done',derivedStatus:'done',source:'人工',links:[]}]}};const before=JSON.stringify(i);for(const width of [45,120]){const out=terminalStack(i,width,24,theme);assert.ok(out.todo.length>1);assert.match(out.todo[0],/已完成 1\/1/);assert.match(out.todo.join(''),/旧完成事项/);assert.match(out.agents.join(''),/live-worker/);assert.match(out.agents.join(''),/wr\/live-model|live-model/);assert.ok(out.todo.length+out.agents.length<=18);assert.doesNotMatch(out.todo[0],/live-model/);}assert.equal(JSON.stringify(i),before);i.snapshots=[];assert.match(terminalStack(i,120,24,theme).agents.join(''),/@main/);i.parent.active=false;const noLive=terminalStack(i,120,24,theme);assert.ok(noLive.todo.length>1);assert.match(noLive.todo.join(''),/旧完成事项/);assert.deepEqual(noLive.agents,[]);});
