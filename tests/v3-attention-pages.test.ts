import assert from 'node:assert/strict';
import test from 'node:test';
import {AttentionPageSnapshots} from '../src/v3/attention-pages.ts';
import {GraphSourceChangedError} from '../src/v3/result-receipt.ts';
const identity={graphId:'graph',runInstanceId:'run',ownerSessionId:'owner',readerSessionId:'owner',readerSessionFile:'/session',runDir:'/run',authorization:'owner' as const};
const value={snapshot:{status:'running',updatedAt:'one'},requests:[{text:'中文😀"\\'.repeat(6000)}]};
test('attention continuations preserve immutable Unicode snapshot, digest and request count while latest changes',()=>{
 const cache=new AttentionPageSnapshots();const before=JSON.stringify(value);let page=cache.read(identity,value,0,8192);const hash=page.sha256;let text=page.text,count=1;const firstNext=page.nextRequest!;
 const changed={snapshot:{status:'complete',updatedAt:'two'},requests:[]};
 while(page.nextRequest){const q=page.nextRequest;page=cache.read(identity,changed,q.offset,q.limit,q.expectedSha256);assert.equal(page.sha256,hash);assert.equal(page.requestCount,1);assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(page)))<8192);text+=page.text;assert.ok(++count<1000);}
 assert.equal(text,before);assert.equal(JSON.stringify(value),before);assert.deepEqual(cache.read(identity,changed,firstNext.offset,firstNext.limit,firstNext.expectedSha256),cache.read(identity,changed,firstNext.offset,firstNext.limit,firstNext.expectedSha256));
 const fresh=cache.read(identity,changed);assert.notEqual(fresh.sha256,hash);assert.equal(fresh.requestCount,0);assert.equal(cache.read(identity,changed,firstNext.offset,firstNext.limit,firstNext.expectedSha256).sha256,hash);
});
test('TTL expiration and cold cache produce explicit restart without page text; last-page repeated reads remain valid until expiry',()=>{
 let now=0;const cache=new AttentionPageSnapshots({now:()=>now,ttlMs:10});const first=cache.read(identity,value,0,1),q=first.nextRequest!;
 now=9;assert.equal(cache.read(identity,value,q.offset,q.limit,q.expectedSha256).sha256,first.sha256);
 now=19;for(const c of [cache,new AttentionPageSnapshots()])assert.throws(()=>c.read(identity,value,q.offset,q.limit,q.expectedSha256),(e:any)=>e instanceof GraphSourceChangedError&&e.restartRequest.offset===0&&!('text'in e));
 assert.equal(cache.read(identity,{snapshot:{status:'complete'},requests:[]}).requestCount,0);
});
test('cache cannot cross graph, owner, reader, session file, run instance or canonical directory identities',()=>{
 const cache=new AttentionPageSnapshots(),first=cache.read(identity,value,0,1),q=first.nextRequest!;
 for(const field of Object.keys(identity))assert.throws(()=>cache.read({...identity,[field]:'foreign'},value,q.offset,q.limit,q.expectedSha256),GraphSourceChangedError);
});
test('bounded cache eviction and oversized first snapshot fail explicitly; invalid offsets/hash/budget never bypass validation',()=>{
 const cache=new AttentionPageSnapshots({maxEntries:1,maxBytes:10000}),first=cache.read(identity,{requests:[],payload:'x'.repeat(5000)},0,1),q=first.nextRequest!;
 cache.read({...identity,graphId:'other'},{requests:[],payload:'y'.repeat(5000)});assert.throws(()=>cache.read(identity,value,q.offset,q.limit,q.expectedSha256),GraphSourceChangedError);
 assert.throws(()=>cache.read(identity,{requests:[],payload:'x'.repeat(10001)}),/bounded read cache/);
 for(const limit of [0,8193])assert.throws(()=>cache.read(identity,value,0,limit),/page offset or limit/);
 assert.throws(()=>cache.read(identity,value,-1),/page offset/);assert.throws(()=>cache.read(identity,value,1,4096,'bad'),/64 hexadecimal/);
 cache.clear();assert.throws(()=>cache.read(identity,value,q.offset,q.limit,q.expectedSha256),GraphSourceChangedError);
});

test('valid continuation refreshes idle TTL but never exceeds hard snapshot lifetime; snapshot action is isolated and raw bytes preserved',()=>{
 let now=0;const cache=new AttentionPageSnapshots({now:()=>now,ttlMs:10,maxAgeMs:35});const first=cache.read(identity,value,0,1),q=first.nextRequest!;
 for(now of [9,18,27,34])assert.equal(cache.read(identity,value,q.offset,q.limit,q.expectedSha256).sha256,first.sha256);
 now=35;assert.throws(()=>cache.read(identity,value,q.offset,q.limit,q.expectedSha256),GraphSourceChangedError);
 const raw=' { "status": "running", "unicode": "中文😀" }\n',changed=' { "status": "complete" }\n';const a=cache.readSnapshot(identity,raw,0,1),next=a.nextRequest!;
 assert.throws(()=>cache.read(identity,value,next.offset,next.limit,next.expectedSha256),GraphSourceChangedError);
 assert.throws(()=>new AttentionPageSnapshots().readSnapshot(identity,changed,next.offset,next.limit,next.expectedSha256),GraphSourceChangedError);
 let page=a,full=a.text;while(page.nextRequest){const req=page.nextRequest;page=cache.readSnapshot(identity,changed,req.offset,req.limit,req.expectedSha256);full+=page.text;}assert.equal(full,raw);assert.notEqual(cache.readSnapshot(identity,changed).sha256,a.sha256);
});
