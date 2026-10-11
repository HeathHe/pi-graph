import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, mkdir, writeFile, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
const alias: Record<string,string> = {};
for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
 const id=`@earendil-works/${name}`;const dir=resolve(`node_modules/${id}`);
 const pkg=JSON.parse(readFileSync(join(dir,"package.json"),"utf8"));
 alias[id]=join(dir,pkg.exports?.["."]?.import ?? pkg.main);
 for (const [key,value] of Object.entries(pkg.exports ?? {})) {
  if (key === "." || key.includes("*")) continue;
  const target=typeof value === "string" ? value : (value as {import?:string}).import;
  if (target) alias[id+key.slice(1)]=join(dir,target);
 }
}
const jiti=createJiti(import.meta.url,{alias});

const { GraphInspector } = jiti("../src/v3/ui/inspector.ts") as any;
const { compactGraphLines, counts, graphLabel, setDisplayEvidence, nodeReason, nodeNextStep, safeText } = jiti("../src/v3/ui/presentation.ts") as any;
const { readGraphView } = jiti("../src/v3/ui/read-view.ts") as any;
const { visibleWidth } = jiti("@earendil-works/pi-tui") as any;
const theme = { fg: (_: string,s: string) => `\x1b[36m${s}\x1b[39m`, bg: (_: string,s: string) => `\x1b[44m${s}\x1b[49m`, bold: (s: string) => s };
function snapshot(): any {
 return { schemaVersion:3, graphId:"ui-check", runInstanceId:"ui-check", graphDigest:"a".repeat(64), sourceGraphSpecDigest:"b".repeat(64), status:"running", sessionId:"ui-session", supervisorEpoch:"epoch", createdAt:"2026-09-09T00:00:00.000Z", updatedAt:"2026-09-09T00:00:01.000Z", nodes:{
  research:{phase:"failed", terminalStatus:"failed",attempt:1,observation:{asyncId:"child-1",observedAt:"2026-09-09T00:00:01.000Z",supervision:{activity:"terminal", checkedAt:"2026-09-09T00:00:01.000Z", probe:"unreachable", runtimeLimit:"unlimited",error:'API error (402): You have run out of credits or need a Grok subscription.'}}},
  worker:{phase:"running",attempt:1,observation:{asyncId:"child-2",observedAt:"2026-09-09T00:00:01.000Z",actualModel:"test/模型",supervision:{activity:"active",checkedAt:"2026-09-09T00:00:01.000Z",probe:"available",runtimeLimit:"unlimited",health:"responsive",phase:"receiving"}}},
  queued:{phase:"queued",attempt:0}, blocked:{phase:"blocked",terminalStatus:"blocked",attempt:0},
 }};
}
test("native display separates failures, blocked work, and evidenced stop intent", () => {
 const s = snapshot();
 assert.equal(counts(s), "运行 1 · 失败 1 · 未执行 1 · 排队 1");
 const running = compactGraphLines(s).join("\n");
 assert.match(running, /Graph 摘要/);
 assert.doesNotMatch(running, /正在执行 worker/);
 assert.doesNotMatch(running, /HTTP 402|原因/);
 assert.equal(graphLabel(s), "部分失败，其余继续");
 s.status = "failed"; s.nodes.worker = {phase:"aborted",terminalStatus:"aborted",attempt:1}; s.nodes.queued = {phase:"aborted",terminalStatus:"aborted",attempt:0};
 assert.match(compactGraphLines(s).join("\n"), /HTTP 402/);
 assert.equal(graphLabel(s), "未完成");
 setDisplayEvidence(s,{stopRequested:true,failures:{},neverDispatched:new Set(["queued"])});
 assert.equal(graphLabel(s), "已停止 · 含 1 项失败");
 assert.equal(nodeReason(s,"queued",s.nodes.queued), "停止前尚未派发");
 assert.equal(safeText("\x1b]52;c;BAD\x07你好\x1b[2J"), "你好");
});
test("stopped summary and inspector preserve the missing-result cause over generic abort evidence", () => {
 const s=snapshot();s.status="stopped";
 const n=s.nodes.worker;n.phase="aborted";n.terminalStatus="aborted";
 n.observation.progress={state:"complete"};
 Object.assign(n.observation.supervision,{health:"exited",processExitConfirmed:true,attention:"result_unavailable",error:"Runner exited without a durable final result; reconciliation required."});
 s.nodes={worker:n};
 setDisplayEvidence(s,{stopRequested:true,failures:{worker:"Aborted: V3 child monitoring aborted"},neverDispatched:new Set()});
 const before=JSON.stringify(s);
 assert.match(compactGraphLines(s).join("\n"),/已停止[\s\S]*缺少最终结果，尚未验收/);
 assert.doesNotMatch(nodeReason(s,"worker",n),/停止，进程退出已确认|monitoring aborted/);
 assert.match(nodeNextStep(s,"worker",n),/核对运行器兼容性和已有结果/);
 const panel=new GraphInspector({snapshot:s,theme,rows:()=>40,requestRender(){},onClose(){},read:async()=>s,subscribe(){return()=>{};},pollMs:60000});
 panel.handleInput("\r");assert.match(panel.render(120).join("\n"),/缺少最终结果，尚未验收/);panel.handleInput("q");
 assert.equal(JSON.stringify(s),before,"rendering must not rewrite historical execution evidence");
 delete n.observation.supervision.error;n.observation.supervision.attention="storage_error";
 assert.match(nodeReason(s,"worker",n),/已停止；停止前：状态保存异常/);
 delete n.observation.supervision.attention;
 assert.equal(nodeReason(s,"worker",n),"停止，进程退出已确认");
});
test("runtime compatibility failure is explained as a child that never started", () => {
 const s=snapshot();
 setDisplayEvidence(s,{failures:{research:"V3 child was not dispatched: pi-subagents runtime incompatible: installed 0.67.0"},neverDispatched:new Set()});
 assert.equal(nodeReason(s,"research",s.nodes.research),"运行器不兼容，子任务未启动");
 assert.match(nodeNextStep(s,"research",s.nodes.research),/所需公开能力/);
});
test("native inspector handles narrow terminals, scroll, navigation, live changes and cleanup", async () => {
 let accept: any, unsubscribe = 0, closed = 0, reads = 0;
 const s = snapshot(); let current = s;
 const panel = new GraphInspector({ snapshot:s,theme,rows:()=>24,requestRender(){},onClose(){closed++;},read:async()=>{reads++; return current;},subscribe(fn:any){accept=fn;return()=>unsubscribe++;},pollMs:60000 });
 for(const [w,h] of [[80,24],[100,30],[120,40],[45,15],[24,8]]) {
  panel.options.rows=()=>h;
  for (const key of ["", "\r", "l", "\x1b[6~", "\x1b", "\x1b"]) {
   if(key) panel.handleInput(key);
   const lines = panel.render(w);
   assert.ok(lines.length<=h-2);
   for(const line of lines) assert.ok(visibleWidth(line)<=w,`${w}: ${line}`);
  }
 }
 panel.options.rows=()=>24;
 panel.handleInput("\x1b[200~q\x1b[201~"); assert.equal(closed,0);
 panel.handleInput("j"); panel.handleInput("\r");
 assert.match(panel.render(100).join("\n"),/worker/);
 current = structuredClone(s); current.updatedAt="2026-09-09T00:00:02.000Z"; current.nodes.worker.phase="accepted"; current.nodes.worker.terminalStatus="accepted";
 accept(current); assert.match(panel.render(100).join("\n"),/成功/);
 accept(s); assert.match(panel.render(100).join("\n"),/成功/);
 panel.handleInput("q"); assert.equal(closed,1); assert.equal(unsubscribe,1);
 await panel.refresh(); assert.equal(reads,0,"closed panel cannot continue polling");
 assert.equal(s.nodes.worker.phase,"running","closing a view must not mutate execution state");
});
test("read-only viewer rejects symlinks and wrong identities without creating control files", async () => {
 const root = await mkdtemp(join(tmpdir(),"graph-view-")); await mkdir(join(root,"ui-check"));
 const s = snapshot(); await writeFile(join(root,"ui-check","snapshot.json"),JSON.stringify(s));
 const view=await readGraphView(root,"ui-check"); assert.equal(view.graphId,"ui-check");
 assert.deepEqual(await readdir(join(root,"ui-check")),["snapshot.json"]);
 await assert.rejects(readGraphView(root,"../outside"),/Invalid graph ID/);
 await symlink(join(root,"ui-check"),join(root,"linked"));
 await assert.rejects(readGraphView(root,"linked"),/regular directory/);
});
test("Graph tool cards keep receipts separate from live status and identify unexecuted calls", async () => {
 const {default:register}=await jiti.import("../extensions/pi-graph.ts") as any;
 const events=new Map(); let tool:any;
 register({ events:{on(){return()=>{};},emit(){}},on(name:string,handler:any){events.set(name,handler);},registerCommand(){},registerTool(t:any){tool=t;} });
 const s=snapshot(), identityTheme={...theme,bold:(s:string)=>s};
 function render(action:string, details:any, partial:boolean) {
  const args={action,id:s.graphId};const state={};const ctx={args,state,toolCallId:action,executionStarted:true,isPartial:partial,isError:false,invalidate(){}};
  const call=tool.renderCall(args,identityTheme,ctx);
  const body=tool.renderResult({content:[],details},{isPartial:partial,expanded:false},identityTheme,ctx);
  return [...call.render(160),...body.render(160)].join("\n");
 }
 assert.equal(tool.renderShell,"self");
 const start=render("start",s,false);assert.match(start,/已提交/);assert.doesNotMatch(start,/排队|失败 1|graphs view/);
 const wait=render("wait",s,true);assert.match(wait,/正在等待结果/);assert.doesNotMatch(wait,/排队|失败 1|graphs view/);
 assert.match(render("wait",{snapshot:s,graphContinuesRunning:true},false),/已结束查看，任务继续运行/);
 events.get("message_end")({message:{role:"assistant",stopReason:"error",content:[{type:"toolCall",id:"never-started",name:"graph"}]}});
 const ctx={args:{action:"start",spec:{graphId:"never-started"}},state:{},toolCallId:"never-started",executionStarted:false,isPartial:false,isError:true};
 const call=tool.renderCall(ctx.args,identityTheme,ctx);
 const error=tool.renderResult({content:[{type:"text",text:"Error Code request_timeout: stream closed before response.completed"}]},{expanded:false,isPartial:false},identityTheme,ctx);
 const text=[...call.render(160),...error.render(160)].join("\n");
 assert.match(text,/未执行 · 主 Agent 响应中断/);assert.match(text,/本次指令未执行/);assert.doesNotMatch(text,/执行失败|额度/);
});

