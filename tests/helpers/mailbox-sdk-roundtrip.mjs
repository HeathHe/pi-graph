// Actual SDK child tools, product durable store/UDS broker and real V3 lease.
// Full GraphHost admission/guard/root-wake integration is a separate proof.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const graphRoot = fileURLToPath(new URL("../..", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-sdk-")));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_GRAPH_RUNTIME_ROOT = path.join(root, "native");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");

const SDK = "/Users/heathhe/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createDefaultChildSessionFactory } = await import('./owned-sdk-factory.mjs');
const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import(SDK + "/node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
const { createJiti } = await import(graphRoot + "/node_modules/jiti/lib/jiti.mjs");
const jiti = createJiti(import.meta.url);
const { MAILBOX_BINDING_NAMESPACE } = await jiti.import(graphRoot + "/src/v3/mailbox-bindings.ts");
const { registerGraphMailboxTool } = await jiti.import(graphRoot + "/src/v3/mailbox-client.ts");
assert.equal(typeof registerGraphMailboxTool, "function");

const { GraphMailbox } = await jiti.import(graphRoot + "/src/v3/mailbox.ts");
const { MailboxBroker, mailboxRequest } = await jiti.import(graphRoot + "/src/v3/mailbox-transport.ts");
const { acquireV3RunLease } = await jiti.import(graphRoot + "/src/v3/lease.ts");
const runDir = path.join(root, "run");
fs.mkdirSync(runDir);
const lease = await acquireV3RunLease(path.join(runDir, "lease.json"), "sdk-mailbox-fixture");
const mailbox = new GraphMailbox(runDir, lease, async (taskId, attempt) => ["a", "b"].includes(taskId) && attempt === 1);
await mailbox.initialize("sdk-mailbox-fixture", "fixture-owner", [{taskId:"a",attempt:1},{taskId:"b",attempt:1}]);
const tokens = { a: await mailbox.capability("a", 1), b: await mailbox.capability("b", 1) };
const broker = new MailboxBroker(mailbox);
await broker.start();
const socketPath = broker.socketPath;
const toolEvents = [];
const counters = { mainProviderCalls: 0, aProviderCalls: 0, bProviderCalls: 0 };
let firstSend;
const firstSendCommitted = new Promise(resolve => { firstSend = resolve; });
const question = "A自主发给B：中文😀\"\\\n请回复。";
const answer = "B自主回复A：收到中文😀。";

function latestToolValue(context) {
  const message = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "graph_mailbox");
  assert.ok(message, "faux continuation must consume its own real SDK tool result");
  assert.notEqual(message.isError, true);
  const text = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  return JSON.parse(text);
}
const state = { a: 0, b: 0 };
const received = {};
const model = { id: "test", name: "fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
const call = args => fauxAssistantMessage(fauxToolCall("graph_mailbox", args), { stopReason: "toolUse" });
const guarded = process.argv.includes("--guarded-roundtrip");
const streams = {}, actorByCwd = new Map();
function provider(actor, register = true) {
  return { name: "fixture-provider-" + actor, factory: pi => {
    const faux = createFauxCore({ provider: "mailbox-fixture-" + actor, api: "mailbox-fixture-" + actor, models: [model] });
    faux.setResponses(Array.from({ length: 128 }, () => async context => {
      counters[actor + "ProviderCalls"]++;
      const step = state[actor];
      if (actor === "a") {
        if (step === 0) { state.a=1; return call({ action: "send", to: "b", kind: "question", text: question, idempotencyKey: "a-question" }); }
        if (step === 1) { assert.ok(latestToolValue(context).messageId); state.a=2; return call({ action: "wait" }); }
        if (step === 2) {
          const value = latestToolValue(context);
          if (!value.messages.length) { await new Promise(resolve => setTimeout(resolve, 10)); return call({ action: "wait" }); }
          received.a = value.messages[0]; assert.equal(received.a.from, "b"); state.a=3;
          return call({ action: "read", messageId: received.a.messageId });
        }
        if (step === 3) { assert.equal(latestToolValue(context).text, answer); state.a=4; return call({ action: "ack", messageId: received.a.messageId }); }
        assert.equal(latestToolValue(context).state, "acknowledged"); return fauxAssistantMessage("A received B's reply autonomously.");
      }
      state.b++;
      if (step === 0) return call({ action: "receive" });
      if (step === 1) { received.b = latestToolValue(context).messages[0]; assert.equal(received.b.from, "a"); return call({ action: "read", messageId: received.b.messageId }); }
      if (step === 2) { assert.equal(latestToolValue(context).text, question); return call({ action: "reply", messageId: received.b.messageId, text: answer, idempotencyKey: "b-answer" }); }
      if (step === 3) { assert.ok(latestToolValue(context).messageId); return call({ action: "ack", messageId: received.b.messageId }); }
      assert.equal(latestToolValue(context).state, "replied"); return fauxAssistantMessage("B read and replied autonomously.");
    }));
    streams[actor]=faux.streamSimple;
    if(register) pi.registerProvider("mailbox-fixture-" + actor, { baseUrl: "http://127.0.0.1:1", apiKey: "fixture", api: faux.api, models: faux.models, streamSimple: faux.streamSimple });
  } };
}
let guardedTransportCalls=0;
const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => {
  const sdk=await import(SDK + "/dist/index.js");
  if(!guarded)return sdk;
  // Public SDK injection only: no provider registration and no policy bypass.
  // All auth/catalog paths are fixture-owned; HTTP is prohibited defensively.
  globalThis.fetch=()=>{throw new Error("Guarded mailbox fixture forbids network");};
  return {...sdk,ModelRuntime:{create:async()=>{
    const runtime=await sdk.ModelRuntime.create({authPath:path.join(root,"guarded-auth.json"),modelsPath:null,modelsStorePath:path.join(root,"guarded-models.json"),allowModelNetwork:false,refreshOnCreate:false});
    await runtime.setRuntimeApiKey("openai","fixture-no-network");
    return runtime;
  }},createAgentSession:async options=>{
    const result=await sdk.createAgentSession(options),actor=actorByCwd.get(options.cwd);
    assert.ok(actor && streams[actor],"real SDK must have the fixture stream before any prompt");
    // Agent.streamFunction is a public property in the installed SDK.
    result.session.agent.streamFunction=(model,context,options)=>{
      guardedTransportCalls++;return streams[actor](model,context,options);
    };
    return result;
  }};
} });
const sessions = {};
try {
  if (process.argv.includes("--wait-bounds")) {
    const proof = [];
    for (const phase of ["long-wait", "abort"]) {
      let responses=0, started;
      const waiting = new Promise(resolve=>{started=resolve;});
      const session = await factory.create({cwd:root,storage:{kind:"dir",sessionDir:path.join(root,"wait-"+phase)},
        model:"mailbox-wait-"+phase+"/test",tools:["graph_mailbox"],extensionPaths:[],ambientExtensions:false,
        hooks:[{name:"wait-faux-"+phase,factory:pi=>{
          const faux=createFauxCore({provider:"mailbox-wait-"+phase,api:"mailbox-wait-"+phase,models:[model]});
          faux.setResponses([async()=>{responses++;return call({action:"wait"});},async context=>{
            responses++;assert.equal(latestToolValue(context).pending,false);assert.equal(latestToolValue(context).messages.length,1);return fauxAssistantMessage("One long-lived wait received its message.");
          }]);
          pi.registerProvider("mailbox-wait-"+phase,{baseUrl:"http://127.0.0.1:1",apiKey:"fixture",api:faux.api,models:faux.models,streamSimple:faux.streamSimple});
        }},{name:"actual-mailbox-wait",factory:pi=>registerGraphMailboxTool(pi,{socketPath,token:phase==="abort"?tokens.b:tokens.a})}],
        noSkills:true,noContextFiles:true,runtime:{},processEnv:{PI_GRAPH_CHILD:undefined,PI_GRAPH_EXTENSION_BINDINGS:undefined},onExtensionError:event=>{throw event.error;}});
      sessions[phase]=session;
      let starts=0, ends=0;
      session.subscribe(event=>{if(event.toolName!=="graph_mailbox")return;
        if(event.type==="tool_execution_start"){starts++;started();}if(event.type==="tool_execution_end")ends++;
      });
      const begun=Date.now(),run=session.prompt("Use one local wait call.");
      await Promise.race([waiting,run.then(()=>{throw new Error("Wait never started");})]);
      if(phase==="abort"){
        await new Promise(resolve=>setTimeout(resolve,250));
        const aborted=Date.now();await session.abort();await run;
        assert.ok(Date.now()-aborted<2000,"SDK abort must stop the live mailbox wait promptly");
        assert.equal(responses,1,"aborted local polling must not ask faux/model for continuation");
      }else{
        await new Promise(resolve=>setTimeout(resolve,11_000));
        assert.equal(responses,1,"wait beyond prior 10s boundary must not return to model");
        assert.equal(ends,0,"long-lived wait must still be the same pending SDK tool call");
        // Inject a new fixture event, never forward either child's existing text.
        await mailboxRequest({socketPath,token:tokens.b},{action:"send",to:"a",kind:"message",text:"New fixture event after 11s",idempotencyKey:"long-wait-release"});
        await run;
        assert.ok(Date.now()-begun>=11_000 && Date.now()-begun<15_000,"new mailbox message promptly releases the same long-lived wait");
        assert.equal(responses,2,"local polling must stay in one SDK tool call, with one final continuation");
      }
      assert.equal(starts,1);assert.equal(ends,1);
      proof.push({phase,elapsedMs:Date.now()-begun,providerResponses:responses,toolStarts:starts,toolEnds:ends});
    }
    assert.equal((await mailbox.load()).messages.length,1);
    fs.writeFileSync(path.join(root,"sdk-mailbox-wait-proof.json"),JSON.stringify(proof,null,2));
    console.log("PASS actual SDK mailbox long-lived wait and bounded abort; local polling invokes no extra model rounds");
    console.log("WAIT_PROOF "+JSON.stringify(proof));
  } else if (process.argv.includes("--guard-visibility")) {
    const { freezeV3GraphAgents, prepareV3Workspace } = await jiti.import(graphRoot + "/src/v3/workspace.ts");
    const { v3GraphGuardExtensionBindings } = await jiti.import(graphRoot + "/src/v3/dispatch.ts");
    const guard = (await jiti.import(graphRoot + "/extensions/pi-graph-guard.ts")).default;
    const { discoverAgents } = await jiti.import(graphRoot + "/src/runtime/agents.ts");
    const { resolvePiLaunchToolPlan } = await jiti.import(graphRoot + "/src/runtime/launch-contract.ts");
    const source = path.join(root, "visibility-source");
    fs.mkdirSync(path.join(source, ".pi", "agents"), {recursive:true});
    const node = taskId => ({taskId,agent:taskId,task:"visibility only",dependsOn:[],inputArtifacts:[],outputArtifact:"fixture/"+taskId,
      readScope:[],writeScope:[],sideEffect:"none",retryPolicy:{maxAttempts:1,retryOn:[],backoffMs:0},validationCommands:[]});
    for (const [name, tools] of [["explicit", "tools: read, contact_supervisor, intercom\n"], ["implicit", ""]]) {
      fs.writeFileSync(path.join(source,".pi","agents",name+".md"), `---\nname: ${name}\ndescription: visibility fixture\n${tools}---\n\nNo model task.\n`);
    }
    await freezeV3GraphAgents(runDir,source,[node("explicit"),node("implicit")]);
    let active;
    const prepared = [];
    try {
      for (const name of ["explicit","implicit"]) {
        const workspace = await prepareV3Workspace({runInstanceId:"sdk-mailbox-fixture",graphId:"visibility",node:node(name),attempt:1,runDir,sourceCwd:source,workspace:"shadow"});
        prepared.push(workspace);
        const agent = discoverAgents(workspace.workspaceCwd,"project").agents.find(agent => agent.name === name);
        assert.ok(agent,"actual native discovery must parse materialized frozen Agent");
        if (name === "implicit") { assert.equal(agent.tools,undefined,"undefined tools must preserve inherited semantics"); continue; }
        assert.ok(agent.tools.includes("graph_mailbox"));
        assert.ok(!agent.tools.some(tool=>tool==="contact_supervisor"||tool.startsWith("intercom")));
        const plan = resolvePiLaunchToolPlan({tools:agent.tools,cwd:workspace.workspaceCwd,agentName:name});
        assert.ok(plan.effectiveToolAllowlist.includes("graph_mailbox"));
        assert.ok(plan.requiredChildTools.includes("graph_mailbox"));
        const bindings = {...v3GraphGuardExtensionBindings(workspace.evidence),[MAILBOX_BINDING_NAMESPACE]:{socketPath,token:tokens.a}};
        sessions.visibility = await factory.create({cwd:workspace.workspaceCwd,storage:{kind:"dir",sessionDir:path.join(root,"visibility-session")},
          model:"mailbox-fixture-a/test",tools:[...plan.effectiveToolAllowlist,"contact_supervisor","intercom"],extensionPaths:[],ambientExtensions:false,
          hooks:[provider("a"),{name:"legacy-registration-fixture",factory:pi=>{
            for(const name of ["contact_supervisor","intercom"])pi.registerTool({name,label:name,description:"visibility only",parameters:{type:"object",properties:{}},execute:async()=>{throw new Error("Legacy tool must not execute");}});
          }},{name:"actual-product-guard",factory:guard},{name:"capture-active-tools",factory:pi=>{active=()=>pi.getActiveTools();}}],
          noSkills:true,noContextFiles:true,runtime:{},processEnv:{PI_GRAPH_CHILD:"1",PI_GRAPH_EXTENSION_BINDINGS:JSON.stringify(bindings)},onExtensionError:event=>{throw event.error;}});
        assert.ok(active().includes("graph_mailbox"),"actual guard must register mailbox visible in SDK session");
        assert.ok(!active().some(tool=>tool==="contact_supervisor"||tool==="subagent_supervisor"||tool.startsWith("intercom")),"actual session_start guard removes legacy active tools");
      }
      assert.equal(counters.aProviderCalls,0,"visibility test must not invoke any model");
      console.log("PASS frozen native tool plan + actual SDK guard registers graph_mailbox and removes legacy active tools; implicit tools preserved");
      console.log("SCOPE guard session_start visibility only; guarded prompt/tool_call and root-wake filtering remain separate proofs");
    } finally { for(const workspace of prepared) await workspace.cleanup(); }
  } else {
  const frozenWorkspaces=[];
  const guardCalls={a:0,b:0};
  for (const actor of ["a", "b"]) {
    let registered = false;
    let cwd=root,tools=["read","graph_mailbox"],bindings,guardHook;
    if(guarded){
      const {freezeV3GraphAgents,prepareV3Workspace}=await jiti.import(graphRoot+"/src/v3/workspace.ts");
      const {v3GraphGuardExtensionBindings}=await jiti.import(graphRoot+"/src/v3/dispatch.ts");
      const guard=(await jiti.import(graphRoot+"/extensions/pi-graph-guard.ts")).default;
      const {discoverAgents}=await jiti.import(graphRoot+"/src/runtime/agents.ts");
      const {resolvePiLaunchToolPlan}=await jiti.import(graphRoot+"/src/runtime/launch-contract.ts");
      const source=path.join(root,"guarded-source-"+actor);
      fs.mkdirSync(path.join(source,".pi","agents"),{recursive:true});
      fs.writeFileSync(path.join(source,".pi","agents",actor+".md"),`---\nname: ${actor}\ndescription: guarded mailbox fixture\ntools: read, contact_supervisor, intercom\n---\n\nFixture only.\n`);
      const node={taskId:actor,agent:actor,task:"guarded mailbox",dependsOn:[],inputArtifacts:[],outputArtifact:"fixture/"+actor,readScope:[],writeScope:[],sideEffect:"none",retryPolicy:{maxAttempts:1,retryOn:[],backoffMs:0},validationCommands:[]};
      await freezeV3GraphAgents(runDir,source,[node]);
      const workspace=await prepareV3Workspace({runInstanceId:"sdk-mailbox-fixture",graphId:"guarded",node,attempt:1,runDir,sourceCwd:source,workspace:"shadow"});
      frozenWorkspaces.push(workspace);cwd=workspace.workspaceCwd;actorByCwd.set(cwd,actor);
      const agent=discoverAgents(cwd,"project").agents.find(agent=>agent.name===actor);
      assert.ok(agent?.tools?.includes("graph_mailbox"));
      tools=resolvePiLaunchToolPlan({tools:agent.tools,cwd,agentName:actor}).effectiveToolAllowlist;
      bindings={...v3GraphGuardExtensionBindings(workspace.evidence),[MAILBOX_BINDING_NAMESPACE]:{socketPath,token:tokens[actor]}};
      guardHook={name:"actual-frozen-graph-guard-"+actor,factory:pi=>{guard(pi);registered=true;pi.on("tool_call",()=>{guardCalls[actor]++;});}};
    }
    sessions[actor] = await factory.create({ cwd, storage: { kind: "dir", sessionDir: path.join(root, actor) },
      model: guarded ? "openai/gpt-4o" : "mailbox-fixture-" + actor + "/test", tools, extensionPaths: [], ambientExtensions: false,
      hooks: [provider(actor,!guarded), guardHook ?? { name: "real-mailbox-client-" + actor, factory: pi => {
        registerGraphMailboxTool(pi, { socketPath, token: tokens[actor] }); registered = true;
      } }], noSkills: true, noContextFiles: true, runtime: {},
      processEnv: { PI_GRAPH_CHILD: guarded?"1":undefined, PI_GRAPH_EXTENSION_BINDINGS: bindings?JSON.stringify(bindings):undefined },
      onExtensionError: event => { throw event.error; } });
    assert.ok(registered);
    let sendCall;
    sessions[actor].subscribe(event => {
      if (actor === "a" && event.type === "tool_execution_start" && event.args?.action === "send") sendCall = event.toolCallId;
      if (actor === "a" && sendCall && event.type === "tool_execution_end" && event.toolCallId === sendCall && event.result?.isError !== true) firstSend();
      if (["tool_execution_start", "tool_execution_end"].includes(event.type)) toolEvents.push({ actor, type: event.type,
        toolName: event.toolName, ...(event.type === "tool_execution_end" ? { result: event.result } : { args: event.args }) });
    });
  }
  const aRun = sessions.a.prompt("Use only the fixture mailbox tool sequence.");
  // Readiness only: orchestration never reads, forwards, or rewrites peer text.
  await Promise.race([firstSendCommitted, aRun.then(() => { throw new Error("A ended before durable send readiness"); })]);
  await Promise.all([aRun, sessions.b.prompt("Use only the fixture mailbox tool sequence.")]);
  const persisted = await mailbox.load();
  assert.equal(persisted.messages.length, 2);
  const [sent, reply] = persisted.messages;
  assert.equal(reply.replyTo, sent.id); assert.equal(sent.replyId, reply.id);
  assert.equal(sent.acknowledged, true); assert.equal(reply.acknowledged, true);
  assert.equal(sent.from, "a"); assert.equal(sent.to, "b");
  assert.equal(reply.from, "b"); assert.equal(reply.to, "a");
  assert.ok(persisted.messages.every(message => message.fromAttempt === 1 && message.toAttempt === 1));
  assert.equal(persisted.messages.filter(message => message.to === "@parent").length, 0);
  assert.equal(counters.mainProviderCalls, 0);
  for (const actor of ["a", "b"]) {
    const starts = toolEvents.filter(event => event.actor === actor && event.type === "tool_execution_start");
    assert.ok(starts.length >= 4); assert.ok(starts.every(event => event.toolName === "graph_mailbox"));
    assert.ok(toolEvents.filter(event => event.actor === actor && event.type === "tool_execution_end").every(event => event.result?.isError !== true));
    const journal = fs.readFileSync(sessions[actor].sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(journal.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "graph_mailbox"));
  }
  // Fixture-generated tokens are never serialized into this evidence.
  fs.writeFileSync(path.join(root, "sdk-mailbox-tool-events.json"), JSON.stringify(toolEvents, null, 2));
  fs.writeFileSync(path.join(root, "sdk-mailbox-proof.json"), JSON.stringify({ scope: guarded ? "sdk-frozen-guard-product-store-broker-real-lease" : "sdk-product-store-broker-real-lease", counters, parentMessages: 0, messageCount: persisted.messages.length, ...(guarded ? {guardCalls,guardedTransportCalls} : {}) }, null, 2));
  console.log("PASS actual SDK two-child graph_mailbox send/read/reply/ack via product durable mailbox/broker; no parent relay");
  console.log(guarded ? "SCOPE actual frozen Graph SDK guard + product mailbox/broker/lease; GraphHost root-wake/recovery integration remains pending" : "SCOPE actual SDK + product mailbox/broker/lease; GraphHost guard/admission/root-wake integration remains pending");
  if(guarded){
    assert.ok(guardCalls.a>=4 && guardCalls.b>=4,"both actual SDK children must cross registered Graph tool_call handlers");
    assert.equal(guardedTransportCalls,counters.aProviderCalls+counters.bProviderCalls);
    console.log("PASS actual frozen Graph guard input/before_agent_start/tool_call dual SDK P2P via public faux transport; no policy bypass or network");
    for(const workspace of frozenWorkspaces)await workspace.cleanup();
  }
  }
} finally {
  for (const session of Object.values(sessions)) { await session.abort().catch(() => {}); await session.dispose(); }
  await factory.dispose();
  await broker.close();
  await lease.release();
}
