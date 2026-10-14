# Rayon JavaScript SDK

Server-side JavaScript and TypeScript clients for `POST /v1/shape` and `GET /v1/usage`.
Node.js 20.18.1+ is required. ESM, CommonJS and TypeScript declarations are included.
Keep your API key on your server.

[Documentation](https://docs.rayonapi.com/) · [Releases](https://github.com/Rayon-API/rayon-sdk-js/releases)

## Install

```sh
npm install rayon-sdk-js@^1
```

## Generate headers

Prepare the full protection scripts from your authorized integration, in execution order.
URLs supply context; the SDK and API do not download them.

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
    profile: JSON.parse(await readFile('owned-profile.json', 'utf8')),
    request: {
      url: 'https://example.com/api/items',
      method: 'POST',
      content_type: 'application/json',
      body: '{"item":1}',
    },
  });
  // Apply result.headers with your own target client and session.
} finally {
  await client.close();
}
```

Use exactly one of `scripts` or a server-issued `material_ref`, with its original `source_url`.
Capture a fresh profile from your browser; `validate_profile(profile)` provides offline validation.
Keep the target URL, method, content type and body exact. GET/HEAD use `body: null`.
See [material preparation](https://docs.rayonapi.com/material) and [profiles and sessions](https://docs.rayonapi.com/profiles-and-sessions).

Persistent clients reuse unexpired material references. A failed reference is never automatically retried.
To replace an invalid cached reference before expiry, use a fresh client with your saved scripts.
No generation is automatically retried; admitted requests may consume account credit.
Results contain six site-specific headers and material metadata. No target cookies are returned.
Your target client maintains its own session and transport; generation does not guarantee target acceptance.

`client.usage()` reads account usage. `generate()` is a one-shot helper; `RayonError` exposes sanitized errors.
CommonJS users can load `RayonClient` with `require('rayon-sdk-js')`.
See the [API reference](https://docs.rayonapi.com/api-reference), [errors](https://docs.rayonapi.com/errors) and [migration guide](https://docs.rayonapi.com/migration).

[Support](mailto:support@rayonapi.com) · [Discord](https://discord.gg/TwhkJNyHWs) · [MIT license](LICENSE)