test("settled summary groups matching causes and separates fail-fast work using durable evidence", async () => {
 const s=snapshot();s.status="failed";
 s.nodes={
  business:{phase:"failed",terminalStatus:"failed",attempt:1},
  first:s.nodes.research, second:structuredClone(s.nodes.research),
  done:{phase:"accepted",terminalStatus:"accepted",attempt:1},
  blocked:{phase:"blocked",terminalStatus:"blocked",attempt:0},
  blocked2:{phase:"blocked",terminalStatus:"blocked",attempt:0},
  blocked3:{phase:"blocked",terminalStatus:"blocked",attempt:0},
 };
 const root=await mkdtemp(join(tmpdir(),"graph-summary-"));const dir=join(root,s.graphId);
 await mkdir(join(dir,"nodes/business/attempts/1"),{recursive:true});
 await writeFile(join(dir,"snapshot.json"),JSON.stringify(s));
 const attempt:any={schemaVersion:1,runInstanceId:s.runInstanceId,graphId:s.graphId,taskId:"business",attempt:1,attemptNonce:"nonce-1",supervisorEpoch:"epoch",phase:"failed",terminalStatus:"failed",createdAt:s.createdAt,updatedAt:s.updatedAt,failure:{kind:"internal",message:"Graph failed fast before this node started.",at:s.updatedAt}};
 await writeFile(join(dir,"nodes/business/attempts/1/attempt.json"),JSON.stringify(attempt));
 const view=await readGraphView(root,s.graphId);
 assert.equal(counts(view),"成功 1 · 失败 2 · 未执行 4");
 const text=compactGraphLines(view).join("\n");
 assert.equal(compactGraphLines(view).length,3);assert.equal(text.match(/HTTP 402/g)?.length,1);
 assert.match(text,/原因（2 项）/);assert.doesNotMatch(text,/failed fast|business|受阻|失败 3/);
 assert.equal(view.nodes.business.phase,"failed","presentation must retain stored execution status");
 assert.equal(counts(s),"成功 1 · 失败 3 · 未执行 3","missing evidence must not silently erase a failure");
 const panel=new GraphInspector({snapshot:view,theme,rows:()=>30,requestRender(){},onClose(){},read:async()=>view});
 panel.handleInput("\r");const detail=panel.render(120).join("\n");
 assert.match(detail,/first/);assert.match(detail,/下一步/);assert.doesNotMatch(detail,/run out of credits/);
 panel.handleInput("l");assert.match(panel.render(120).join("\n"),/原始状态记录/);panel.dispose();
 attempt.dispatchIntent={requestId:"request",requestDigest:"a".repeat(64),state:"emitting",preparedAt:s.createdAt,emittedAt:s.createdAt};
 await writeFile(join(dir,"nodes/business/attempts/1/attempt.json"),JSON.stringify(attempt));
 assert.equal(counts(await readGraphView(root,s.graphId)),"成功 1 · 失败 3 · 未执行 3");
});

