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
  assert.equal(packed.version, "1.0.0");
  for (const file of packed.files)
    assert.match(
      file.path,
      /^(dist\/(esm|cjs)\/(index\.(js|d\.ts)|package\.json)|README\.md|RELEASE\.md|LICENSE|package\.json)$/,
    );
  for (const required of [
    "dist/esm/index.js",
    "dist/esm/index.d.ts",
    "dist/cjs/index.js",
    "dist/cjs/index.d.ts",
    "dist/cjs/package.json",
    "LICENSE",
  ]) {
    assert.ok(
      packed.files.some((file) => file.path === required),
      `Missing ${required}`,
    );
  }
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
  const smoke = `const assert = IMPORT_ASSERT; const { generate, validate_profile, RayonError } = IMPORT_SDK;\n(async () => { assert.equal(typeof generate, 'function'); assert.equal(typeof validate_profile, 'function'); assert.equal(validate_profile({ navigator: {vendor: '😀'.repeat(5000)} }).navigator.vendor.length, 10000); await assert.rejects(generate({}, 'key'), e => e instanceof RayonError && e.kind === 'validation'); })().catch(e => { console.error(e); process.exitCode = 1; });`;
  writeFileSync(
    join(temp, "smoke.cjs"),
    smoke
      .replace("IMPORT_ASSERT", "require('node:assert/strict')")
      .replace("IMPORT_SDK", "require('rayon-sdk-js')"),
  );
  writeFileSync(
    join(temp, "smoke.mjs"),
    smoke
      .replace(
        "const assert = IMPORT_ASSERT;",
        "import assert from 'node:assert/strict';",
      )
      .replace(
        "const { generate, validate_profile, RayonError } = IMPORT_SDK;",
        "import { generate, validate_profile, RayonError } from 'rayon-sdk-js';",
      ),
  );
  for (const file of ["smoke.mjs", "smoke.cjs"])
    execFileSync(process.execPath, [file], { cwd: temp, stdio: "inherit" });
  for (const extension of ["mts", "cts"]) {
    writeFileSync(
      join(temp, `consumer.${extension}`),
      "import { generate, validate_profile, RayonError, type ShapeResult, type GenerateOptions } from 'rayon-sdk-js';\nconst options: GenerateOptions = { timeoutMs: 1000 };\nconst result: Promise<ShapeResult> = generate({ source_url: 'https://example.com', scripts: [{url: 'https://example.com/owned.js', source: '/* owned */'}], profile: {}, request: {url: 'https://example.com', method: 'GET', content_type: null, body: null} }, 'key', options);\nconst profile = validate_profile({ navigator: {vendor: '😀'.repeat(5000)} });\nconst error: string = new RayonError('timeout').kind;\n",
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
    `Verified ${packed.filename}: file allowlist, ESM/CommonJS imports, and both declaration exports.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
