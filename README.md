# Rayon API JavaScript SDK

A small server-side JavaScript and TypeScript client for Rayon API. Requires Node.js **20.18.1 or newer** and uses Undici. ESM, CommonJS, and TypeScript declarations are included. Keep API keys on your server.

Version **0.1.0** is prepared for publication. Registry availability is not assumed; see [RELEASE.md](RELEASE.md) for the first-publication steps.

Install after npm publication:

```sh
npm install rayon-sdk-js
```

```js
import { solve, RayonError } from 'rayon-sdk-js';

const apiKey = process.env.RAYON_API_KEY;
if (!apiKey) throw new Error('Set RAYON_API_KEY on your server');

try {
  const result = await solve('https://example.com/product', apiKey);
  console.log(result.status, result.method, result.duration_ms);
  // result.headers and result.cookies contain the captured session data.
} catch (error) {
  if (!(error instanceof RayonError)) throw error;
  console.error(error.kind, error.statusCode, error.requestId);
}
```

CommonJS uses the same exports:

```js
const { solve, RayonError } = require('rayon-sdk-js');
```

`solve(targetUrl, apiKey, options?)` posts to `/solve` with Bearer authentication. The JSON body contains only `target_url` and an optional `profile` object. Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `profile` | Omitted | JSON fingerprint fields passed to the API. |
| `baseUrl` | `https://api.rayonapi.com` | API base URL; an optional path is retained. HTTPS is required except for localhost, `127.0.0.1`, and `::1` test servers. |
| `timeoutMs` | `150000` | Total request deadline, including the response body. Integer from 1 to 2147483647. |

The client performs one attempt and follows no redirects. It does not make requests to the target website itself.

An accepted result preserves the API's snake_case fields: `status`, `method`, `target_url`, `duration_ms`, `headers`, `cookies`, `profile_used`, and `errors`. `method` is `v8_sandbox` or `playwright`. Success requires exactly one complete six-header family with suffixes `a/b/c/d/f/z`; its prefix may vary, and `d` may be empty. `accepted` means the headers were captured; it does not establish verification by the target website. `errors` may contain diagnostics from an earlier capture tier even when a later tier succeeds.

Cookies retain their API-supplied `name`, `value`, `domain`, and `path`, plus safe future fields. No expiry, secure, or other browser attributes are inferred. Headers and profile objects use null prototypes; prototype-sensitive keys are rejected. Treat headers and cookies as sensitive session data.

`RayonError` exposes `kind`, optional `statusCode`, `requestId`, and `retryAfter` (seconds as a string when safely supplied). Its fixed message excludes raw response bodies and transport errors. HTTP 200 results with `failed` or `rejected` status throw a `capture` error.

| Kind | Meaning |
| --- | --- |
| `validation` | Invalid URL, key, profile, or options. |
| `auth` | HTTP 401 or 403. |
| `rate_limit` | HTTP 429. |
| `http` | Other unsuccessful HTTP status, including redirects. |
| `capture` | A valid capture response reported failure or rejection. |
| `invalid_response` | Malformed JSON or an invalid response contract. |
| `network` | Transport failed. |
| `timeout` | Request deadline expired. |

For local development:

```sh
npm ci
npm test
npm run build
npm run test:package
```

Tests use Undici's offline mock transport and a loopback server for streaming cancellation. The package check creates a tarball, audits its file list, and verifies ESM/CommonJS imports and declarations.

MIT licensed. This repository contains the API client only.