test("running summary keeps nonactive needs_attention visible over stale terminated failures", () => {
 const s=snapshot();
 s.nodes.research.observation.supervision.error="API error (500): request timeout after 600000 ms (request_timeout)";
 s.nodes.review={phase:"needs_attention",terminalStatus:"needs_attention",attempt:1,observation:{asyncId:"child-3",observedAt:s.updatedAt,supervision:{activity:"terminal",checkedAt:s.updatedAt,probe:"unreachable",runtimeLimit:"unlimited",error:"HTTP 402: You have run out of credits."}}};
 const running=compactGraphLines(s).join("\n");
 assert.match(running,/部分失败，其余继续/);
 assert.match(running,/失败 1/);assert.match(running,/待处理 1/);
 assert.doesNotMatch(running,/正在执行 worker/,"native fleet owns executing child rows");
 assert.match(running,/原因（1 项）：HTTP 402：额度或订阅不可用/,"unresolved needs_attention stays visible even while another task runs");
 assert.doesNotMatch(running,/600000|模型连接中断/,"stale terminated failure must not steal the limited reason slot");
 assert.equal(s.nodes.research.phase,"failed","presentation must not rewrite stored execution status");
 assert.equal(s.nodes.review.terminalStatus,"needs_attention");
 const panel=new GraphInspector({snapshot:s,theme,rows:()=>30,requestRender(){},onClose(){},read:async()=>s,subscribe(){return()=>{};},pollMs:60000});
 panel.handleInput("\r");assert.match(panel.render(120).join("\n"),/模型连接中断，未收到完整结果/);
 panel.handleInput("l");assert.match(panel.render(120).join("\n"),/600000/);panel.dispose();
 s.status="failed";s.nodes.worker={phase:"aborted",terminalStatus:"aborted",attempt:1};s.nodes.queued={phase:"aborted",terminalStatus:"aborted",attempt:0};
 const settled=compactGraphLines(s).join("\n");
 assert.match(settled,/原因（1 项）：模型连接中断，未收到完整结果/);
 assert.match(settled,/HTTP 402：额度或订阅不可用/);
});

