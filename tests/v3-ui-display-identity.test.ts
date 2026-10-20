import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {compileGraphSpecV3}=await jiti.import<any>('../src/v3/compiler.ts');
const {authorizationV4For}=await jiti.import<any>('../src/v3/authorization.ts');
const {readGraphView}=await jiti.import<any>('../src/v3/ui/read-view.ts');
const {displayEvidence}=await jiti.import<any>('../src/v3/ui/presentation.ts');
test('project and conditional-edge display require exact authorization identity and never mutate source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'display-identity-'));
 try{
  const graph=compileGraphSpecV3({schemaVersion:3,graphId:'display-fixture',goal:'Display fixture',nodes:[{taskId:'inspect',agent:'reviewer',task:'PRIVATE_TASK',sideEffect:'none'},{taskId:'report',agent:'reviewer',task:'PRIVATE_TASK',sideEffect:'none',dependsOn:['inspect'],when:{node:'inspect',status:'failed'}}]});
  const at='2026-01-01T00:00:00Z';const auth=authorizationV4For(graph,{runInstanceId:'run',sessionId:'owner',supervisorEpoch:'epoch',createdAt:at,sourceCwd:root,sourceRepository:{kind:'directory',root,device:'1',inode:'2'}});
  const dir=join(root,graph.graphId);await mkdir(dir);
  const snapshot={schemaVersion:3,graphId:graph.graphId,runInstanceId:'run',sessionId:'owner',supervisorEpoch:'epoch',createdAt:at,updatedAt:at,graphDigest:graph.graphDigest,sourceGraphSpecDigest:graph.sourceGraphSpecDigest,status:'queued',nodes:{inspect:{phase:'queued',attempt:0,agent:'reviewer'},report:{phase:'queued',attempt:0,agent:'reviewer',dependsOn:['inspect']}}};
  const snapshotFile=join(dir,'snapshot.json'),authFile=join(dir,'authorization.json');await writeFile(snapshotFile,JSON.stringify(snapshot));await writeFile(authFile,JSON.stringify(auth));const before=await readFile(snapshotFile,'utf8');
  let view=await readGraphView(root,graph.graphId,undefined,'owner');assert.equal(displayEvidence(view).project,basename(root));assert.deepEqual(displayEvidence(view).conditions,{report:{node:'inspect',status:'failed'}});assert.doesNotMatch(JSON.stringify(displayEvidence(view)),/PRIVATE_TASK/);
  for(const field of ['runInstanceId','sessionId','graphDigest']){await writeFile(authFile,JSON.stringify({...auth,[field]:field==='graphDigest'?'f'.repeat(64):'foreign'}));view=await readGraphView(root,graph.graphId,undefined,'owner');assert.equal(displayEvidence(view).project,undefined,field);assert.equal(displayEvidence(view).conditions,undefined,field);}
  await rm(authFile);const outside=join(root,'other.json');await writeFile(outside,JSON.stringify(auth));await symlink(outside,authFile);view=await readGraphView(root,graph.graphId,undefined,'owner');assert.equal(displayEvidence(view).project,undefined);assert.equal(displayEvidence(view).conditions,undefined);assert.equal(await readFile(snapshotFile,'utf8'),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
