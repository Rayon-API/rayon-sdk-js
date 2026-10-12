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