test("running summary keeps live attention and recent errors of the active task visible", () => {
 const s=snapshot();
 s.nodes.research.observation.supervision.error="API error (500): request timeout after 600000 ms (request_timeout)";
 s.nodes.worker.observation.supervision.attention="result_unavailable";
 const attention=compactGraphLines(s).join("\n");
 assert.match(attention,/Graph 摘要/);
 assert.doesNotMatch(attention,/正在执行 worker/);
 assert.match(attention,/原因（1 项）：子任务已结束，但缺少最终结果，尚未验收/);
 assert.doesNotMatch(attention,/600000|模型连接中断/);
 delete s.nodes.worker.observation.supervision.attention;
 setDisplayEvidence(s,{failures:{worker:"HTTP 429: rate limit exceeded"},neverDispatched:new Set()});
 const retrying=compactGraphLines(s).join("\n");
 assert.match(retrying,/原因（1 项）：最近异常：HTTP 429：请求受限，查看服务返回详情/);
 assert.doesNotMatch(retrying,/600000|模型连接中断|正在执行 worker/);
 assert.equal(s.nodes.research.terminalStatus,"failed");
});

test("hidden summary restores through the same mounted Graph widget", async () => {
 const {V3GraphNativeUiCommitter}=await jiti.import("../extensions/pi-graph.ts") as any;
 let component:any;
 const ui={setStatus(){},setWidget(_key:string,f:any){component?.dispose();component=f?.({},theme);}};
 const c=new V3GraphNativeUiCommitter(),s=snapshot();
 c.commit(ui,undefined,[s],"ui-session",undefined,true);
 assert.deepEqual(component.render(100),[]);
 c.commit(ui,undefined,[s],"ui-session",undefined,false);
 const restored=component.render(100).join("\n");
 assert.match(restored,/Graph 摘要/);assert.doesNotMatch(restored,/正在执行 worker/);assert.doesNotMatch(restored,/HTTP 402/);component.dispose();
});

