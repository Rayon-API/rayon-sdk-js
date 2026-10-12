# Rayon JavaScript SDK

Material-only server-side JavaScript and TypeScript clients for `POST /v1/shape` and `GET /v1/usage`. Requires Node.js 20.18.1+. ESM, CommonJS, and declarations are included. Keep API keys on your server.

```sh
npm install rayon-sdk-js@^1
```

Prepare JavaScript material from files you own or are authorized to use. URLs provide execution context; neither SDK nor API downloads them. Preserve script order.

```js
import { readFile } from 'node:fs/promises';
import { RayonClient } from 'rayon-sdk-js';

const client = new RayonClient(process.env.RAYON_API_KEY);
try {
  const result = await client.generate({
    source_url: 'https://example.com/page',
    scripts: [{
      url: 'https://example.com/assets/owned.js',
      source: await readFile('owned.js', 'utf8'),
    }],
    profile: { user_agent: 'your actual user agent', language: 'en-GB' },
    request: {
      url: 'https://example.com/api/items',
      method: 'POST',
      content_type: 'application/json',
      body: ' {"item": 1}\n', // Exact target body, including whitespace.
    },
    document_cookie: 'session=current', // Current JavaScript-visible cookies.
  });
  const usage = await client.usage();
  // Explicitly access result.headers and result.profile_used for your target client.
} finally {
  await client.close();
}
```

CommonJS: `const { RayonClient, generate, RayonError } = require('rayon-sdk-js')`.

`new RayonClient(apiKey, { baseUrl?, timeoutMs? })` owns a persistent ordinary-TLS connection pool. Its defaults are `https://api.rayonapi.com` and a 150,000 ms total deadline. Close it explicitly. `client.generate(shape, { signal? })` and `client.usage({ signal? })` support `AbortSignal`. `generate(shape, apiKey, { baseUrl?, timeoutMs?, signal? })` is a one-shot helper that closes its pool. An optional `dispatcher` can be injected; an injected dispatcher remains owned by the caller.

Supply exactly one of `scripts` and `material_ref`. `source_url`, `profile`, and all four `request` fields are always required. `body: null` means no target body; `''` means an explicit empty body. GET and HEAD require null; a supplied body requires a supported text content type. The body string is never parsed, reformatted, or converted to an object. `ShapeRequest`, `BrowserProfile`, `TargetRequest`, `ScriptMaterial`, and `ShapeResult` are exported types.

Persistent clients cache only material references, keyed by source URL and ordered script URLs and source. Each cache is scoped to one client, API key, and server and honors the server's `material_expires_at` expiry. Repeating the same material uses its unexpired reference. Profile, request, and document cookies are freshly copied per call. Expired references trigger a new upload on the next call supplying scripts; a failed reference request is never automatically retried. Explicit references also require their original source URL.

`BrowserProfile` strictly supports `user_agent`, `platform`, `language`, `languages`, and nested `screen`, `window`, `webgl`, `canvas`, `navigator`. Conflicting aliases are rejected. `{}` selects server defaults. Screen/window dimensions, WebGL renderer/vendor, navigator identity, and a PNG `canvas.data_url` are supported. Effective `profile_used` omits canvas pixels.

A result contains `headers`, `request_id`, `generation_ms`, `profile_used`, and optional `material_ref`/`material_expires_at`. Returned headers preserve the actual dynamic common prefix and complete `a`, `b`, `c`, `d`, `f`, `z` suffixes; `d` may be empty. Generation does not assert target acceptance. No cookies, status, or internal method are returned. Node inspection redacts headers, profile data, and references; explicit field access and JSON serialization retain result values.

Limits are 4 MiB of serialized request JSON, 16 scripts, 2 MiB per script and 3 MiB of total UTF-8 source, 256 KiB of UTF-8 body, 64 KiB of profile JSON, and 16 KiB of document cookies. Wire and decoded API responses are each bounded to 256 KiB, including gzip/deflate/Brotli decoding. The deadline includes response streaming. Certificate verification stays enabled; no redirects are followed and environment proxies are not used. Custom bases require HTTPS except local HTTP on `localhost`, `127.0.0.1`, or `[::1]`; credentials, fragments, and base queries are refused. API transport does not impersonate a browser.

`RayonError` exposes `kind`, sanitized `statusCode`, `requestId`, `code`, and `retryAfter`. Raw server messages and transport causes are discarded. Kinds are `validation`, `auth`, `rate_limit`, `migration`, `http`, `invalid_response`, `network`, `timeout`, and `aborted`. HTTP 410 yields `migration`; 429 yields `rate_limit` with a validated Retry-After seconds or HTTP-date string. No request is retried automatically: admitted generations can consume quota.

## Migration from 0.1

Version 1.0 removes URL-only `solve`, `SolveOptions`, and `SolveResult`. Replace them with `generate`/`RayonClient`, caller-prepared material, a fresh browser profile, and exact target request context. Use `generation_ms`, `headers`, and `profile_used` in place of duration/status/method/cookie handling. Published 0.1 packages and tags remain unchanged and target the retired API.

```sh
npm ci
npm test
npm run build
npm run test:package
```

See [RELEASE.md](RELEASE.md) for release checks. Licensed under [MIT](LICENSE).
