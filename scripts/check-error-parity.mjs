/** Contributor check: node scripts/check-error-parity.mjs /path/to/rayon-sdk-py [python] */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorCatalog } from "../dist/esm/error-catalog.js";
import { responseMetadata } from "../dist/esm/response.js";
import { RayonError } from "../dist/esm/errors.js";
const pyRoot = resolve(process.argv[2] ?? "../rayon-sdk-py");
const python = process.argv[3] ?? resolve(pyRoot, ".venv/bin/python");
assert.deepEqual(errorCatalog, JSON.parse(readFileSync(resolve(pyRoot, "src/rayon_sdk_py/error_catalog.json"), "utf8")));
const vectors = [];
for (const reason of Object.keys(errorCatalog)) {
  for (const code of Object.keys(errorCatalog)) vectors.push({code, reason, domain: "example.com"});
}
for (const domain of [undefined, "Example.com", "https://secret.invalid?cookie=x", "test-secret-key.com", "x..com", "example.com\n", "127.0.0.1", "a".repeat(254)])
  for (const field of [undefined, "profile.navigator.userAgent", "request.cookie=session", "constructor.secret", "test-secret-key", "profile\n"])
    for (const billing_status of [undefined, "not_charged", "pending", "unknown", "charged", true])
      vectors.push({code: "access_denied", reason: "domain_pending", domain, field, billing_status});
for (const [reason, entry] of Object.entries(errorCatalog)) {
  for (const billing_status of [undefined, "not_charged", "pending", "unknown", "charged", true, {}, []])
    for (const retryable of [undefined, false, true])
      vectors.push({code: entry.codes[0], reason, billing_status, retryable});
}
function comparable(result) {
  return {reason: result.reason ?? null, action: result.action ?? null, domain: result.domain ?? null,
    field: result.field ?? null, billing_status: result.billingStatus ?? null,
    message: result.reason ? result.message : null, retryable: result.retryable ?? null, retry_after: result.retryAfter ?? null};
}
const actual = vectors.map(error => ({
  metadata: comparable(new RayonError("http", responseMetadata(403, {"retry-after": "7"}, "test-secret-key", {error}))),
  direct: comparable(new RayonError("http", {...error, billingStatus: error.billing_status})),
}));
const program = `import json,sys
from types import SimpleNamespace
from rayon_sdk_py.errors import HTTPError
from rayon_sdk_py.validation import response_metadata
def comparable(e):
 return dict(reason=e.reason, action=e.action, domain=e.domain, field=e.field, billing_status=e.billing_status, message=str(e) if e.reason else None,retryable=e.retryable,retry_after=e.retry_after)
results=[]
for error in json.load(sys.stdin):
 metadata=HTTPError('generic', **response_metadata(SimpleNamespace(status_code=403,headers={'Retry-After':'7'}),'test-secret-key',{'error':error}))
 direct=HTTPError('generic', **error)
 results.append(dict(metadata=comparable(metadata),direct=comparable(direct)))
json.dump(results,sys.stdout)`;
const expected = JSON.parse(execFileSync(python, ["-c", program], {
  maxBuffer: 8 * 1024 * 1024, input: JSON.stringify(vectors), encoding: "utf8", env: {...process.env, PYTHONPATH: resolve(pyRoot, "src")},
}));
assert.deepEqual(actual, expected);
console.log(`Verified JS/Python error catalog and ${vectors.length} guidance vectors match.`);
