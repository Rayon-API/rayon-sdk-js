import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { responseMetadata } from "../src/response.js";
import { RayonError } from "../src/errors.js";

const key = "test-secret-key";
function failure(extra: Record<string, unknown> = {}) {
  return new RayonError("auth", responseMetadata(403, {"retry-after": "7"}, key, {
    error: {code: "access_denied", reason: "account_disabled", request_id: "req-123", retryable: false,
      message: `unsafe ${key} session=cookie`, action: `unsafe ${key}`, ...extra},
  }));
}

test("known reasons expose trusted guidance while preserving existing metadata", () => {
  const error = failure({domain: "example.com", field: "profile.navigator.userAgent", billing_status: "not_charged"});
  assert.equal(error.reason, "account_disabled");
  assert.match(error.message, /disabled/i);
  assert.ok(error.action);
  assert.equal(error.domain, "example.com");
  assert.equal(error.field, "profile.navigator.userAgent");
  assert.equal(error.billingStatus, "not_charged");
  assert.equal(error.code, "access_denied");
  assert.equal(error.kind, "auth");
  assert.equal(error.statusCode, 403);
  assert.equal(error.requestId, "req-123");
  assert.equal(error.retryAfter, "7");
  assert.equal(error.retryable, false);
  assert.ok(!inspect(error).includes("unsafe"));
  assert.ok(!inspect(error).includes(key));
  assert.ok(!inspect(error).includes("session=cookie"));
});

test("legacy and unrecognized code/reason pairs keep generic text", () => {
  for (const extra of [{reason: undefined}, {reason: "new_server_reason"}, {code: "invalid_input"}, {code: "constructor"}]) {
    const error = failure(extra);
    assert.equal(error.message, "Rayon API denied authentication or access.");
    assert.equal(error.reason, undefined);
    assert.equal(error.action, undefined);
    assert.equal(error.billingStatus, undefined);
  }
});

test("optional guidance metadata rejects URLs, unsafe paths, credentials and invalid enums", () => {
  for (const domain of ["https://example.com/private?token=x", "Example.com", "example.com:443", "x..com", "-bad.com", "example.com\n", `${key}.com`, "a".repeat(254), "127.0.0.1", null, 7])
    assert.equal(failure({domain}).domain, undefined);
  for (const field of ["profile[secret]", "__proto__.x", "constructor.x", "profile.prototype", `profile.${key}`, "a".repeat(97), "profile\n", "request.cookie=session", null, 7])
    assert.equal(failure({field}).field, undefined);
  for (const billing_status of ["charged", true, null, 1, "NOT_CHARGED"])
    assert.equal(failure({billing_status}).billingStatus, undefined);
  for (const billing_status of ["not_charged", "pending", "unknown"])
    assert.equal(failure({billing_status}).billingStatus, billing_status);
});

test("generated catalog matches shared source and every known code/reason renders safely", async () => {
  const { readFileSync } = await import("node:fs");
  const { errorCatalog } = await import("../src/error-catalog.js");
  const source = JSON.parse(readFileSync(new URL("./fixtures/error-catalog.json", import.meta.url), "utf8"));
  assert.deepEqual(errorCatalog, source);
  for (const [reason, entry] of Object.entries(source) as [string, {codes: string[]; message: string; action: string; retryable: boolean}][]) {
    for (const code of entry.codes) {
      const error = failure({code, reason, domain: "example.com", retryable: entry.retryable, billing_status: "not_charged"});
      assert.equal(error.message, entry.message.replace("{domain}", "example.com"));
      assert.equal(error.action, entry.action);
      assert.equal(error.reason, reason);
      const fallback = failure({code, reason, domain: "https://secret.invalid/path?cookie=x"});
      assert.equal(fallback.message, entry.message.replace("{domain}", "this domain"));
      assert.equal(fallback.domain, undefined);
    }
  }
});

