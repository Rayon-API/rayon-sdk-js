import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { inspect } from "node:util";
import { createServer } from "node:http";
import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import * as sdk from "../src/index.js";
const key = "test-secret-key",
  origin = "https://api.rayonapi.com",
  url = "https://example.com/page";
const previous = getGlobalDispatcher();
let mock: MockAgent;
function generate(
  value: sdk.ShapeRequest,
  apiKey: string,
  options: sdk.GenerateOptions = {},
) {
  return sdk.generate(value, apiKey, {
    dispatcher: getGlobalDispatcher(),
    ...options,
  });
}
function shape(changes: Record<string, unknown> = {}): any {
  return {
    source_url: url,
    scripts: [
      { url: "https://example.com/owned.js", source: "/* owned material */" },
    ],
    profile: { language: "en-GB" },
    request: {
      url,
      method: "POST",
      content_type: "application/json",
      body: ' {"hello": 1}\n',
    },
    document_cookie: "session=current",
    ...changes,
  };
}
function result(changes: Record<string, unknown> = {}): any {
  return {
    headers: Object.fromEntries(
      [..."abcdfz"].map((s) => [
        `X-Dynamic-${s}`,
        s === "d" ? "" : "secret-value",
      ]),
    ),
    request_id: "req-123",
    generation_ms: 12,
    profile_used: { language: "en-GB" },
    material_ref: "ref_0123456789abcdef",
    material_expires_at: new Date(Date.now() + 60000).toISOString(),
    ...changes,
  };
}
function reply(value: unknown = result(), status = 200, headers = {}) {
  return mock
    .get(origin)
    .intercept({ path: "/v1/shape", method: "POST" })
    .reply(status, value, { headers });
}
function errorKind(kind: string, statusCode?: number) {
  return (e: unknown) => {
    assert.ok(e instanceof sdk.RayonError);
    assert.equal(e.kind, kind);
    if (statusCode !== undefined) assert.equal(e.statusCode, statusCode);
    assert.ok(!inspect(e).includes(key));
    return true;
  };
}
beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(async () => {
  setGlobalDispatcher(previous);
  await mock.close();
});
test("persistent material client preserves exact body and fresh request state while reusing scoped reference", async () => {
  const first = shape();
  mock
    .get(origin)
    .intercept({
      path: "/v1/shape",
      method: "POST",
      body: JSON.stringify(first),
      headers: { authorization: `Bearer ${key}` },
    })
    .reply(200, result());
  const next = shape({
    profile: { language: "fr" },
    document_cookie: "fresh",
    request: {
      url,
      method: "PUT",
      content_type: "text/plain",
      body: " exact\n",
    },
  });
  const cached = { ...next, material_ref: "ref_0123456789abcdef" };
  delete cached.scripts;
  mock
    .get(origin)
    .intercept({
      path: "/v1/shape",
      method: "POST",
      body: JSON.stringify(cached),
    })
    .reply(200, result());
  mock
    .get(origin)
    .intercept({ path: "/v1/usage", method: "GET" })
    .reply(200, { daily_used: 2 });
  const client = new sdk.RayonClient(key, { dispatcher: mock });
  const value = await client.generate(first);
  await client.generate(next);
  assert.equal((await client.usage()).daily_used, 2);
  await client.close();
  assert.equal(value.headers["X-Dynamic-d"], "");
  assert.ok(!inspect(value).includes("secret-value"));
  assert.ok(!inspect(client).includes(key));
  mock.assertNoPendingInterceptors();
  await assert.rejects(client.generate(first), errorKind("validation"));
});
for (const change of [
  { scripts: [] },
  { scripts: [{ url, source: "x" }].flatMap((x) => Array(17).fill(x)) },
  { material_ref: "ref" },
  { profile: { unknown: true } },
  { profile: { screen: { width: "wide" } } },
  { profile: { navigator: { unknown: 1 } } },
  { profile: { window: { devicePixelRatio: NaN } } },
  { request: { url, method: "POST", content_type: null, body: {} } },
  {
    request: {
      url,
      method: "POST",
      content_type: null,
      body: "x".repeat(256 * 1024 + 1),
    },
  },
  { scripts: [{ url, source: "x".repeat(3 * 1024 * 1024 + 1) }] },
  { source_url: "https://u:p@example.com" },
])
  test("rejects invalid shape before transport", async () => {
    await assert.rejects(generate(shape(change), key), errorKind("validation"));
  });
for (const baseUrl of [
  "http://remote.example",
  "https://u:p@example.com",
  "https://example.com?key=1",
  "https://example.com#",
  "https:///example.com",
  "https://example.com:0",
])
  test("rejects unsafe base", async () => {
    await assert.rejects(
      generate(shape(), key, { baseUrl }),
      errorKind("validation"),
    );
  });
