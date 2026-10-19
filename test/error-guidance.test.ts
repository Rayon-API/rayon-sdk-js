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
  for (const [reason, entry] of Object.entries(source) as [string, {codes: string[]; message: string; action: string}][]) {
    for (const code of entry.codes) {
      const error = failure({code, reason, domain: "example.com"});
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