test("public client preserves guidance without retrying a definite failure", async () => {
  const { MockAgent } = await import("undici");
  const { RayonClient } = await import("../src/index.js");
  const mock = new MockAgent(); mock.disableNetConnect();
  let calls = 0;
  mock.get("https://api.rayonapi.com").intercept({path: "/v1/usage", method: "GET"}).reply(() => {
    calls++;
    return {statusCode: 403, data: {error: {code: "access_denied", reason: "domain_pending", domain: "example.com", retryable: false, billing_status: "not_charged", message: key, action: key}}, responseOptions: {headers: {"x-request-id": "req-guidance", "retry-after": "7"}}};
  }).persist();
  const client = new RayonClient(key, {dispatcher: mock});
  try {
    await assert.rejects(client.usage(), (error: unknown) => {
      assert.ok(error instanceof RayonError);
      assert.equal(error.kind, "auth");
      assert.equal(error.reason, "domain_pending");
      assert.equal(error.message, "Access to example.com is awaiting review.");
      assert.equal(error.billingStatus, "not_charged");
      assert.equal(error.requestId, "req-guidance");
      assert.equal(error.retryAfter, "7");
      return true;
    });
    assert.equal(calls, 1);
  } finally { await client.close(); await mock.close(); }
});

test("constructors render domain placeholders safely and ignore caller supplied action text", () => {
  const error = new RayonError("http", {code: "access_denied", reason: "domain_pending", domain: "https://bad.invalid/path", field: "profile[private]", action: "untrusted action"});
  assert.equal(error.message, "Access to this domain is awaiting review.");
  assert.equal(error.domain, undefined);
  assert.equal(error.field, undefined);
  assert.notEqual(error.action, "untrusted action");
});

const historyAction = "Check request history before sending another request. Contact support with the request ID if it remains unclear.";
test("retry guidance respects billing uncertainty and an explicit retry prohibition", () => {
  for (const billingStatus of [undefined, "pending", "unknown", "not_charged"] as const) {
    for (const retryable of [undefined, false, true]) {
      const options = {code: "generation_unavailable", reason: "generation_unavailable", billingStatus, retryable};
      const direct = new RayonError("http", options);
      const metadata = responseMetadata(503, {}, key, {error: {...options, billing_status: billingStatus}});
      const expected = billingStatus !== "not_charged" || retryable === false ? historyAction : "Retry with backoff. Contact support with the request ID if this continues.";
      assert.equal(direct.action, expected);
      assert.equal(metadata.action, expected);
      assert.equal(new RayonError("http", metadata).action, expected);
    }
  }
});

test("direct constructors reject invalid billing status at runtime", () => {
  for (const billingStatus of [true, 1, null, "charged", "private-token", {}, []]) {
    const error = new RayonError("http", {code: "generation_unavailable", reason: "generation_unavailable", billingStatus} as any);
    assert.equal(error.billingStatus, undefined);
    assert.equal(error.action, historyAction);
  }
});

for (const billing_status of [undefined, "pending", "unknown", "not_charged"]) {
  test(`HTTP uncertainty guidance for billing ${billing_status} never replays the request`, async () => {
    const { createServer } = await import("node:http");
    const { RayonClient } = await import("../src/index.js");
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      response.writeHead(503, {"content-type": "application/json", "retry-after": "7"});
      response.end(JSON.stringify({error: {code: "generation_unavailable", reason: "generation_unavailable", billing_status, retryable: true, action: "untrusted retry instruction"}}));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const client = new RayonClient(key, {baseUrl: `http://127.0.0.1:${address.port}`});
    try {
      await assert.rejects(client.usage(), (error: unknown) => {
        assert.ok(error instanceof RayonError);
        assert.equal(error.action, billing_status === "not_charged" ? "Retry with backoff. Contact support with the request ID if this continues." : historyAction);
        assert.equal(error.billingStatus, billing_status);
        assert.equal(error.retryAfter, "7");
        return true;
      });
      assert.equal(calls, 1);
    } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
