import assert from "node:assert/strict";
import { test } from "node:test";
import { MockAgent } from "undici";
import { RayonClient, RayonError, type HeaderShapeRequest } from "../src/index.js";

const shape: HeaderShapeRequest = {source_url:"https://shop.example.com/", profile:{}, request:{url:"https://shop.example.com/action", method:"POST", content_type:"application/json", body:"{}"}};
const response = {headers:Object.fromEntries([..."abcdfz"].map(s=>[`X-Fixture-${s}`,s==="d"?"":"value"])), request_id:"req-owned", generation_ms:1, profile_used:{}, material_ref:"ref_0123456789abcdef", material_expires_at:"2099-01-01T00:00:00Z"};

test("preparation fallback retains degraded metadata without retrying", async()=>{
  const agent=new MockAgent();agent.disableNetConnect();
  let calls=0;
  agent.get("https://api.rayonapi.com").intercept({path:"/v1/shape",method:"POST",headers:{"x-rayon-capabilities":"managed-fallback-v1"}}).reply(200,options=>{
    calls++;assert.deepEqual(JSON.parse(String(options.body)),shape);
    return {...response,path:"isolated",fallback_reason:"material_preparing"};
  });
  const client=new RayonClient("test-key",{dispatcher:agent});
  try {
    const result=await client.generate(shape);
    assert.equal(result.path,"isolated");assert.equal(result.fallback_reason,"material_preparing");
    assert.equal(calls,1);agent.assertNoPendingInterceptors();
  }finally{await client.close();await agent.close();}
});

for(const metadata of [{path:"isolated"},{path:"isolated",fallback_reason:"other_reason"},{path:"native",fallback_reason:"material_preparing"},{fallback_reason:"material_preparing"},{path:"other",fallback_reason:"material_preparing"}]){
  test("inconsistent or unknown fallback remains invalid: "+JSON.stringify(metadata),async()=>{
    const agent=new MockAgent();agent.disableNetConnect();
    agent.get("https://api.rayonapi.com").intercept({path:"/v1/shape",method:"POST"}).reply(200,{...response,...metadata});
    const client=new RayonClient("test-key",{dispatcher:agent});
    try{await assert.rejects(client.generate(shape),e=>e instanceof RayonError&&e.kind==="invalid_response");agent.assertNoPendingInterceptors();}
    finally{await client.close();await agent.close();}
  });
}
