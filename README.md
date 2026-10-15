# Rayon JavaScript SDK

Server-side JavaScript and TypeScript clients for RayonAPI Shape header and form generation and account usage.
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
import { RayonClient, type HeaderShapeRequest } from 'rayon-sdk-js';

const shape: HeaderShapeRequest = JSON.parse(await readFile('shape.json', 'utf8'));
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

Apply every returned `targetHeaders` to that exact request using your own target client and session.
Header mode returns the six required same-family `a`, `b`, `c`, `d`, `f`, `z` headers
and may include a fresh same-family `a0` header. Preserve all returned names, case and values.
Keep its browser identity consistent with `result.profile_used` and retain the session's cookies.
The response also includes `generation_ms`, `material_ref` and `material_expires_at`;
it does not return target cookies or verify target acceptance.

Supply exactly one of `scripts` or a server-issued `material_ref` with its original `source_url`.
All four `request` fields are required; GET/HEAD use `content_type: null`, `body: null`.
Preserve body whitespace and encoding. Persistent clients reuse unexpired material references,
while each call generates fresh headers from the supplied profile, request and cookies.
If a cached reference fails, use a fresh client with the saved scripts.

## Generate form telemetry

Requires SDK 1.1+. Set `mode: "form"` and provide a POST with
`application/x-www-form-urlencoded`. `request.body` is the application form **before**
telemetry insertion, including duplicate fields and current CSRF/session values.
Optional `form: { id: "checkout", name: "checkout" }` describes the form selector.

```ts
import { RayonClient, type FormShapeRequest } from 'rayon-sdk-js';

// preparedMaterial contains source_url, scripts (or material_ref), profile and cookies.
const applicationBody = 'item=first&item=second&csrf=current%2Bvalue';
const formShape: FormShapeRequest = {
  ...preparedMaterial,
  mode: 'form',
  form: { id: 'checkout' },
  request: {
    url: 'https://example.com/submit',
    method: 'POST',
    content_type: 'application/x-www-form-urlencoded',
    body: applicationBody,
  },
};
const client = new RayonClient(process.env.RAYON_API_KEY!);
try {
  const result = await client.generate(formShape); // FormShapeResult; no headers
  const targetBody = result.form_body + (applicationBody ? '&' + applicationBody : '');
  // Submit targetBody using your existing target client and session.
} finally {
  await client.close();
}
```

`form_fields` contains exactly six raw values under the exact observed names and case;
a larger `a` value remains one field and does not add `a0`.
`form_body` contains only those telemetry fields, already encoded once in observed
insertion order. Prepend it once to the original application body; do not encode it
again, convert application fields to a dictionary, or send stale telemetry in the input.
Retain the same cookies and browser identity for the target request. The SDK calls
public `POST /v1/shape`.

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
