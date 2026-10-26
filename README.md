# Rayon JavaScript / TypeScript SDK

Generate Shape headers or form telemetry and read account usage. Keep your API
key server-side. Your integration owns its HTTP client or browser and target session.

[Quickstart](https://docs.rayonapi.com/quickstart) ·
[SDK guide](https://github.com/Rayon-API/docs/blob/main/guide/javascript.md) ·
[All SDKs](https://docs.rayonapi.com/sdks)

## Install

```sh
npm install rayon-sdk-js@^2.0.0
```

## Check usage, then generate

Set `RAYON_API_KEY`. Prepare `shape.json` using the
[input guide](https://docs.rayonapi.com/material): source-page URL, complete ordered
script sources, a profile object and the exact target request. Include browser
measurements or JavaScript-visible cookies only when your flow requires them.

```javascript
import { readFile } from 'node:fs/promises';
import { RayonClient } from 'rayon-sdk-js';

const apiKey = process.env.RAYON_API_KEY;
if (!apiKey) throw new Error('Set RAYON_API_KEY');
const client = new RayonClient(apiKey);
try {
  const usage = await client.usage(); // Free; no generation quota used.
  console.log(usage);
  const shape = JSON.parse(await readFile('shape.json', 'utf8'));
  const result = await client.generate(shape);
  // Apply result.headers using your existing target client/session.
  // Reuse client here for further requests with their current inputs.
  console.log(result.request_id);
} finally {
  await client.close();
}
```

Apply the entire returned header map unchanged, including optional `a0`, to that
exact request. Keep required application headers, authentication and session state
in your target client. RayonAPI does not download scripts, send the target request
or return target cookies. Inspect the target response to establish acceptance.

## Form telemetry

For observed URL-encoded form telemetry, use `mode: "form"` and supply the exact
application body before telemetry insertion. The result has `form_fields` and
`form_body`, without generated headers. Prepend `form_body` once to the original
body, preserving its bytes, duplicate fields and encoding. See
[Form payload integration](https://docs.rayonapi.com/form-payload-integration)
for complete examples.

## Client options and errors

Requires Node.js 20.18.1+. Includes ESM, CommonJS and TypeScript declarations.
CommonJS: `const { RayonClient } = require('rayon-sdk-js')`.
Set `{ timeoutMs: 45_000 }` in the constructor to set the API timeout.
Pass `{ signal }` to `generate` for cancellation with an `AbortSignal`.
`RayonError` exposes `kind`, `statusCode`, `requestId`, `code`, `retryAfter`,
`reason`, `action`, `domain`, `field`, `billingStatus` and `retryable` when available.

The default API URL is `https://api.rayonapi.com`; default timeout is 45 seconds.
Keep one client open across calls. Python and JavaScript SDK 2.0.0 reuse material
in both modes while generating fresh telemetry for each request. Read the
[material and recovery policy](https://docs.rayonapi.com/material#reuse-material-not-headers)
for cache scope, limits and the single confirmed uncharged material recovery.

Check request history before resubmitting after a timeout or uncertain billing
outcome. See [errors and retry guidance](https://docs.rayonapi.com/errors),
[request fields](https://docs.rayonapi.com/api-reference) and
[browser/session inputs](https://docs.rayonapi.com/profiles-and-sessions).
The [Python download helper](https://github.com/Rayon-API/rayon-examples) is optional.

[Support](mailto:support@rayonapi.com) ·
[Releases](https://github.com/Rayon-API/rayon-sdk-js/releases) · [MIT license](LICENSE)

## Explicit material preparation (2.0.0)

The additive preparation API is available. Preparation is an explicit step before
generation; legacy generation remains available and mandatory preparation is not
enabled. A 30-day migration window and cutoff will be announced separately.
No cutoff date is set. Prepare the current full context before your workload:

```ts
const queued = await client.prepare(shape);
const status = await client.getPreparation(queued.preparation_id); // wait defaults to 0
const ready = await client.waitUntilReady(queued.preparation_id, {
  waitTimeoutMs: 60_000,
  signal: abortController.signal,
});
// Or: const ready = await client.prepareAndWait(shape, { waitTimeoutMs: 60_000 });
const { scripts, material_ref, ...context } = shape;
const generated = await client.generate({ ...context, material_ref: ready.material_ref });
```

Pass the complete current shape context, including profile, target request, cookies,
mode and form metadata. Preparation returns safe readiness metadata, never scripts,
cookies or generated headers. `ready_until` is a bounded readiness window for that
exact context; changing the context can require preparation again. Preparation does
not change the source-only generation cache, and no readiness cache is retained.
`generate` remains a separate call and never starts preparation or waits for learning.

`getPreparation(id, { wait: 0 })` supports `wait` from 0 to 10 seconds. The wait
helper long polls for up to 10 seconds within its remaining monotonic wait budget,
retrying transient GET failures with jitter. Each preparation POST receives a new
stable idempotency key and is sent once. Wait cancellation stops only the local wait;
the server job continues. `RayonError.preparationId` allows resuming a failed,
timed out or aborted wait. Terminal states use `preparation_failed` and
`preparation_expired`; the API's sanitized error code is available separately.
