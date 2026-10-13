/** Durable independent process observer: parent Pi may reload or exit without losing close proof. */
import {spawn}from'node:child_process';import{readFile,open,rename,mkdir}from'node:fs/promises';import{join,dirname}from'node:path';import{fileURLToPath}from'node:url';import{randomUUID}from'node:crypto';
const path=process.argv[2],intent=JSON.parse(await readFile(path,'utf8'));
if(intent.version!==1||intent.runtimeKind!=='pi-graph-sdk/1'||typeof intent.runnerProcessInstanceId!=='string')throw Error('Invalid guardian intent');
if(intent.continuation){const {guardContinuation}=await import('./continuation-guardian.mjs');const r=await guardContinuation(intent,process.argv.slice(3));process.exit(r.exitCode===0||r.parked?0:1);}
const atomic=async(name,value)=>{const target=join(intent.asyncDir,name),tmp=target+'.'+randomUUID()+'.tmp',h=await open(tmp,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close()}await rename(tmp,target);const d=await open(intent.asyncDir,'r');try{await d.sync()}finally{await d.close()}};
const child=spawn(process.execPath,[fileURLToPath(new URL('./child-runner.mjs',import.meta.url)),path,...process.argv.slice(3)],{cwd:intent.params.cwd,stdio:['ignore','ignore','ignore'],env:process.env});
let started=false;child.once('spawn',()=>{started=true});
const outcome=await new Promise(resolve=>{child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));child.once('error',()=>{})});
if(started&&child.pid!==undefined){const at=Date.now(),proof={version:1,runtimeKind:'pi-graph-sdk/1',state:'observed',runId:intent.runId,runnerProcessInstanceId:intent.runnerProcessInstanceId,observedAt:at,instances:[{kind:'runner',processInstanceId:intent.runnerProcessInstanceId,pid:child.pid,closeObservedAt:at,exitCode:outcome.exitCode,signal:outcome.signal}]};await atomic('process-terminal.json',proof);}
let status;try{status=JSON.parse(await readFile(join(intent.asyncDir,'status.json'),'utf8'))}catch{status={runId:intent.runId,sessionId:intent.sessionId,runtimeKind:intent.runtimeKind}};
if(!['complete','failed','stopped','paused'].includes(status.state)){status.state='failed';status.error='SDK worker exited before publishing a final result';}
if(started)status.processTerminal={runnerProcessInstanceId:intent.runnerProcessInstanceId};await atomic('status.json',status);
process.exitCode=outcome.exitCode===0?0:1;
