import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {Check} from "typebox/value";
import {initializeV3Run} from "../src/v3/initialize.ts";
import {mkdtemp, mkdir, writeFile, realpath, symlink, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {executeGraphReadonly, registerGraphReadonlyTools, GRAPH_READONLY_TOOLS} from "../src/v3/readonly-tools.ts";
import {validateV3RequiredMaterials} from "../src/v3/workspace.ts";
import {compileGraphSpecV3} from "../src/v3/compiler.ts";
import {createJiti} from "jiti";
const {GraphSpecV3NodeSchema} = await createJiti(import.meta.url).import("../extensions/pi-graph.ts") as any;
const run = executeGraphReadonly as (...args: Parameters<typeof executeGraphReadonly>) => Promise<any>;
import {checkNativeRuntimePatch} from "../src/v3/runtime-compatibility.ts";

test("typed readonly discovery/hash enforce scopes, special-file denial, pagination and declaration checks", async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),"readonly-tools-")));
 try {
  await mkdir(join(root,"docs")); await writeFile(join(root,"docs/a.md"),"hello"); await writeFile(join(root,"docs/b.md"),"world");await writeFile(join(root,"secret"),"secret");
  const authority={cwd:root,scopes:[{kind:"tree" as const,path:"docs"},{kind:"file" as const,path:join(root,"missing")} ]};
  assert.deepEqual((await run("graph_readonly_list",{path:"."},authority)).entries, [{path:"docs",kind:"directory"}]);
  const page=await run("graph_readonly_find",{path:".",namePattern:"*.md",limit:1},authority);
  assert.equal(page.entries?.length,1);assert.equal(page.truncated,true);assert.equal(page.nextOffset,1);
  assert.equal((await run("graph_readonly_find",{path:".",namePattern:"*.md",offset:1,limit:1},authority)).entries?.[0].path,"docs/b.md");
  assert.equal((await run("graph_readonly_sha256",{path:"docs/a.md"},authority)).digest,createHash("sha256").update("hello").digest("hex"));
  for(const path of ["secret","../secret","/etc/passwd"]){await assert.rejects(run("graph_readonly_sha256",{path},authority),{message:"Readonly access denied or unavailable."});}
  await symlink(join(root,"secret"),join(root,"docs/escape"));await assert.rejects(run("graph_readonly_sha256",{path:"docs/escape"},authority));
  assert.equal(spawnSync("mkfifo",[join(root,"docs/pipe")]).status,0);await assert.rejects(run("graph_readonly_sha256",{path:"docs/pipe"},authority));
  await assert.rejects(run("bash",{path:"docs/a.md"},authority));await assert.rejects(run("graph_readonly_list",{path:".",command:"touch pwn"} as never,authority));
  const node={taskId:"review",readScope:[{kind:"tree" as const,path:"docs"}],writeScope:[],requiredMaterials:["docs/a.md"]};
  await validateV3RequiredMaterials(root,node);
  await assert.rejects(validateV3RequiredMaterials(root,{...node,requiredMaterials:["secret"]}),/outside declared readable scope/);
  await assert.rejects(validateV3RequiredMaterials(root,{...node,requiredMaterials:["docs/missing"]}),/does not exist|missing/);
  await validateV3RequiredMaterials("/missing-no-new-contract",{...node,requiredMaterials:undefined});
  const graph=compileGraphSpecV3({schemaVersion:3,graphId:"files",goal:"review",nodes:[{taskId:"review",agent:"reviewer",task:"MustRead prose does not grant authority",sideEffect:"local_read",readScope:node.readScope,requiredMaterials:node.requiredMaterials}]});
  assert.deepEqual(graph.nodes[0].requiredMaterials,["docs/a.md"]);assert.ok(GraphSpecV3NodeSchema.properties.requiredMaterials);
  assert.equal(Check(GraphSpecV3NodeSchema, {taskId:"review",agent:"reviewer",task:"review",sideEffect:"local_read",requiredMaterials:["docs/a.md"]}),true);
  const runDir=join(root,"runs","missing");graph.nodes[0].requiredMaterials=["docs/missing"];
  await assert.rejects(initializeV3Run({graph,sourceCwd:root,runDir,trustedRoot:root,sessionId:"test",supervisorEpoch:"epoch"}),/required material/);
  assert.equal(existsSync(runDir),false);
  await mkdir(join(root,".pi-graph/inputs"),{recursive:true});const artifact=join(root,".pi-graph/inputs/evidence");await writeFile(artifact,"artifact");
  assert.ok((await run("graph_readonly_sha256",{path:".pi-graph/inputs/evidence"},{cwd:root,scopes:[{kind:"file",path:artifact}],deniedRoots:[join(root,".pi-graph")],inputFiles:[artifact]})).digest);
  await assert.rejects(run("graph_readonly_list",{path:".pi-graph"},{cwd:root,scopes:[{kind:"tree",path:root}]}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test("parent registration exposes only fixed typed schemas; upgrade check is read-only and diagnoses loss",()=>{
 const registered:any[]=[];registerGraphReadonlyTools({registerTool:(t:any)=>registered.push(t)} as never,cwd=>({cwd,scopes:[]}));
 assert.deepEqual(registered.map(t=>t.name),GRAPH_READONLY_TOOLS);
 for(const tool of registered){assert.equal(tool.parameters.additionalProperties,false);assert.equal(tool.parameters.properties.command,undefined);}
 assert.equal(checkNativeRuntimePatch("/missing-patch-manifest"),undefined,"Owned runtime has no third-party patch manifest dependency.");
});
