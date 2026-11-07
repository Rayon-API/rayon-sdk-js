import assert from "node:assert/strict";
import { test } from "node:test";
import { MockAgent } from "undici";
import { RayonClient, RayonError } from "../src/index.js";
const context={source_url:"https://example.com/",profile:{},request:{url:"https://example.com/api",method:"POST",content_type:"application/json",body:"{}"}};
const reference="ref_0123456789abcdef";
test("raw sources are rejected before transport",async()=>{
 const agent=new MockAgent();agent.disableNetConnect();const client=new RayonClient("test-key",{dispatcher:agent});
 try {await assert.rejects(client.generate({...context,scripts:[{url:"https://example.com/a.js",source:"/* owned fixture */"}]} as any),e=>e instanceof RayonError&&e.kind==="validation");}
 finally {await client.close();await agent.close();}
});
for(const [code,status]of[["material_expired",422],["material_not_prepared",409],["capacity_exceeded",429]]as const){
 test(code+" never uploads sources, starts preparation or retries",async()=>{
  const agent=new MockAgent();agent.disableNetConnect();let calls=0;
  agent.get("https://api.rayonapi.com").intercept({path:"/v1/shape",method:"POST"}).reply(status,options=>{
   calls++;const input=JSON.parse(String(options.body));assert.equal(input.material_ref,reference);assert.ok(!("scripts"in input));return{error:{code,billing_status:"not_charged"}};
  });
  const client=new RayonClient("test-key",{dispatcher:agent});
  try {await assert.rejects(client.generate({...context,material_ref:reference}),e=>e instanceof RayonError&&e.statusCode===status);assert.equal(calls,1);}
  finally {await client.close();await agent.close();}
 });
}
test("unexpected fallback is surfaced without retry",async()=>{
 const agent=new MockAgent();agent.disableNetConnect();agent.get("https://api.rayonapi.com").intercept({path:"/v1/shape",method:"POST"}).reply(200,{path:"isolated",fallback_reason:"unknown_material"});
 const client=new RayonClient("test-key",{dispatcher:agent});
 try {await assert.rejects(client.generate({...context,material_ref:reference}),e=>e instanceof RayonError&&e.kind==="invalid_response");}
 finally {await client.close();await agent.close();}
});
