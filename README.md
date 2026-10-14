# Rayon JavaScript SDK

Server-side JavaScript and TypeScript clients for RayonAPI Shape header generation and account usage.
Requires Node.js 20.18.1+. Includes ESM, CommonJS and TypeScript declarations.
Keep your API key on your server.

[Documentation](https://docs.rayonapi.com/) · [Examples](https://github.com/Rayon-API/rayon-examples) · [Releases](https://github.com/Rayon-API/rayon-sdk-js/releases)

## Install

```sh
npm install rayon-sdk-js@^1
```

## Generate headers

Prepare `shape.json` with the required raw protection JavaScript in execution order, including
loaders and payloads where used. Include their context URLs, a current browser profile,
JavaScript-visible cookies (`document_cookie`) and the exact target URL, method, content type
and body string. See
[material preparation](https://docs.rayonapi.com/material) and
[profiles and sessions](https://docs.rayonapi.com/profiles-and-sessions).
The SDK and API use URLs as context; they do not download scripts or send the target request.

```ts
import { readFile } from 'node:fs/promises';
import { RayonClient, type ShapeRequest } from 'rayon-sdk-js';

const shape: ShapeRequest = JSON.parse(await readFile('shape.json', 'utf8'));
const client = new RayonClient(process.env.RAYON_API_KEY!, { timeoutMs: 45_000 });
try {
  const result = await client.generate(shape);
  const targetHeaders = { ...result.headers };
  console.log(result.request_id);
  // Apply targetHeaders using your target client and existing session.
} finally {
  await client.close();
}
```

Apply all six `targetHeaders` to that exact request using your own target client and session.
Keep its browser identity consistent with `result.profile_used` and retain the session's cookies.
The response also includes `generation_ms`, `material_ref` and `material_expires_at`;
it does not return target cookies or verify target acceptance.

Supply exactly one of `scripts` or a server-issued `material_ref` with its original `source_url`.
All four `request` fields are required; GET/HEAD use `content_type: null`, `body: null`.
Preserve body whitespace and encoding. Persistent clients reuse unexpired material references,
while each call generates fresh headers from the supplied profile, request and cookies.
If a cached reference fails, use a fresh client with the saved scripts.

## Clients and errors

The SDK authenticates with `Authorization: Bearer <API key>` and defaults to
`https://api.rayonapi.com` with a 45,000 ms API request timeout.
`client.generate(shape, { signal })` supports cancellation with `AbortSignal`.
`client.usage()` reads account usage; `generate(shape, apiKey)` is a one-shot helper.
CommonJS: `const { RayonClient } = require('rayon-sdk-js')`.

`RayonError` exposes `kind`, sanitized `statusCode`, `requestId`, `code` and `retryAfter`.
Kinds distinguish invalid input, authentication, rate limits, HTTP errors, invalid responses,
network failures, timeouts and cancellation. No automatic retries. A client timeout may occur
after successful generation; check history before retrying.
See the [API reference](https://docs.rayonapi.com/api-reference) and [errors](https://docs.rayonapi.com/errors).

[Support](mailto:support@rayonapi.com) · [Discord](https://discord.gg/TwhkJNyHWs) · [MIT license](LICENSE)
