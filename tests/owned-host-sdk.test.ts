import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureHostSdkIdentity,validateHostSdkIdentity,loadFrozenHostSdk,resolveHostDependencyRoot,resolveHostSdkRoot,loadHostSdk,assertHostSdkCapabilities,assertHostSessionCapabilities} from '../src/runtime/host-sdk.ts';
function compatible(){class Loader{reload(){}getExtensions(){}}return {createAgentSession(){},ModelRuntime:{create(){}},SettingsManager:{create(){},inMemory(){}},SessionManager:{create(){}},DefaultResourceLoader:Loader,createEventBus(){},resolveCliModel(){},createBashToolDefinition(){}};}
test('capability contract accepts future version metadata and rejects missing exports explicitly',()=>{
 const sdk=compatible();assert.doesNotThrow(()=>assertHostSdkCapabilities(sdk,'99.0.0'));
 for(const name of ['createAgentSession','createEventBus','resolveCliModel','createBashToolDefinition'])assert.throws(()=>assertHostSdkCapabilities({...sdk,[name]:undefined},'99.0.0'),new RegExp(name));
 assert.throws(()=>assertHostSdkCapabilities({...sdk,ModelRuntime:{}},'99.0.0'),/ModelRuntime.create/);
 assert.throws(()=>assertHostSdkCapabilities({...sdk,DefaultResourceLoader:class{}},'99.0.0'),/DefaultResourceLoader.reload/);
});
test('host resolver trusts identity and capabilities, rather than an exact package version',async()=>{
 const root=await mkdtemp(join(tmpdir(),'owned-sdk-probe-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'99.0.0',type:'module',exports:{'.':{import:'./index.js'}}}));
  await writeFile(join(root,'index.js'),`export function createAgentSession(){};export const ModelRuntime={create(){}};export const SettingsManager={create(){},inMemory(){}};export const SessionManager={create(){}};export class DefaultResourceLoader{reload(){}getExtensions(){}};export function createEventBus(){};export function resolveCliModel(){};export function createBashToolDefinition(){}`);
  assert.equal((await loadHostSdk(root)).root,await realpath(root));
  const bad=join(root,'wrong');await mkdir(bad);await writeFile(join(bad,'package.json'),JSON.stringify({name:'other-sdk',version:'99.0.0'}));await assert.rejects(loadHostSdk(bad),/Unsupported host Pi SDK identity/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('installed development SDK remains independently capability-compatible without replacing host',async()=>{
 const root=fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent',import.meta.url));
 const dev=await loadHostSdk(root),host=await loadHostSdk();assert.notEqual(dev.root,host.root);
});
test('session contract refuses unknown queue or lifecycle APIs before prompting',()=>{
 const session:any={agent:{state:{}},messages:[],pendingMessageCount:0,extensionRunner:{hasHandlers(){},emit(){}}};
 for(const name of ['prompt','abort','dispose','subscribe','bindExtensions','waitForIdle','getSteeringMessages','getFollowUpMessages'])session[name]=()=>{};
 assert.doesNotThrow(()=>assertHostSessionCapabilities(session));
 assert.throws(()=>assertHostSessionCapabilities({...session,pendingMessageCount:undefined}),/pendingMessageCount/);
 assert.throws(()=>assertHostSessionCapabilities({...session,waitForIdle:undefined}),/waitForIdle/);
});

async function fakeInstallation(layout:'nested'|'hoisted'|'multi-hoisted'|'symlink-store'){
 const base=await mkdtemp(join(tmpdir(),'owned-host-layout-'));
 const root=layout==='multi-hoisted'?join(base,'install/node_modules/wrapper/node_modules/@earendil-works/pi-coding-agent'):join(base,'install','node_modules','@earendil-works','pi-coding-agent');
 const put=async(path:string,value:string)=>{await mkdir(join(path,'..'),{recursive:true});await writeFile(path,value);};
 await put(join(root,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'99.0.0',type:'module',exports:{'.':{import:'./dist/index.js'}}}));
 const exports=`export function createAgentSession(){};export const ModelRuntime={create(){}};export const SettingsManager={create(){},inMemory(){}};export const SessionManager={create(){}};export class DefaultResourceLoader{reload(){}getExtensions(){}};export function createEventBus(){};export function resolveCliModel(){};export function createBashToolDefinition(){}`;
 await put(join(root,'dist/index.js'),exports);
 for(const file of ['core/agent-session.js','core/session-manager.js','core/sdk.js','bundle/cli.js'])await put(join(root,'dist',file),'// fixture');
 for(const name of ['pi-agent-core','pi-ai','pi-tui']){
  const dep=layout==='nested'?join(root,'node_modules','@earendil-works',name):layout==='symlink-store'?join(base,'store',name):join(base,'install/node_modules/@earendil-works',name);
  if(layout==='symlink-store'){const link=join(root,'node_modules','@earendil-works',name);await mkdir(join(link,'..'),{recursive:true});await mkdir(dep,{recursive:true});await symlink(dep,link);}
  await put(join(dep,'package.json'),JSON.stringify({name:'@earendil-works/'+name,version:'99.0.0',type:'module',exports:{'.':{import:'./dist/index.js'}}}));
  for(const file of ['index.js',...(name==='pi-agent-core'?['agent.js']:[]),...(name==='pi-ai'?['utils/event-stream.js']:[])])await put(join(dep,'dist',file),'// fixture');
 }
 return {base,root,cleanup:()=>rm(base,{recursive:true,force:true})};
}
for(const layout of ['nested','hoisted','multi-hoisted','symlink-store'] as const)test(`frozen host ${layout}: direct and symlink/global-like entry, future version and deployment replacement`,async()=>{
 const f=await fakeInstallation(layout),previous=process.argv[1];try{
  const cli=join(f.root,'dist/bundle/cli.js');process.argv[1]=cli;
  const identity=await captureHostSdkIdentity();assert.equal(identity.packageVersion,'99.0.0');assert.equal((await loadFrozenHostSdk(identity)).root,await realpath(f.root));
  const link=join(f.base,'pi');await symlink(cli,link);process.argv[1]=link;assert.equal((await captureHostSdkIdentity()).digest,identity.digest);
  process.argv[1]=fileURLToPath(new URL('../src/runtime/child-runner.mjs',import.meta.url));
  assert.equal((await loadFrozenHostSdk(identity)).root,identity.root);
  for(const file of [join(f.root,'dist/index.js'),join(await resolveHostDependencyRoot(f.root,'@earendil-works/pi-agent-core'),'dist/agent.js')]){
   const {readFile}=await import('node:fs/promises');const original=await readFile(file);await writeFile(file,Buffer.concat([original,Buffer.from('\n// replaced')]));await assert.rejects(validateHostSdkIdentity(identity),/deployment changed/);await writeFile(file,original);
  }
  await assert.rejects(loadFrozenHostSdk(undefined),/legacy intent/);
  await assert.rejects(validateHostSdkIdentity({...identity,digest:'0'.repeat(64)}),/digest mismatch/);
 }finally{process.argv[1]=previous;await f.cleanup();}
});
test('no frozen identity never falls back to extension SDK or environment; invalid root fails before session creation',async()=>{
 const {openOwnedChild}=await import('../src/runtime/child-session.ts');const prior=process.env.PI_GRAPH_HOST_SDK_ROOT;process.env.PI_GRAPH_HOST_SDK_ROOT=fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent',import.meta.url));
 try{await assert.rejects(openOwnedChild({params:{hostSdkRoot:process.env.PI_GRAPH_HOST_SDK_ROOT},hostSdkRoot:process.env.PI_GRAPH_HOST_SDK_ROOT} as any,()=>{throw Error('Unexpected startup event');}),/frozen host Pi SDK identity/);}finally{if(prior===undefined)delete process.env.PI_GRAPH_HOST_SDK_ROOT;else process.env.PI_GRAPH_HOST_SDK_ROOT=prior;}
});

test('invalid inner dependency cannot be skipped in favor of a valid hoisted package',async()=>{
 const f=await fakeInstallation('hoisted');try{
  const inner=join(f.root,'node_modules/@earendil-works/pi-ai');await mkdir(inner,{recursive:true});await writeFile(join(inner,'package.json'),JSON.stringify({name:'not-pi-ai',version:'1.0.0'}));
  await assert.rejects(resolveHostDependencyRoot(f.root,'@earendil-works/pi-ai'),/dependency identity mismatch/);
 }finally{await f.cleanup();}
});
