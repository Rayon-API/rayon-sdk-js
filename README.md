# Rayon JavaScript / TypeScript SDK

Generate Shape headers or form telemetry and read account usage. Keep your API
key server-side. Your integration owns its HTTP client or browser and target session.

[Quickstart](https://docs.rayonapi.com/quickstart) ·
[SDK guide](https://github.com/Rayon-API/docs/blob/main/guide/javascript.md) ·
[All SDKs](https://docs.rayonapi.com/sdks)

## Install

```sh
npm install rayon-sdk-js@^1.1.4
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
Keep one client open across calls. Python and JavaScript SDK 1.1.4 reuse material
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
