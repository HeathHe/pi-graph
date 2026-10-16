import assert from "node:assert/strict";
import test from "node:test";
import { compactToolReceipt } from "../src/v3/ui/tool-receipt.ts";
import { pageGraphData } from "../src/v3/result-receipt.ts";

const hash = "a".repeat(64);
const id = "graph-123456789abcdef123456789";
const render = (action: string, body: unknown, details: unknown = {}, error = false) => compactToolReceipt(action, JSON.stringify(body), details, error);

test("attention summarizes verified total without exposing paging JSON or request text", () => {
 const page = pageGraphData({ requests: [{requestId: hash, message: "private decision text"}], snapshot: {graphId:id} }, 0, 10, {action:"attention",id});
 const text = render("attention", page, {requestCount:1});
 assert.match(text, /待处理事项：1 项/);
 for (const hidden of [hash, id, "private decision text", "sha256", "nextRequest", "{"]) assert.ok(!text.includes(hidden));
 assert.equal(render("attention", page, {requestCount:0}), "本次读取没有待处理事项。展开查看详情。");
});
test("attention only counts a fully readable first page and preserves uncertainty for partial pages", () => {
 const data = {requests:[{message:"one"},{message:"two"}]};
 assert.match(render("attention",pageGraphData(data)), /2 项/);
 assert.match(render("attention",pageGraphData(data, 0, 3)), /仍有后续内容/);
 assert.ok(!render("attention",pageGraphData(data, 1)).includes("2 项"));
 assert.match(render("attention",pageGraphData(data),{requestCount:0}), /数量需核对/);
 assert.ok(!render("attention",{}, {requestCount:-1}).includes("-1"));
 assert.ok(!render("attention",{}, {requestCount:1.5}).includes("1.5"));
});
test("mailbox distinguishes queued, delivered, acknowledged, and replied receipts", () => {
 const expectations = {queued:"已入队",delivered:"已送达",acknowledged:"已确认",replied:"已回复",recipient_closed:"收件任务已结束",stale_attempt:"较早的执行轮次"};
 for (const [state, expected] of Object.entries(expectations)) {
  const text = render("mailbox",{state,messageId:hash,from:id,to:"@parent",digest:hash});
  assert.match(text,new RegExp(expected)); assert.ok(!text.includes(hash));assert.ok(!text.includes(id));assert.ok(!text.includes("任务完成"));
 }
 assert.ok(!render("mailbox",{state:"queued"}).includes("已送达"));
});
test("mailbox inbox and text pages retain count and continuation without exposing message body", () => {
 assert.match(render("mailbox",{messages:[{messageId:hash},{messageId:hash}],nextOffset:8}),/本页收到 2 条消息，仍有后续内容/);
 assert.match(render("mailbox",{messages:[],pending:true}),/暂未收到新消息/);
 assert.match(render("mailbox",{messages:[]}),/本页没有消息/);
 const text=render("mailbox",{text:"private result body",offset:0,nextOffset:500,messageId:hash});
 assert.match(text,/消息正文已读取，仍有后续内容/);assert.ok(!text.includes("private"));
});
test("result paging does not claim task completion or verified completeness", () => {
 assert.match(render("result",{text:"output",complete:true,nextOffset:2500,sha256:hash}),/仍有后续内容/);
 assert.match(render("result",{text:"output",complete:null,nextOffset:null}),/完整性尚未确认/);
 assert.match(render("result",{text:"output",complete:false,nextOffset:null}),/记录不完整/);
 assert.equal(render("result",{text:"output",complete:true,nextOffset:null}),"output\n结果已读取 · 验收待确认 · 展开查看详情。");
 assert.ok(!render("result",{complete:true}).includes("任务完成"));
});
test("source_changed is reading recovery even if tool result is marked as an error", () => {
 const details={code:"source_changed",sha256:hash,restartRequest:{action:"attention",id,offset:0,limit:4096}};
 for(const value of [render("attention",{},details,true),render("result",details,{},true)]){
  assert.match(value,/读取快照已更新或失效，请从第一页重新读取/);assert.match(value,/重读入口/);
  for(const hidden of [hash,id,"source_changed","失败","未完成","{"])assert.ok(!value.includes(hidden));
 }
});
test("real errors retain readable cause and hide raw machine metadata", () => {
 assert.match(compactToolReceipt("mailbox","Mailbox owner mismatch",{},true),/当前会话无权访问/);
 assert.match(compactToolReceipt("result","Accepted result evidence failed verification",{},true),/结果记录校验未通过/);
 assert.match(compactToolReceipt("result","磁盘空间不足，无法读取记录",{},true),/磁盘空间不足/);
 const text=compactToolReceipt("result",`Cannot read /Users/example/private/output.json ${hash} ${id}`,{},true);
 assert.match(text,/Cannot read/);for(const hidden of [hash,id,"/Users/"])assert.ok(!text.includes(hidden));
 const json=render("mailbox",{code:"other",error:"unknown",hash}, {},true);assert.ok(!json.includes(hash));assert.ok(!json.includes("{"));
});
test("malformed or oversized envelopes are bounded and do not mutate original payloads", () => {
 const body={messages:[{messageId:hash}],nextOffset:null};const details={requestCount:1};
 const before=JSON.stringify({body,details});render("mailbox",body,details);assert.equal(JSON.stringify({body,details}),before);
 for(const text of ["{broken", "x".repeat(100000), "\u001b[31m"+"错".repeat(1000)]){
  const output=compactToolReceipt("attention",text,{},true);assert.ok(Array.from(output).length<=170);assert.ok(!output.includes("\u001b"));
 }
 assert.equal(compactToolReceipt("unknown","secret",null,false),"操作信息已返回。展开查看详情。");
});

test("inactive mailbox compact receipt states non-delivery and no retry while retaining expanded facts",()=>{
 const payload={code:"mailbox_inactive",taskEnded:true,action:"send",delivery:"not_sent",taskRestarted:false,canRetry:false,readOnlyActions:["receive","read","status"],message:"任务已结束，消息未发送；后续要求交给主会话，不会重新启动旧任务。"};const text=JSON.stringify(payload),before=JSON.stringify(payload);const compact=compactToolReceipt("mailbox",text,payload,true);assert.match(compact,/消息未发送.*主会话.*不可自动重试.*不会重启/);assert.doesNotMatch(compact,/已入队|已送达|已完成/);assert.equal(JSON.stringify(payload),before);assert.equal(JSON.parse(text).delivery,"not_sent");
});
