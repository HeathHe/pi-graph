import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, mkdir, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistEvidenceFiles, verifyEvidenceFiles, parseBusinessResult, evidenceDirectory } from "../src/v3/evidence-files.ts";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";

async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(),"evidence-files-"))); const workspace = join(root,"workspace"), run=join(root,"run");await mkdir(workspace);await mkdir(run);return {root,workspace,run}; }
test("evidence rejects symlink files, directory links and hardlinks",async()=>{
 const f=await fixture(); await writeFile(join(f.root,"secret"),"secret");
 await symlink(join(f.root,"secret"),join(f.workspace,"linked"));
 await symlink(f.root,join(f.workspace,"directory"));
 await link(join(f.root,"secret"),join(f.workspace,"hard"));
 for (const path of ["linked","directory/secret","hard"]) await assert.rejects(persistEvidenceFiles(f.run,"work",1,f.workspace,[{path,nonSecret:true}]));
});
test("evidence rejects redirected destination and immutable replay mismatch",async()=>{
 const f=await fixture();await writeFile(join(f.workspace,"report"),"proof");
 await symlink(f.workspace,join(f.run,"artifacts"));
 await assert.rejects(persistEvidenceFiles(f.run,"work",1,f.workspace,[{path:"report",nonSecret:true}]),/Unsafe evidence directory/);
 const clean=await fixture();await writeFile(join(clean.workspace,"report"),"proof");
 const first=await persistEvidenceFiles(clean.run,"work",1,clean.workspace,[{path:"report",nonSecret:true}]);
 assert.equal(await persistEvidenceFiles(clean.run,"work",1,clean.workspace,[{path:"report",nonSecret:true}]),first);
 await writeFile(join(clean.workspace,"report"),"different");
 await assert.rejects(persistEvidenceFiles(clean.run,"work",1,clean.workspace,[{path:"report",nonSecret:true}]));
 await writeFile(join(evidenceDirectory(clean.run,"work",1),"manifest.json"),JSON.stringify({schemaVersion:1,taskId:"work",attempt:1,files:[]}));
 await assert.rejects(verifyEvidenceFiles(clean.run,"work",1,first),/digest mismatch/);
});
test("explicit result and evidence schema fail closed",()=>{
 const base={schemaVersion:3,goal:"gate",nodes:[{taskId:"work",agent:"test",task:"review",sideEffect:"none"}]};
 for (const evidenceFiles of [[{path:"../secret",nonSecret:true}],[{path:"/secret",nonSecret:true}],[{path:"report"}],[{path:"report",nonSecret:false}],[{path:"report",nonSecret:true},{path:"report",nonSecret:true}]]) assert.throws(()=>compileGraphSpecV3({...base,nodes:[{...base.nodes[0],evidenceFiles}]}));
 for (const output of ["PASS",'```json\n{"status":"pass","reason":"ok"}\n```','{"status":"PASS","reason":"ok"}','{"status":"pass","reason":""}']) assert.throws(()=>parseBusinessResult(output));
 assert.deepEqual(parseBusinessResult('{"status":"blocked","reason":"missing proof"}'),{status:"blocked",reason:"missing proof"});
});
