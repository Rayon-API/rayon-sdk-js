import assert from "node:assert/strict";
import { test } from "node:test";
import { parseResult } from "../src/response.js";
import { MockAgent } from "undici";
import { RayonClient, RayonError, type HeaderShapeRequest } from "../src/index.js";
const shape: HeaderShapeRequest = {source_url:"https://shop.example.com/", profile:{}, request:{url:"https://shop.example.com/api/action", method:"POST", content_type:"application/json", body:"{}"}};
const result = {headers:Object.fromEntries([..."abcdfz"].map(s=>[`X-Test-${s}`,s==="d"?"":"value"])), request_id:"req-managed", generation_ms:0, profile_used:{}, material_ref:"ref_0123456789abcdef", material_expires_at:"2099-01-01T00:00:00Z"};
test("managed requests stay omitted after explicit cache entries and material rotation", async()=>{
  const agent=new MockAgent(); agent.disableNetConnect();
  const calls: any[]=[];
  for(let i=0;i<4;i++) agent.get("https://api.rayonapi.com").intercept({path:"/v1/shape",method:"POST"}).reply(200, opts=>{ calls.push(JSON.parse(String(opts.body))); return {...result,material_ref:`ref_0123456789abcde${i}`}; });
  const client=new RayonClient("test-key",{dispatcher:agent});
  try {
    await client.generate({...shape,scripts:[{url:"https://shop.example.com/a.js",source:"/* authored */"}]});
    for(let i=0;i<3;i++) await client.generate(shape);
    for(const body of calls.slice(1)){assert.ok(!Object.hasOwn(body,"scripts")); assert.ok(!Object.hasOwn(body,"material_ref"));}
    assert.deepEqual(shape.profile,{}); agent.assertNoPendingInterceptors();
  } finally {await client.close(); await agent.close();}
});
test("explicit invalid fields, automatic forms and materialless preparation stay invalid",async()=>{
  const client=new RayonClient("test-key");
  try {for(const value of [{scripts:null},{scripts:[]},{material_ref:null},{material_ref:""},{scripts:[],material_ref:"ref_0123456789abcdef"},{mode:"form",request:{...shape.request,content_type:"application/x-www-form-urlencoded",body:"a=b"}}]) await assert.rejects(client.generate({...shape,...value} as any), e=>e instanceof RayonError&&e.kind==="validation");
    await assert.rejects(client.prepare(shape), e=>e instanceof RayonError&&e.kind==="validation");
  } finally {await client.close();}
});
test("results retain safe operation metadata including a fractional discovery duration",async()=>{
  const agent=new MockAgent(); agent.disableNetConnect();
  const metadata={path:"isolated",material_reuse:false,discovery_duration_ms:12.5,discovery_state:"failed",fallback_reason:"unknown_material",fallback_message:"A fallback was used. Contact support with this request ID."};
  agent.get("https://api.rayonapi.com").intercept({path:"/v1/shape",method:"POST"}).reply(200,{...result,...metadata});
  const client=new RayonClient("test-key",{dispatcher:agent});
  try {const value=await client.generate(shape); for(const [k,v] of Object.entries(metadata)) assert.equal((value as any)[k],v);}
  finally {await client.close();await agent.close();}
});

for (const changes of [{path:"other"},{material_reuse:1},{discovery_duration_ms:-1},{discovery_duration_ms:Infinity},{discovery_state:"unsafe detail"},{fallback_reason:"unsafe detail"},{fallback_message:"unsafe\nmessage"}]) {
  test("rejects malformed operation metadata: "+JSON.stringify(changes),()=>{
    assert.throws(()=>parseResult({...result,...changes},{},"test-key"),e=>e instanceof RayonError&&e.kind==="invalid_response");
  });
}
test("nullable metadata and zero duration remain valid",()=>{
  const value=parseResult({...result,path:"native",material_reuse:true,discovery_duration_ms:0,discovery_state:null,fallback_reason:null},{},"test-key");
  assert.equal(value.discovery_duration_ms,0);assert.equal(value.fallback_reason,null);
});