test("native Graph summary follows unfinished runs and clears after terminal history reads", async () => {
 const {V3GraphLiveUiProjection,V3GraphNativeUiCommitter,graphNativeLiveSnapshotsV3}=await jiti.import("../extensions/pi-graph.ts") as any;
 const terminalStatuses=["complete","failed","stopped","idle"];
 for(const status of ["queued","running","stopping","paused","waiting_input","needs_attention"]) {
  const candidate=snapshot();candidate.status=status;
  assert.equal(graphNativeLiveSnapshotsV3([candidate]).length,1,`${status} remains visible until the Graph ends`);
 }
 for(const terminalStatus of terminalStatuses) {
  const projection=new V3GraphLiveUiProjection();
  const committer=new V3GraphNativeUiCommitter();
  let component:any, statusText:string|undefined;
  const ui={setStatus(_key:string,text:string|undefined){statusText=text;},setWidget(_key:string,f:any){component?.dispose();component=f?.({},theme);}};
  const running=snapshot();
  projection.project(running);
  let live=graphNativeLiveSnapshotsV3(projection.values());
  assert.equal(live.length,1);
  committer.commit(ui,"Graph running",live);
  assert.match(component.render(100).join("\n"),/Graph/);

  // Manual hide still suppresses the mounted summary until it is reopened.
  committer.commit(ui,"Graph running",live,undefined,undefined,true);
  assert.deepEqual(component.render(100),[]);
  committer.commit(ui,"Graph running",live,undefined,undefined,false);
  assert.match(component.render(100).join("\n"),/Graph/);

  const waiting=structuredClone(running);
  waiting.status="waiting_input";
  waiting.updatedAt="2026-09-09T00:00:02.000Z";
  projection.project(waiting);
  live=graphNativeLiveSnapshotsV3(projection.values());
  assert.equal(live.length,1,"waiting for input is not a finished Graph");
  committer.commit(ui,undefined,live);
  assert.ok(component);

  const finished=structuredClone(waiting);
  finished.status=terminalStatus;
  finished.updatedAt="2026-09-09T00:00:03.000Z";
  projection.project(finished);
  live=graphNativeLiveSnapshotsV3(projection.values());
  assert.deepEqual(live,[],`${terminalStatus} must leave the live summary`);
  committer.commit(ui,undefined,live);
  assert.equal(component,undefined,`${terminalStatus} must clear the widget`);
  assert.equal(statusText,undefined,`${terminalStatus} must clear the status line`);

  projection.project(finished,{preserveExistingOnTie:true});
  assert.deepEqual(graphNativeLiveSnapshotsV3(projection.values()),[],"reading history must not remount the summary");
  assert.equal(projection.get(finished.graphId)?.status,terminalStatus,"history remains inspectable");
 }
});

