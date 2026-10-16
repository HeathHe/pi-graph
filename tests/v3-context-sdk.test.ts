import {captureHostSdkIdentity} from '../src/runtime/host-sdk.ts';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const selected=process.env.PI_GRAPH_CONTEXT_SDK_CASE;
const skip=(mode:string)=>Boolean(selected&&selected!==mode);

async function runFixture(mode:string,policy?:'v1'|'disabled'){
 const child=spawn(process.execPath,['--import',fileURLToPath(new URL('./helpers/supervisor-sdk-loader.mjs',import.meta.url)),fileURLToPath(new URL(mode.startsWith('lazy-')?'./helpers/context-lazy-sdk.mjs':'./helpers/context-sdk-roundtrip.mjs',import.meta.url)),mode.replace(/^lazy-/, '')],{stdio:['ignore','pipe','pipe'],env:{...process.env,PI_GRAPH_TEST_HOST_SDK:(await captureHostSdkIdentity()).root,...(policy?{PI_GRAPH_CONTEXT_TEST_POLICY:JSON.stringify(policy)}:{})}});
 let output='';child.stdout.on('data',c=>{output+=String(c);});child.stderr.on('data',c=>{output+=String(c);});
 const timer=setTimeout(()=>child.kill('SIGTERM'),25000);
 try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,output);console.log(output.trim());assert.ok(output.includes(mode.startsWith('lazy-')?'PASS actual runner accepted artifact -> guarded SDK lazy '+mode.replace(/^lazy-/,''):'PASS actual frozen guarded SDK context '+mode));}
 finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');}
}
test('actual frozen Graph SDK baseline executes read twice and preserves both context/session bodies',{timeout:30000,skip:skip('baseline')},async()=>{
 await runFixture('baseline');
});
for(const mode of ['repeat','changed','offset','image','errors','custom','inert'])test('actual SDK context policy '+mode,{timeout:30000,skip:skip(mode)},async()=>{await runFixture(mode,'v1');});
test('explicit disabled policy preserves actual SDK original bodies',{timeout:30000,skip:skip('disabled')},async()=>{await runFixture('baseline','disabled');});

for(const mode of ['lazy','unread','single-line','pre-tamper','race-tamper','post-tamper'])test('actual runner and SDK lazy '+mode,{timeout:30000,skip:skip('lazy-'+mode)},async()=>{await runFixture('lazy-'+mode);});
