import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {readV3RunControl,V3InvalidControlError} from "../src/v3/control.ts";
import {atomicWriteJson} from "../src/v3/durable.ts";
const initial={schemaVersion:1,runInstanceId:"fixture-run",graphId:"fixture-graph",desiredState:"running",revision:0,createdAt:"2026-10-12T00:00:00.000Z",updatedAt:"2026-10-12T00:00:00.000Z"};
const next={...initial,desiredState:"paused",revision:1,updatedAt:"2026-10-12T00:00:01.000Z"};

test("control read accepts bounded atomic replacement and rejects unsafe files",async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),"control-atomic-"));
 const originalRead=fs.readFile,originalOpen=fs.open;
 async function fixture(name:string){const dir=join(root,name);await fs.mkdir(dir);const path=join(dir,"control.json");await atomicWriteJson(path,initial);return {dir,path};}
 async function hooked(name:string,mutate:(f:{dir:string,path:string},n:number)=>Promise<void>,accept:boolean){
  const f=await fixture(name);let reads=0;
  // Hook both old path reader and new descriptor reader at the same read boundary.
  fs.readFile=(async(p:any,...args:any[])=>{if(p===f.path)await mutate(f,++reads);return (originalRead as any)(p,...args)}) as typeof fs.readFile;
  fs.open=(async(p:any,...args:any[])=>{const h=await (originalOpen as any)(p,...args);if(p===f.path){const read=h.readFile.bind(h);h.readFile=async(...a:any[])=>{await mutate(f,++reads);return read(...a)}}return h}) as typeof fs.open;
  syncBuiltinESMExports();
  try{if(accept){assert.deepEqual(await readV3RunControl(f.dir),next);assert.equal(reads,2);}else await assert.rejects(()=>readV3RunControl(f.dir),V3InvalidControlError);return reads;}
  finally{fs.readFile=originalRead;fs.open=originalOpen;syncBuiltinESMExports();}
 }
 try{
  await t.test("legitimate same-run revision replacement returns the new revision",async()=>{await hooked("atomic",async(f,n)=>{if(n===1)await atomicWriteJson(f.path,next)},true)});
  await t.test("continuous replacement fails after exactly three reads",async()=>{assert.equal(await hooked("continuous",async(f,n)=>{await atomicWriteJson(f.path,{...next,revision:n})},false),3)});
  await t.test("parent replacement is refused",async()=>{await hooked("parent",async(f,n)=>{if(n===1){await fs.rename(f.dir,f.dir+"-old");await fs.mkdir(f.dir);await atomicWriteJson(f.path,next)}},false)});
  for(const kind of ["symlink","hardlink","bad-json","bad-schema","oversize"]){await t.test(kind+" is refused",async()=>{
   const f=await fixture(kind);
   if(kind==="symlink"){await fs.rename(f.path,f.path+".target");await fs.symlink(f.path+".target",f.path)}
   if(kind==="hardlink")await fs.link(f.path,f.path+".link");
   if(kind==="bad-json")await fs.writeFile(f.path,"{bad");
   if(kind==="bad-schema")await atomicWriteJson(f.path,{...initial,revision:-1});
   if(kind==="oversize")await fs.writeFile(f.path," ".repeat(1024*1024+1));
   await assert.rejects(()=>readV3RunControl(f.dir),V3InvalidControlError);
  })}
 }finally{fs.readFile=originalRead;fs.open=originalOpen;syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}
});