for (const status of [301, 307, 401, 410, 429, 503])
  test(`sanitizes error envelope HTTP ${status} without retries`, async () => {
    reply(
      {
        error: {
          code: status === 410 ? "api_retired" : "rate_limited",
          message: key + " private",
          request_id: "req-safe",
        },
      },
      status,
      { "retry-after": "12" },
    );
    await assert.rejects(generate(shape(), key), (e) => {
      errorKind(
        status === 401
          ? "auth"
          : status === 429
            ? "rate_limit"
            : status === 410
              ? "migration"
              : "http",
        status,
      )(e);
      assert.equal((e as sdk.RayonError).requestId, "req-safe");
      assert.equal((e as sdk.RayonError).retryAfter, "12");
      assert.ok(!(e as Error).message.includes("private"));
      return true;
    });
    mock.assertNoPendingInterceptors();
  });
for (const change of [
  { headers: { "X-a": "x" } },
  { generation_ms: -1 },
  { request_id: key },
  { profile_used: [] },
  { headers: Object.fromEntries([..."abcdfz"].map((s) => [`X-${s}`, "\n"])) },
])
  test("rejects invalid result", async () => {
    reply(result(change));
    await assert.rejects(generate(shape(), key), errorKind("invalid_response"));
  });
for (const [encoding, compress] of [
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
] as const) {
  test(`bounded ${encoding}`, async () => {
    reply(compress(Buffer.from(JSON.stringify(result()))), 200, {
      "content-encoding": encoding,
    });
    assert.equal((await generate(shape(), key)).generation_ms, 12);
    reply(compress(Buffer.from("x".repeat(256 * 1024 + 1))), 200, {
      "content-encoding": encoding,
    });
    await assert.rejects(generate(shape(), key), errorKind("invalid_response"));
  });
}
test("aborts whole request and caller abort signal", async () => {
  reply().delay(150);
  await assert.rejects(
    generate(shape(), key, { timeoutMs: 20 }),
    errorKind("timeout"),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generate(shape(), key, { signal: controller.signal }),
    errorKind("aborted"),
  );
});
test("expired references and different material are not reused", async () => {
  for (let i = 0; i < 3; i++)
    mock
      .get(origin)
      .intercept({
        path: "/v1/shape",
        method: "POST",
        body: (body: string) => Object.hasOwn(JSON.parse(body), "scripts"),
      })
      .reply(200, result({ material_expires_at: "2000-01-01T00:00:00Z" }));
  const client = new sdk.RayonClient(key, { dispatcher: mock });
  await client.generate(shape());
  await client.generate(shape());
  await client.generate(shape({ scripts: [{ url, source: "/* changed */" }] }));
  await client.close();
  mock.assertNoPendingInterceptors();
});
test("stream deadline includes slow response body and closes stream", async () => {
  setGlobalDispatcher(previous);
  let closed = false;
  const server = createServer((_req, res) => {
    res.on("close", () => (closed = true));
    res.writeHead(200);
    res.write("{");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  try {
    await assert.rejects(
      generate(shape(), key, {
        baseUrl: `http://127.0.0.1:${addr.port}`,
        timeoutMs: 100,
      }),
      errorKind("timeout", 200),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("retired solve not exported", () => {
  assert.equal("solve" in sdk, false);
});
test("client closes its owned connection pool", async () => {
  setGlobalDispatcher(previous);
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const client = new sdk.RayonClient(key, {
    baseUrl: `http://127.0.0.1:${addr.port}`,
  });
  try {
    await client.generate(shape());
    await client.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      await new Promise<number>((resolve, reject) =>
        server.getConnections((err, n) => (err ? reject(err) : resolve(n))),
      ),
      0,
    );
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
for (const change of [
  { scripts: [{ url, source: "x".repeat(2 * 1024 * 1024 + 1) }] },
  {
    scripts: [
      { url, source: "x".repeat(2 * 1024 * 1024) },
      { url, source: "x".repeat(1024 * 1024 + 1) },
    ],
  },
  { document_cookie: "x".repeat(16 * 1024 + 1) },
  { profile: { screen: { width: 0 } } },
  { profile: { languages: [] } },
  { profile: { window: { devicePixelRatio: 17 } } },
  { profile: { canvas: { data_url: "data:image/png;base64," } } },
  {
    request: {
      url,
      method: "GET",
      content_type: "application/json",
      body: "x",
    },
  },
  { request: { url, method: "POST", content_type: null, body: "x" } },
  {
    request: {
      url,
      method: "POST",
      content_type: "application/octet-stream",
      body: "x",
    },
  },
])
  test("enforces exact gateway limits", async () => {
    await assert.rejects(generate(shape(change), key), errorKind("validation"));
  });
for (const field of [
  "screenX",
  "screenY",
  "screenLeft",
  "screenTop",
  "pageXOffset",
  "pageYOffset",
])
  for (const value of [-2147483649, 2147483648])
    test("rejects signed int32 coordinate overflow", async () => {
      await assert.rejects(
        generate(shape({ profile: { window: { [field]: value } } }), key),
        errorKind("validation"),
      );
    });
for (const change of [
  { material_ref: null, material_expires_at: null },
  { material_ref: null },
  { material_expires_at: null },
])
  test("requires nonnull material metadata", async () => {
    reply(result(change));
    await assert.rejects(generate(shape(), key), errorKind("invalid_response"));
  });
for (const fields of [
  ["material_ref"],
  ["material_expires_at"],
  ["material_ref", "material_expires_at"],
])
  test("requires present material metadata", async () => {
    const value = result();
    for (const f of fields) delete value[f];
    reply(value);
    await assert.rejects(generate(shape(), key), errorKind("invalid_response"));
  });
for (const [prefix, value] of [
  ["p".repeat(129), "valid"],
  ["valid", "é"],
  ["valid", "a b"],
])
  test("requires bounded prefix and visible ASCII headers", async () => {
    reply(
      result({
        headers: Object.fromEntries(
          [..."abcdfz"].map((s) => [`${prefix}-${s}`, s === "d" ? "" : value]),
        ),
      }),
    );
    await assert.rejects(generate(shape(), key), errorKind("invalid_response"));
  });
test("effective profile limit includes alias expansion and defaults", async () => {
  await assert.rejects(
    generate(
      shape({
        profile: {
          user_agent: "u".repeat(8192),
          platform: "p".repeat(8192),
          language: "l".repeat(8192),
          languages: ["a".repeat(8192), "b".repeat(8192), "c".repeat(8192)],
        },
      }),
      key,
    ),
    errorKind("validation"),
  );
});
test("accepts UTF8 profile with unicode vendor and appName", async () => {
  reply();
  await generate(
    shape({
      profile: {
        navigator: { vendor: "é".repeat(8192), appName: "é".repeat(8192) },
      },
    }),
    key,
  );
});
test("shared canonical profile fixtures match public request validation", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/profile-contract.json", import.meta.url),
      "utf8",
    ),
  );
  function expand(value: any): any {
    if (value && typeof value === "object" && value.$repeat)
      return value.$repeat.text.repeat(value.$repeat.count);
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, expand(v)]),
      );
    return value;
  }
  for (const c of fixture.cases) {
    if (c.valid) {
      reply();
      await generate(shape({ profile: expand(c.profile) }), key);
    } else
      await assert.rejects(
        generate(shape({ profile: expand(c.profile) }), key),
        errorKind("validation"),
      );
  }
});
for (const prefix of ["ee30zvqlwf", "p".repeat(128), "!#$%&'*+-.^_`|~"])
  test("preserves actual HTTP token prefix at maximum length", async () => {
    const headers = Object.fromEntries(
      [..."abcdfz"].map((s) => [
        `${prefix}-${s}`,
        s === "d" ? "" : "visible-value",
      ]),
    );
    reply(result({ headers }));
    assert.deepEqual({ ...(await generate(shape(), key)).headers }, headers);
  });
test("bounded browser profile text and languages count Unicode code points", async () => {
  for (const profile of [
    { navigator: { vendor: "😀".repeat(5000) } },
    { language: "😀".repeat(5000) },
    { languages: ["😀".repeat(5000)] },
    { webgl: { renderer: "😀".repeat(5000) } },
  ]) {
    reply();
    await generate(shape({ profile }), key);
  }
});
test("URL bound counts code points while preserving original context", async () => {
  reply();
  await generate(
    shape({ source_url: "https://example.com/" + "😀".repeat(5000) }),
    key,
  );
});
test("public profile preflight preserves supplied fields and deep copies", () => {
  const profile = {
    navigator: { vendor: "😀".repeat(5000) },
    window: { screenX: -2147483648 },
  };
  const checked = sdk.validate_profile(profile);
  assert.equal(checked.navigator?.vendor, profile.navigator.vendor);
  checked.navigator!.vendor = "changed";
  assert.equal(profile.navigator.vendor, "😀".repeat(5000));
  assert.equal("user_agent" in checked, false);
  assert.throws(
    () => sdk.validate_profile({ window: { screenX: 2147483648 } }),
    errorKind("validation"),
  );
});
for (const mode of ["client", "helper"])
  for (const override of [undefined, 75000])
    test("default deadline is 45 seconds and explicit overrides survive", async () => {
      const seen: { headersTimeout?: number; bodyTimeout?: number }[] = [];
      const dispatch = mock.dispatch.bind(mock);
      mock.dispatch = ((options: any, handler: any) => {
        seen.push({
          headersTimeout: options.headersTimeout,
          bodyTimeout: options.bodyTimeout,
        });
        return dispatch(options, handler);
      }) as typeof mock.dispatch;
      reply();
      const options = {
        dispatcher: mock,
        ...(override === undefined ? {} : { timeoutMs: override }),
      };
      if (mode === "helper") await sdk.generate(shape(), key, options);
      else {
        mock
          .get(origin)
          .intercept({ path: "/v1/usage", method: "GET" })
          .reply(200, { daily_used: 1 });
        const client = new sdk.RayonClient(key, options);
        try {
          await client.generate(shape());
          await client.usage();
        } finally {
          await client.close();
        }
      }
      assert.ok(seen.length > 0);
      assert.ok(
        seen.every(
          (option) =>
            option.headersTimeout === (override ?? 45000) &&
            option.bodyTimeout === (override ?? 45000),
        ),
      );
    });
