import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join,resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createJiti } from "jiti";
import { GraphMailbox } from "../src/v3/mailbox.ts";
const alias:Record<string,string>={};
for(const name of ["pi-agent-core","pi-ai","pi-coding-agent","pi-tui"]){const id=`@earendil-works/${name}`,dir=resolve(`node_modules/${id}`),p=JSON.parse(fs.readFileSync(join(dir,"package.json"),"utf8"));alias[id]=join(dir,p.exports?.["."]?.import??p.main);}
async function readGraphView(root:string,id:string){const mod=await createJiti(import.meta.url,{alias,moduleCache:false,fsCache:false}).import<any>("../src/v3/ui/read-view.ts");return mod.readGraphView(root,id);}
async function fixture(kind:"snapshot"|"mailbox"){
 const root=await fsp.mkdtemp('/tmp/pi-graph-atomic-read-');const run=join(root,'read-check');await fsp.mkdir(run);
 const snapshot={schemaVersion:3,graphId:'read-check',runInstanceId:'read-check',graphDigest:'a'.repeat(64),sourceGraphSpecDigest:'b'.repeat(64),status:'running',sessionId:'fixture',supervisorEpoch:'epoch',createdAt:'2026-10-12T00:00:00.000Z',updatedAt:'2026-10-12T00:00:01.000Z',nodes:{}};
 const box=new GraphMailbox(run,{withFence:async(fn:any)=>fn()},async()=>true);await box.initialize('read-check','owner',[]);
 const path=kind==='snapshot'?join(run,'snapshot.json'):box.path;if(kind==='snapshot')await fsp.writeFile(path,JSON.stringify(snapshot));
 return{root,run,path,read:()=>kind==='snapshot'?readGraphView(root,'read-check'):box.load(),cleanup:()=>fsp.rm(root,{recursive:true,force:true})};
}
for(const kind of ['snapshot','mailbox'] as const){
 test(`${kind}: actual reader reopens legitimate atomic replacement, never accepts unlinked old inode`,async t=>{
  const f=await fixture(kind),raw=await fsp.readFile(f.path);let fired=false;const evidence:any[]=[];
  const realOpen=fs.promises.open,realLstat=fs.promises.lstat;
  async function replacedStat(handle:fsp.FileHandle){fired=true;const next=f.path+'.next';await fsp.writeFile(next,raw);await fsp.rename(next,f.path);const old=await handle.stat(),current=await realLstat(f.path);evidence.push({oldLinks:old.nlink,currentLinks:current.nlink,different:old.ino!==current.ino});return old;}
  t.mock.method(fs.promises,'open',async(...args:Parameters<typeof realOpen>)=>{const handle=await realOpen(...args);if(String(args[0])!==f.path)return handle;return new Proxy(handle,{get(target,key){if(key==='stat')return async()=>!fired?replacedStat(handle):handle.stat();const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});});
  t.mock.method(fs.promises,'lstat',async(...args:Parameters<typeof realLstat>)=>{if(kind==='mailbox'&&!fired&&String(args[0])===f.path){const handle=await realOpen(f.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{return await replacedStat(handle);}finally{await handle.close();}}return realLstat(...args);});syncBuiltinESMExports();
  try{const result=await f.read();assert.equal(result.runInstanceId,'read-check');assert.deepEqual(evidence,[{oldLinks:0,currentLinks:1,different:true}]);}finally{t.mock.restoreAll();syncBuiltinESMExports();await f.cleanup();}
 });
 for(const bad of ['symlink','hardlink','directory','oversize','identity','invalid-json',...(kind==='mailbox'?['run-identity','protocol']:[])] as const)test(`${kind}: rejects ${bad} rather than retrying unsafe state`,async()=>{
  const f=await fixture(kind);try{
   if(bad==='symlink'){await fsp.rename(f.path,f.path+'.real');await fsp.symlink(f.path+'.real',f.path);}
   if(bad==='hardlink')await fsp.link(f.path,f.path+'.link');
   if(bad==='directory'){await fsp.unlink(f.path);await fsp.mkdir(f.path);}
   if(bad==='oversize'){const h=await fsp.open(f.path,'w');await h.truncate(16*1024*1024+1);await h.close();}
   if(bad==='invalid-json')await fsp.writeFile(f.path,'{broken');
   if(bad==='run-identity'||bad==='protocol'){const state=JSON.parse(await fsp.readFile(f.path,'utf8'));if(bad==='run-identity')state.runInstanceId='foreign';else state.protocol='foreign';await fsp.writeFile(f.path,JSON.stringify(state));}
   if(bad==='identity'){const state=JSON.parse(await fsp.readFile(f.path,'utf8'));if(kind==='snapshot')state.graphId='foreign';else state.owner='foreign';await fsp.writeFile(f.path,JSON.stringify(state));}
   await assert.rejects(f.read());
  }finally{await f.cleanup();}
 });
 test(`${kind}: repeated valid replacements stop after exactly three attempts`,async t=>{
  const f=await fixture(kind),raw=await fsp.readFile(f.path);let replacements=0;const realOpen=fs.promises.open;
  t.mock.method(fs.promises,'open',async(...args:Parameters<typeof realOpen>)=>{const handle=await realOpen(...args);if(String(args[0])!==f.path)return handle;return new Proxy(handle,{get(target,key){if(key==='stat')return async()=>{const next=f.path+'.next';await fsp.writeFile(next,raw);await fsp.rename(next,f.path);replacements++;return handle.stat();};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});});syncBuiltinESMExports();
  try{await assert.rejects(f.read());assert.equal(replacements,3);}finally{t.mock.restoreAll();syncBuiltinESMExports();await f.cleanup();}
 });
}
for(const kind of ['snapshot','mailbox']as const)for(const mutation of ['unlink','symlink-replacement','hardlink-replacement','directory-replacement']as const)test(`${kind}: atomic race rejects unsafe ${mutation} without reading substituted state`,async t=>{
 const f=await fixture(kind),raw=await fsp.readFile(f.path);let fired=false,opens=0;const realOpen=fs.promises.open;
 t.mock.method(fs.promises,'open',async(...args:Parameters<typeof realOpen>)=>{const h=await realOpen(...args);if(String(args[0])!==f.path)return h;opens++;return new Proxy(h,{get(target,key){if(key==='stat')return async()=>{if(!fired){fired=true;if(mutation==='directory-replacement'){const parent=join(f.path,'..');await fsp.rename(parent,parent+'.old');await fsp.mkdir(parent);await fsp.writeFile(f.path,raw);}else{await fsp.unlink(f.path);if(mutation==='symlink-replacement'){await fsp.writeFile(f.path+'.target',raw);await fsp.symlink(f.path+'.target',f.path);}if(mutation==='hardlink-replacement'){await fsp.writeFile(f.path+'.target',raw);await fsp.link(f.path+'.target',f.path);}}}return h.stat();};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});});syncBuiltinESMExports();
 try{await assert.rejects(f.read());assert.equal(opens,1);}finally{t.mock.restoreAll();syncBuiltinESMExports();await f.cleanup();}
});
