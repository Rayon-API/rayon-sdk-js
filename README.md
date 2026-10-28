# Rayon JavaScript / TypeScript SDK

Rayon manages current material for supported public sources. Send the source-page
URL, profile and exact request. No script collection or preparation is needed for
this header flow. Replace the reserved example URLs with your approved source and
endpoint. `{}` uses default profile values; supply measured values when needed.

Keep the API key server-side. Your integration owns the target HTTP client,
authentication, cookies and session. Rayon generates telemetry; your client sends
the target request.

[Quickstart](https://docs.rayonapi.com/quickstart) ·
[Material options](https://docs.rayonapi.com/material) ·
[API reference](https://docs.rayonapi.com/api-reference)

## Install

Requires Node.js 20.18.1+. ESM, CommonJS and TypeScript are included.

```sh
npm install rayon-sdk-js@^2.1.0
```

## Generate

```javascript
import { RayonClient } from 'rayon-sdk-js';

const apiKey = process.env.RAYON_API_KEY;
if (!apiKey) throw new Error('Set RAYON_API_KEY');
const client = new RayonClient(apiKey);
try {
  const result = await client.generate({
    source_url: 'https://shop.example.com/account',
    profile: {},
    request: {
      url: 'https://shop.example.com/api/check', method: 'POST',
      content_type: 'application/json', body: '{}',
    },
  });
  if (result.fallback_reason) {
    console.warn('A fallback was used. Contact support with request ID:', result.request_id);
  }
  // Apply result.headers with your target client. Keep client open for further calls.
} finally {
  await client.close();
}
```

Apply every returned header unchanged, including optional `a0`, to the exact
request. Keep application headers and session state in your target client.
Generate fresh telemetry for each request and inspect the target response to
check acceptance. Rayon returns no target cookies.

## Fallback reporting

When `fallback_reason` is present and non-null, a fallback was used. Contact
support with `request_id` about the mapping issue. `fallback_message` provides
safe guidance when available. Do not infer fallback from timing alone.

Results also expose optional `path`, `material_reuse`, `discovery_state` and
`discovery_duration_ms`. Older responses can omit these fields.

## Optional material and preparation

For an explicit override, supply either `scripts` (complete ordered sources) or
`material_ref` (a private reference), never both. Omit the unused field; null and
empty values are invalid. Customer uploads and references remain private to the
API key. Automatic requests should keep both fields omitted on every call so
new public material can be selected.

Form mode still requires explicit material. Set `mode: "form"`, supply the exact
URL-encoded POST application body before telemetry insertion, and prepend the
returned `form_body` once. It contains telemetry only. Preserve duplicate fields
and encoding. See [form integration](https://docs.rayonapi.com/form-payload-integration).

Preparation is optional for explicit material. It checks the supplied context
before a workload; it is separate from managed selection and generation.
Usable validated mappings can be ready without every internal record being mapped.
Generated headers and form fields must still pass output validation.

```javascript
// explicitShape includes scripts or material_ref and the current full context.
const ready = await client.prepareAndWait(explicitShape, { waitTimeoutMs: 60_000 });
const { scripts, material_ref, ...context } = explicitShape;
const result = await client.generate({ ...context, material_ref: ready.material_ref });
```

`prepare`, `getPreparation(id, { wait: 0 })`, `waitUntilReady` and
`prepareAndWait` remain available. Waits default to 60 seconds; status long polls
accept 0–10 seconds. Timeout or abort leaves the server job running. Resume with
`RayonError.preparationId`. Terminal kinds are `preparation_failed` and
`preparation_expired`. Readiness expires separately from the source reference;
prepare current explicit context again when readiness expires or inputs change.

## Client options and errors

Reuse one client for connections. `usage()` is a free access/allowance check.
Default API URL: `https://api.rayonapi.com`; timeout: 45 seconds. Constructor
options include `baseUrl`, `timeoutMs` and a caller-owned `dispatcher`.
Pass `{ signal }` to cancel a call. CommonJS: `const { RayonClient } = require('rayon-sdk-js')`.
Use `validate_profile` for offline profile validation.

`RayonError` exposes `kind`, `statusCode`, `requestId`, `code`, `retryAfter`,
`reason`, `action`, `domain`, `field`, `billingStatus` and `retryable` when available.
Check request history before retrying a timeout or uncertain billing outcome.
Only a definite uncharged `material_expired` receives one recovery attempt, and
only while original explicit sources remain retained in that client. No other
generation error is automatically retried.

Explicit-source caching retains up to 128 bundles / 16 MiB per client, coalesces
uploads and refreshes near expiry. References last up to five minutes and may
expire earlier. Automatic generation never pins a returned reference. The SDK
does not fetch target scripts, send target requests or cache generated telemetry.

[Errors](https://docs.rayonapi.com/errors) · [Release instructions](RELEASE.md) ·
[Support](mailto:support@rayonapi.com) · [MIT license](LICENSE)
