import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url),{default:register}=await jiti.import<any>('../extensions/pi-graph.ts');
function fixture(){let tool:any;register({events:{on(){return()=>{};}},on(){},registerTool(t:any){tool=t;},registerCommand(){}});return tool;}
const theme={fg:(c:string,s:string)=>`[${c}]${s}`,bg:(_c:string,s:string)=>s,bold:(s:string)=>s,italic:(s:string)=>s};
for(const action of ['attention','mailbox','result'])test(`registered ${action} hides default machine content and private payload while expanded preserves text`,()=>{
 const tool=fixture(),privateText='PRIVATE-SECRET-FIXTURE',payload=action==='mailbox'?{messages:[{text:privateText}],hasMore:true}:{unit:'unicode-code-points',sha256:'a'.repeat(64),offset:0,text:JSON.stringify({requests:[{message:privateText}]}),nextOffset:20};
 const text=JSON.stringify(payload),response={content:[{type:'text',text}],details:{graphId:'private-long-machine-graph-id',requestCount:1,nextOffset:20}},ctx:any={args:{action,id:'private-long-machine-graph-id'},state:{},toolCallId:action,isError:false};const before=JSON.stringify(response);
 const collapsed=tool.renderResult(response,{expanded:false,isPartial:false},theme,ctx).render(80).join('\n');assert.doesNotMatch(collapsed,/PRIVATE-SECRET|sha256|unicode-code-points|"|private-long-machine/);
 const call=tool.renderCall(ctx.args,theme,ctx).render(80).join('\n');assert.doesNotMatch(call,/PI-GRAPH|private-long-machine/);assert.match(call,/待处理信息|邮箱|读取结果/);
 const expanded=tool.renderResult(response,{expanded:true,isPartial:false},theme,ctx).render(10000).join('\n');assert.ok(expanded.includes(text));assert.equal(JSON.stringify(response),before);
});
test('registered recoverable source update keeps machine error protocol, colors call/result as warning, actual digest failure remains red',()=>{
 const tool=fixture(),ctx:any={args:{action:'attention',id:'graph'},state:{},toolCallId:'recover',isError:false};const response={isError:false,content:[{type:'text',text:JSON.stringify({code:'source_changed',restartRequest:{action:'attention',id:'graph',offset:0,limit:4096}})}],details:{code:'source_changed'}};const before=JSON.stringify(response);
 const collapsed=tool.renderResult(response,{expanded:false,isPartial:false},theme,ctx).render(80).join('\n');assert.match(collapsed,/读取快照已更新或失效，请从第一页重新读取/);assert.match(collapsed,/\[warning\]/);assert.doesNotMatch(collapsed,/\[error\]/);assert.match(tool.renderCall(ctx.args,theme,ctx).render(80).join('\n'),/\[warning\]/);assert.equal(JSON.stringify(response),before);
 const failed=tool.renderResult({content:[{type:'text',text:'Full output differs from attempt-bound digest'}]},{expanded:false,isPartial:false},theme,{...ctx,args:{action:'result'},state:{},isError:true}).render(80).join('\n');assert.match(failed,/\[error\]/);assert.match(failed,/校验|完整性|digest/);
});
test('unrelated templates, agents and doctor lists retain original default text rendering',()=>{const tool=fixture();for(const action of ['templates','agents','doctor']){const text='first item\nsecond useful item\nthird item',ctx:any={args:{action},state:{},toolCallId:action,isError:false};const rendered=tool.renderResult({content:[{type:'text',text}]},{expanded:false,isPartial:false},theme,ctx).render(80).join('\n');for(const line of text.split('\n'))assert.ok(rendered.includes(line));}});
test('public tool contract bounds automatic recovery and forbids task replay',()=>{const tool=fixture();assert.match(tool.description,/recoverable:true and isError:false/);assert.match(tool.description,/at most once/);assert.match(tool.description,/never rerun, retry, stop or replay/);assert.match(tool.description,/10-minute maximum lifetime/);});