test("auth failures remain historical while current local records update independently", async () => {
 const {localAuthLines,nodeNextStep}=jiti("../src/v3/ui/presentation.ts") as any;
 const root=await mkdtemp(join(tmpdir(),"graph-auth-view-")), agentDir=join(root,"agent");
 await mkdir(agentDir);await mkdir(join(root,"ui-check"));
 const s=snapshot();s.status="failed";s.nodes={research:s.nodes.research};s.nodes.research.observation.actualModel="xai/grok-test";
 s.nodes.research.observation.supervision.error="OAuth refresh failed for xai: invalid_grant: Invalid or unknown refresh token";
 await writeFile(join(root,"ui-check/snapshot.json"),JSON.stringify(s));
 const authFile=join(agentDir,"auth.json");
 const saved={xai:{type:"oauth",access:"SECRET_ACCESS",refresh:"SECRET_REFRESH",expires:1},other:{type:"api_key",key:"SECRET_OTHER"}};
 await writeFile(authFile,JSON.stringify(saved));
 const before=readFileSync(authFile,"utf8"), view=await readGraphView(root,"ui-check",agentDir);
 assert.equal(nodeReason(view,"research",view.nodes.research),"当次执行时登录凭据失效");
 assert.match(localAuthLines(view,"research",view.nodes.research).join("\n"),/已保存登录凭据和续期凭据；当前有效性未验证/);
 assert.doesNotMatch(nodeNextStep(view,"research",view.nodes.research),/^重新登录/);
 assert.equal(readFileSync(authFile,"utf8"),before,"view must not refresh or rewrite credentials, even when access is expired");
 assert.deepEqual(view,s,"credentials and display metadata never enter the persisted/RPC snapshot");
 const panel=new GraphInspector({snapshot:view,theme,rows:()=>40,requestRender(){},onClose(){},read:()=>readGraphView(root,"ui-check",agentDir)});
 panel.handleInput("\r");assert.match(panel.render(120).join("\n"),/历史任务记录/);
 assert.match(panel.render(120).join("\n"),/本机当前登录记录（xai）/);
 assert.doesNotMatch(panel.render(120).join("\n"),/SECRET_|登录时间|此后.*更新/);
 await writeFile(authFile,JSON.stringify({other:saved.other}));
 await panel.refresh();assert.match(panel.render(120).join("\n"),/未找到本机保存的凭据/);
 await writeFile(authFile,JSON.stringify(saved));
 await panel.refresh();assert.match(panel.render(120).join("\n"),/已保存登录凭据/);
 panel.handleInput("l");assert.doesNotMatch(panel.render(200).join("\n"),/SECRET_|localAuth/);panel.dispose();
});

test("credential metadata reading is read-only, provider-specific, and never resolves commands", async () => {
 const {readLocalAuthRecords,authProvider}=jiti("../src/v3/ui/auth-view.ts") as any;
 const root=await mkdtemp(join(tmpdir(),"graph-auth-record-")),file=join(root,"auth.json");
 assert.equal((await readLocalAuthRecords(["xai"],root)).xai.state,"missing");
 assert.deepEqual(await readdir(root),[],"missing credentials must not create a store or lock files");
 await writeFile(file,JSON.stringify({other:{type:"oauth",access:"secret",refresh:"secret",expires:1},xai:{type:"api_key",key:`!touch ${join(root,"must-not-execute")}`}}));
 assert.equal((await readLocalAuthRecords(["xai"],root)).xai.state,"api_key_saved");
 assert.deepEqual(await readdir(root),["auth.json"]);
 assert.equal((await readLocalAuthRecords(["absent"],root)).absent.state,"missing");
 await writeFile(file,"{");assert.equal((await readLocalAuthRecords(["xai"],root)).xai.state,"unavailable");
 assert.equal(authProvider("xai/grok-4.5:high"),"xai");assert.equal(authProvider("grok"),undefined);
 const linked=join(root,"linked");await mkdir(linked);await symlink(file,join(linked,"auth.json"));
 assert.equal((await readLocalAuthRecords(["xai"],linked)).xai.state,"unavailable");
});

test("HTTP 401 is an historical authentication failure and HTTP 402 remains a quota error", () => {
 const {errorSummary,nodeNextStep,localAuthLines}=jiti("../src/v3/ui/presentation.ts") as any;
 assert.equal(errorSummary("HTTP 401 Unauthorized"),"当次请求未通过身份验证");
 const s=snapshot();assert.match(nodeNextStep(s,"research",s.nodes.research),/额度或订阅/);
 assert.deepEqual(localAuthLines(s,"research",s.nodes.research),[]);
});

test("missing final results return a Graph attention hint without stopping or claiming acceptance", async () => {
 const { graphPendingAttentionV3 } = await jiti.import("../extensions/pi-graph.ts") as any;
 const s = snapshot();
 s.nodes.worker.observation.supervision.attention = "result_unavailable";
 assert.match(graphPendingAttentionV3(s).join(" "), /worker: result_unavailable/);
 assert.equal(s.nodes.worker.phase, "running");
 assert.match(nodeReason(s,"worker",s.nodes.worker), /缺少最终结果/);
});
