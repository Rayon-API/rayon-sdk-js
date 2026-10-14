import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "rayon-package-"));
try {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert.equal(packed.name, "rayon-sdk-js");
  assert.equal(packed.version, "1.1.0");
  const modules = [
    "index", "types", "errors", "json", "profile", "validation", "response", "client",
  ];
  const expected = [
    "README.md", "RELEASE.md", "CHANGELOG.md", "LICENSE", "package.json", "dist/cjs/package.json",
  ];
  for (const format of ["esm", "cjs"])
    for (const module of modules)
      for (const extension of ["js", "d.ts"])
        expected.push(`dist/${format}/${module}.${extension}`);
  // Exact equality rejects unexpected files and requires every runtime dependency.
  assert.deepEqual(packed.files.map((file) => file.path).sort(), expected.sort());
  const installed = join(temp, "node_modules", "rayon-sdk-js");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(temp, packed.filename),
    "-C",
    installed,
    "--strip-components=1",
  ]);
  symlinkSync(
    join(root, "node_modules", "undici"),
    join(temp, "node_modules", "undici"),
    "dir",
  );
  symlinkSync(
    join(root, "node_modules", "@types"),
    join(temp, "node_modules", "@types"),
    "dir",
  );
  writeFileSync(join(temp, "package.json"), '{"type":"module"}');
  const smoke = `IMPORT_ASSERT
IMPORT_SDK
assert.deepEqual(Object.keys(sdk).sort(), ['RayonClient', 'RayonError', 'generate', 'validate_profile']);
const { RayonClient, generate, validate_profile, RayonError } = sdk;
(async () => {
  assert.equal(typeof RayonClient, 'function');
  assert.equal(typeof generate, 'function');
  assert.equal(typeof validate_profile, 'function');
  assert.equal(typeof RayonError, 'function');
  assert.equal(validate_profile({ navigator: {vendor: '😀'.repeat(5000)} }).navigator.vendor.length, 10000);
  const client = new RayonClient('key');
  await client.close();
  await assert.rejects(generate({}, 'key'), e => e instanceof RayonError && e.kind === 'validation');
})().catch(e => { console.error(e); process.exitCode = 1; });`;
  writeFileSync(
    join(temp, "smoke.cjs"),
    smoke.replace("IMPORT_ASSERT", "const assert = require('node:assert/strict');")
      .replace("IMPORT_SDK", "const sdk = require('rayon-sdk-js');"),
  );
  writeFileSync(
    join(temp, "smoke.mjs"),
    smoke.replace("IMPORT_ASSERT", "import assert from 'node:assert/strict';")
      .replace("IMPORT_SDK", "import * as sdk from 'rayon-sdk-js';"),
  );
  for (const file of ["smoke.mjs", "smoke.cjs"])
    execFileSync(process.execPath, [file], { cwd: temp, stdio: "inherit" });
  for (const extension of ["mts", "cts"]) {
    writeFileSync(
      join(temp, `consumer.${extension}`),
      `import {
  RayonClient, generate, validate_profile, RayonError,
  type JsonValue, type BrowserProfile, type ScriptMaterial, type TargetRequest,
  type ShapeRequest, type ShapeResult, type FormShapeRequest, type HeaderShapeRequest, type FormShapeResult, type FormMetadata, type ClientOptions, type GenerateOptions,
  type RequestOptions, type UsageResult, type RayonErrorKind, type ErrorMetadata,
} from 'rayon-sdk-js';
const json: JsonValue = { nested: [null, true, 1, 'value'] };
const profile: BrowserProfile = validate_profile({ navigator: {vendor: '😀'.repeat(5000)} });
const scripts: ScriptMaterial[] = [{url: 'https://example.com/owned.js', source: '/* owned */'}];
const target: TargetRequest = {url: 'https://example.com', method: 'GET', content_type: null, body: null};
const shape: ShapeRequest = {source_url: 'https://example.com', scripts, profile, request: target};
const clientOptions: ClientOptions = { timeoutMs: 1000 };
const options: GenerateOptions = { ...clientOptions, signal: new AbortController().signal };
const requestOptions: RequestOptions = { signal: options.signal };
const result: Promise<ShapeResult> = generate(shape, 'key', options);
const client = new RayonClient('key', clientOptions);
const generated: Promise<ShapeResult> = client.generate(shape, requestOptions);
const usage: Promise<UsageResult> = client.usage(requestOptions);
const formMetadata: FormMetadata = { id: 'checkout' };
const formShape: FormShapeRequest = { source_url: 'https://example.com', scripts, profile, mode: 'form', form: formMetadata, request: { ...target, method: 'POST', content_type: 'application/x-www-form-urlencoded', body: '' } };
const formResult: Promise<ShapeResult<"form">> = generate(formShape, 'key', options);
const clientFormResult: Promise<FormShapeResult> = client.generate(formShape, requestOptions);
function existingHeaderWrapper(value: ShapeRequest): Promise<ShapeResult> { return client.generate(value); }
const headerShape: HeaderShapeRequest = shape;
const headerResult: Promise<ShapeResult> = client.generate(headerShape);
const dynamicShape: ShapeRequest<"header" | "form"> = Math.random() > 0.5 ? headerShape : formShape;
const dynamicResult: Promise<ShapeResult | FormShapeResult> = client.generate(dynamicShape);
formResult.then(value => {
  const body: string = value.form_body;
  const fields: Record<string, string> = value.form_fields;
  // @ts-expect-error form responses have no header transport
  value.headers;
});
const kind: RayonErrorKind = 'timeout';
const metadata: ErrorMetadata = {statusCode: 200, requestId: 'req-test', code: 'safe', retryAfter: '1'};
const error: RayonError = new RayonError(kind, metadata);
const errorKind: RayonErrorKind = error.kind;
`,
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        `consumer.${extension}`,
      ],
      { cwd: temp, stdio: "inherit" },
    );
  }
  console.log(
    `Verified ${packed.filename}: all 38 required files, four ESM/CommonJS runtime exports, and 16 public types in both declaration formats.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
