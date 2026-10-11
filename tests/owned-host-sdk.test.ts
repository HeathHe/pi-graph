import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadHostSdk,assertHostSdkCapabilities,assertHostSessionCapabilities} from '../src/runtime/host-sdk.ts';
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
