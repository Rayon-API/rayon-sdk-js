# Publishing

The public package is `rayon-sdk-js`. Its repository identity is:

| Setting | Exact value |
| --- | --- |
| GitHub organization / owner | `Rayon-API` |
| GitHub repository | `rayon-sdk-js` |
| Workflow filename | `publish.yml` |
| GitHub environment | `npm` |
| npm registry | `https://registry.npmjs.org/` |

Publishing is a maintainer action. The initial package publication requires registry authentication and ownership of the unscoped `rayon-sdk-js` name; this repository does not provide credentials. A GitHub organization does not by itself confer npm package ownership.

Before the first publication, authenticate interactively with npm as the intended package owner, confirm the name is available or already owned by that account, and run from a clean, reviewed checkout:

```sh
npm ci
npm test
npm run build
npm run test:package
npm publish --access public
```

Do not publish the same version again. The initial authenticated publication establishes the package; use the release workflow for subsequent versions. Creating a published GitHub release for that already published bootstrap version would cause npm to reject the duplicate.

After the package exists, open its npm settings and add a GitHub Actions trusted publisher with the exact owner, repository, workflow, and environment values above. Allow the publisher to publish packages. Configure the GitHub `npm` environment and any desired required reviewers. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Create the trusted publisher when the next release is ready: npm requires its first successful publish within two days to validate the repository identity. If it expires, recreate the configuration before releasing.

The workflow runs on GitHub-hosted runners using Node.js 24 and verifies npm is at least 11.5.1. Its publish job has `id-token: write`, uses the `npm` environment, and calls npm directly without a stored npm token. Trusted publishing supplies OIDC authentication and provenance. Match the npm configuration to the workflow identity exactly.

For a later release, update `package.json` and `package-lock.json` to the same new version, commit the reviewed changes, tag that commit `v<version>`, and create a GitHub release for that tag. Publishing the release triggers tests, both builds, the tarball audit, import/type checks, and tag/version validation before `npm publish --access public`.

Prereleases must use an appropriate npm dist-tag; the supplied workflow intentionally rejects GitHub prereleases. No registry publish or remote push is performed by local tests or builds.

Version 1.0 is a breaking migration to the material-only API. Verify README migration guidance, exact target body preservation, lifecycle and cancellation, strict size/profile limits, safe error envelopes, expiry-scoped references, no automatic POST retries, and ESM/CommonJS type exports. Keep published 0.1 packages and release tags immutable. Never include customer scripts, captured material, credentials, or private fixtures in packed files.

Version 1.0.2 preserves the four runtime exports and 12 public types across both module formats while splitting the implementation into eight modules. Check the exact tarball allowlist, reusable response references, and native transport timeouts before release. Run the package audit on Node.js 20.18.1 and Node.js 22 as well as the publishing toolchain.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

Version 1.1.0 adds optional form mode. Verify strict encoding, application duplicates,
exact-case form families, telemetry-only body composition, transport mismatch rejection,
material reuse, and new public form types before publishing. Verify the six required
headers with optional fresh same-family `a0`, original names and values, duplicate and
incomplete-family rejection, and exactly six form fields with a larger `a` value.
