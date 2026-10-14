import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { MockAgent } from "undici";
import { RayonClient, RayonError, type HeaderShapeRequest } from "../src/index.js";
import { parseResult } from "../src/response.js";

const key = "test-secret-key";
function headers(): Record<string, string> {
  return {
    ...Object.fromEntries([..."abcdfz"].map(s => [`Exact-Base-${s}`, s === "d" ? "" : "original-value"])),
    "eXACT-bASE-A0": "fresh-supplement+/%=",
  };
}
function result(value = headers()) {
  return {
    headers: value, request_id: "req-123", generation_ms: 12, profile_used: {},
    material_ref: "ref_0123456789abcdef", material_expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}
function shape(): HeaderShapeRequest {
  return {
    source_url: "https://example.com/page", scripts: [{ url: "https://example.com/owned.js", source: "/* owned */" }],
    profile: {}, request: { url: "https://example.com/page", method: "GET", content_type: null, body: null },
  };
}
const invalidResponse = (error: unknown) => error instanceof RayonError && error.kind === "invalid_response";

for (const explicitMode of [false, true]) {
  test(`optional a0 preserves original names and values with explicit mode ${explicitMode}`, async () => {
    const mock = new MockAgent(); mock.disableNetConnect();
    const request = shape(); if (explicitMode) request.mode = "header";
    mock.get("https://api.rayonapi.com").intercept({ path: "/v1/shape", method: "POST", body: JSON.stringify(request) }).reply(200, result());
    const client = new RayonClient(key, { dispatcher: mock });
    try {
      const generated = await client.generate(request);
      assert.deepEqual({ ...generated.headers }, headers());
      assert.ok(!inspect(generated).includes("fresh-supplement"));
    } finally { await client.close(); await mock.close(); }
  });
}

test("optional a0 is fresh when material is reused", async () => {
  const mock = new MockAgent(); mock.disableNetConnect();
  const firstRequest = shape();
  const cached = { ...firstRequest, scripts: undefined, material_ref: "ref_0123456789abcdef" };
  mock.get("https://api.rayonapi.com").intercept({ path: "/v1/shape", method: "POST", body: JSON.stringify(firstRequest) }).reply(200, result());
  mock.get("https://api.rayonapi.com").intercept({ path: "/v1/shape", method: "POST", body: JSON.stringify(cached) }).reply(200, result({ ...headers(), "eXACT-bASE-A0": "next-fresh-value" }));
  const client = new RayonClient(key, { dispatcher: mock });
  try {
    const first = await client.generate(firstRequest), second = await client.generate(shape());
    assert.equal(first.headers["eXACT-bASE-A0"], "fresh-supplement+/%=");
    assert.equal(second.headers["eXACT-bASE-A0"], "next-fresh-value");
    mock.assertNoPendingInterceptors();
  } finally { await client.close(); await mock.close(); }
});

for (const suffix of "abcdfz") test(`a0 never replaces required header ${suffix}`, () => {
  const value = headers(); delete value[`Exact-Base-${suffix}`];
  assert.throws(() => parseResult(result(value), {}, key), invalidResponse);
});

for (const extra of [
  { "Other-a0": "value" }, { "Exact-Base-a1": "value" }, { "Exact-Base-A": "value" },
  { "Exact-Base-a0": "duplicate" }, { "eXACT-bASE-A0": "" }, { "eXACT-bASE-A0": "a b" },
  { "eXACT-bASE-A0": "unsafe\r\n" }, { "eXACT-bASE-A0": "é" }, { "Exact-Base-a0\n": "value" }, { "eXACT-bASE-A0": 123 },
  { ["p".repeat(129) + "-a0"]: "value" },
]) test(`rejects invalid optional a0 ${JSON.stringify(extra)}`, () => {
  const value = headers();
  if (!("Exact-Base-a0" in extra)) delete value["eXACT-bASE-A0"];
  assert.throws(() => parseResult(result({ ...value, ...extra } as Record<string, string>), {}, key), invalidResponse);
});

test("optional a0 obeys the response byte limit", async () => {
  const mock = new MockAgent(); mock.disableNetConnect();
  mock.get("https://api.rayonapi.com").intercept({ path: "/v1/shape", method: "POST" }).reply(200, result({ ...headers(), "eXACT-bASE-A0": "x".repeat(256 * 1024) }));
  const client = new RayonClient(key, { dispatcher: mock });
  try { await assert.rejects(client.generate(shape()), invalidResponse); }
  finally { await client.close(); await mock.close(); }
});


for (const prefix of ["CuKtomer", "Cuſtomer", "Cuıstomer", "Cuİstomer"])
  for (const optionalA0 of [false, true])
    test(`header family requires ASCII tokens ${prefix}, optional a0 ${optionalA0}`, () => {
      const suffixes = [..."abcdfz", ...(optionalA0 ? ["A0"] : [])];
      const value = Object.fromEntries(suffixes.map(suffix => [
        `${prefix}-${suffix}`, suffix === "d" ? "" : "value",
      ]));
      assert.throws(() => parseResult(result(value), {}, key), invalidResponse);
    });
