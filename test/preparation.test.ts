import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { MockAgent } from 'undici';
import { RayonClient, RayonError } from '../src/index.js';
const id='prep_0123456789abcdef';
const path=`/v1/materials/preparations/${id}`;
const shape:any={source_url:'https://example.com/',scripts:[{url:'https://example.com/a.js',source:'private-source'}],profile:{language:'en'},request:{url:'https://example.com/',method:'GET',content_type:null,body:null}};
const frame=(state='queued', changes={})=>({preparation_id:id,state,status_url:path,retry_after_ms:0,preparation_expires_at:'2030-01-01T00:00:00Z',material_ref:'ref_0123456789abcdef',material_expires_at:'2030-01-01T00:00:00Z',ready_until:state==='ready'?'2030-01-01T00:00:00Z':null,execution_backend:state==='ready'?'rust':null,error:null,...changes});
let mock:MockAgent,client:RayonClient;
beforeEach(()=>{mock=new MockAgent();mock.disableNetConnect();client=new RayonClient('secret-api-key',{dispatcher:mock});});
afterEach(async()=>{await client.close();await mock.close();});
test('prepare sends unchanged full context with a unique idempotency key and accepts 202',async()=>{
 const keys:string[]=[];
 for(let i=0;i<2;i++)mock.get('https://api.rayonapi.com').intercept({path:'/v1/materials/prepare',method:'POST'}).reply(options=>{assert.deepEqual(JSON.parse(options.body as string),shape);const headers=options.headers as Record<string,string>;assert.ok(headers['idempotency-key']);keys.push(headers['idempotency-key']);return {statusCode:202,data:frame()};});
 assert.equal((await client.prepare(shape)).state,'queued');await client.prepare(shape);assert.notEqual(keys[0],keys[1]);
});
test('explicit waiting long polls until ready and returns only safe metadata',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(200,frame('validating'));
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(200,frame('ready'));
 const ready=await client.waitUntilReady(id);assert.equal(ready.execution_backend,'rust');assert.ok(!('scripts' in ready));assert.equal(ready.preparation_id,id);
});
test('generation remains explicit: prepareAndWait never calls shape',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:'/v1/materials/prepare',method:'POST'}).reply(200,frame('ready'));
 assert.equal((await client.prepareAndWait(shape)).state,'ready');
});
for(const changes of [{status_url:'https://evil.test/'+id},{preparation_id:'short'},{retry_after_ms:60001},{execution_backend:'javascript'},{extra:'private-source'},{error:{message:'private-source'}},{ready_until:null}])test('rejects malformed ready metadata '+JSON.stringify(changes),async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=0',method:'GET'}).reply(200,frame('ready',changes));
 await assert.rejects(client.getPreparation(id),e=>e instanceof RayonError && e.kind==='invalid_response');
});
test('rejects duplicate preparation fields',async()=>{
 const text=JSON.stringify(frame()).replace('"state":"queued"','"state":"queued","state":"queued"');
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=0',method:'GET'}).reply(200,text);
 await assert.rejects(client.getPreparation(id),e=>e instanceof RayonError && e.kind==='invalid_response');
});
test('failed preparation exposes only safe typed resumable error',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(200,frame('failed',{error:{code:'preparation_failed'}}));
 await assert.rejects(client.waitUntilReady(id),e=>e instanceof RayonError && e.kind==='preparation_failed' && e.preparationId===id);
});
test('wait deadline and cancellation preserve ID and do not cancel server job',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(client.waitUntilReady(id,{signal:controller.signal}),e=>e instanceof RayonError && e.kind==='aborted' && e.preparationId===id);
 await assert.rejects(client.waitUntilReady(id,{waitTimeoutMs:1}),e=>e instanceof RayonError && e.preparationId===id);
});
test('safe failed error drops arbitrary action and unsafe reason',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=0',method:'GET'}).reply(200,frame('failed',{error:{code:'preparation_failed',reason:'private-source',action:'private-cookie',retryable:false}}));
 const result=await client.getPreparation(id);assert.deepEqual(result.error,{code:'preparation_failed',retryable:false});
});
test('transient GET retries while arbitrary generation requests are never involved',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(503,{error:{code:'unavailable'}});
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(200,frame('ready'));
 assert.equal((await client.waitUntilReady(id)).state,'ready');
});
test('GET failures include the validated resumable ID',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=0',method:'GET'}).reply(404,{error:{code:'not_found'}});
 await assert.rejects(client.getPreparation(id),e=>e instanceof RayonError && e.statusCode===404 && e.preparationId===id);
});
for(const changes of [{preparation_expires_at:'2030-02-30T00:00:00Z'},{ready_until:'2030-01-01T25:00:00Z'},{retry_after_ms:Infinity}])test('rejects invalid timestamps and nonfinite metadata '+JSON.stringify(changes),async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=0',method:'GET'}).reply(200,frame('ready',changes));
 await assert.rejects(client.getPreparation(id),e=>e instanceof RayonError && e.kind==='invalid_response');
});
test('bounds long poll by remaining wait time',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=0',method:'GET'}).reply(200,frame('ready'));
 assert.equal((await client.waitUntilReady(id,{waitTimeoutMs:500})).state,'ready');
});
test('cancellation during polling exposes resumable ID',async()=>{
 const signal=new AbortController();
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(200,frame('queued',{retry_after_ms:10000}));
 setTimeout(()=>signal.abort(),20);
 await assert.rejects(client.waitUntilReady(id,{signal:signal.signal}),e=>e instanceof RayonError && e.kind==='aborted' && e.preparationId===id);
});
for(const options of [{waitTimeoutMs:0},{waitTimeoutMs:NaN},{waitTimeoutMs:null},{signal:'invalid'}])test('prepareAndWait rejects invalid options before starting a job '+JSON.stringify(options),async()=>{
 await assert.rejects(client.prepareAndWait(shape,options as any),e=>e instanceof RayonError && e.kind==='validation');
});
test('explicit POST timeout is never replayed',async()=>{
 let calls=0;
 mock.get('https://api.rayonapi.com').intercept({path:'/v1/materials/prepare',method:'POST'}).reply(()=>{calls++;throw new Error('private-source');});
 await assert.rejects(client.prepare(shape),e=>e instanceof RayonError && e.kind==='network');assert.equal(calls,1);
});
test('wait long poll also respects the configured per-request timeout',async()=>{
 const paths:string[]=[];const dispatch=mock.dispatch.bind(mock);mock.dispatch=((options:any,handler:any)=>{paths.push(options.path);return dispatch(options,handler);}) as typeof mock.dispatch;
 const shortClient=new RayonClient('secret-api-key',{dispatcher:mock,timeoutMs:500});
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=0',method:'GET'}).reply(200,frame('ready'));
 try{assert.equal((await shortClient.waitUntilReady(id,{waitTimeoutMs:2000})).state,'ready');assert.deepEqual(paths,[path+'?wait=0']);}finally{await shortClient.close();}
});
test('transient HTTP408 retries the status read',async()=>{
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(408,{error:{code:'timeout'}});
 mock.get('https://api.rayonapi.com').intercept({path:path+'?wait=10',method:'GET'}).reply(200,frame('ready'));
 assert.equal((await client.waitUntilReady(id)).state,'ready');
});
