import { strictJson } from "./preparation.js";
import type { Dispatcher } from "undici";
import type {
  ShapeResult, FormShapeResult, ErrorMetadata, BrowserProfile,
} from "./types.js";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { RayonError, trustedGuidance, safeDomain, safeField, safeBillingStatus } from "./errors.js";
import { copyJson, isRecord } from "./json.js";
import { safeFormFields } from "./validation.js";

export function safeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value) || ![6, 7].includes(Object.keys(value).length))
    throw new Error("Invalid header set");
  const copied: Record<string, string> = Object.create(null);
  const suffixes = new Set<string>();
  let prefix: string | undefined;
  for (const [name, content] of Object.entries(value)) {
    const match = /^([!#$%&'*+\-.^_`|~0-9a-z]{1,128})-(a0|[abcdfz])$/i.exec(name);
    if (!match || typeof content !== "string" || /[^\x21-\x7e]/.test(content))
      throw new Error("Invalid header");
    const family = match[1].toLowerCase();
    const suffix = match[2].toLowerCase();
    if (
      (prefix !== undefined && prefix !== family) ||
      suffixes.has(suffix) ||
      (suffix !== "d" && !content.trim())
    )
      throw new Error("Incomplete header family");
    prefix = family;
    suffixes.add(suffix);
    copied[name] = content;
  }
  if (![..."abcdfz"].every(suffix => suffixes.has(suffix)))
    throw new Error("Incomplete header family");
  return copied;
}

const MAX_RESPONSE_BYTES = 256 * 1024;

export async function readResponse(
  body: Dispatcher.ResponseData["body"],
  encoding: string | string[] | undefined,
  signal: AbortSignal,
  strictUtf8 = false,
  strict = false,
): Promise<unknown> {
  const bounded = () => {
    let bytes = 0;
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > MAX_RESPONSE_BYTES
            ? new Error("Response limit exceeded")
            : null,
          chunk,
        );
      },
    });
  };
  const chunks: Buffer[] = [];
  const collector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const stages = [body, bounded()];
  if (encoding !== undefined && encoding !== "identity") {
    if (encoding === "gzip") stages.push(createGunzip());
    else if (encoding === "deflate") stages.push(createInflate());
    else if (encoding === "br") stages.push(createBrotliDecompress());
    else {
      body.destroy();
      throw new Error("Unsupported response encoding");
    }
    stages.push(bounded());
  }
  // Both wire bytes and decoded bytes are bounded; abort also cancels decoding.
  await pipeline([...stages, collector], { signal });
  const bytes = Buffer.concat(chunks);
  const text = strictUtf8
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    : bytes.toString("utf8");
  return strict ? strictJson(text) : JSON.parse(text) as unknown;
}

export function safeId(value: unknown, key: string): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    !value.includes(key)
    ? value
    : undefined;
}

export function parseResult(
  value: unknown,
  metadata: ErrorMetadata,
  key: string,
  mode: "header" | "form" = "header",
): ShapeResult | FormShapeResult {
  try {
    if (
      !isRecord(value) ||
      !safeId(value.request_id, key) ||
      !Number.isSafeInteger(value.generation_ms) ||
      (value.generation_ms as number) < 0 ||
      !isRecord(value.profile_used)
    )
      throw new Error();
    if (
      value.material_ref === undefined ||
      value.material_expires_at === undefined
    )
      throw new Error();
    if (
      value.material_ref !== undefined &&
      (typeof value.material_ref !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(value.material_ref) ||
        typeof value.material_expires_at !== "string" ||
        value.material_expires_at.length > 64 ||
        !/(?:Z|[+-]\d\d:\d\d)$/.test(value.material_expires_at) ||
        !Number.isFinite(Date.parse(value.material_expires_at)))
    )
      throw new Error();
    let transport:
      | { headers: Record<string, string> }
      | { form_fields: Record<string, string>; form_body: string };
    if (mode === "form") {
      if (Object.hasOwn(value, "headers")) throw new Error();
      transport = {
        form_fields: safeFormFields(value.form_fields, value.form_body),
        form_body: value.form_body as string,
      };
    } else {
      if (Object.hasOwn(value, "form_fields") || Object.hasOwn(value, "form_body")) throw new Error();
      transport = { headers: safeHeaders(value.headers) };
    }
    const result: ShapeResult | FormShapeResult = {
      ...transport,
      request_id: value.request_id as string,
      generation_ms: value.generation_ms as number,
      profile_used: copyJson(value.profile_used) as BrowserProfile,
      material_ref: value.material_ref as string,
      material_expires_at: value.material_expires_at as string,
    };
    Object.defineProperty(result, Symbol.for("nodejs.util.inspect.custom"), {
      value: () => ({
        request_id: result.request_id,
        generation_ms: result.generation_ms,
        ...(mode === "form"
          ? { form_fields: "[REDACTED]", form_body: "[REDACTED]" }
          : { headers: "[REDACTED]" }),
        profile_used: "[REDACTED]",
        material_ref: "[REDACTED]",
        material_expires_at: result.material_expires_at,
      }),
    });
    return result;
  } catch {
    throw new RayonError("invalid_response", metadata);
  }
}

export function responseMetadata(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  key: string,
  value?: unknown,
): ErrorMetadata {
  const retry = headers["retry-after"];
  const error =
    isRecord(value) && isRecord(value.error) ? value.error : undefined;
  const code = error?.code;
  const domain = safeDomain(error?.domain, key);
  const guidance = trustedGuidance(typeof code === "string" && !code.includes(key) ? code : undefined,
    typeof error?.reason === "string" && !error.reason.includes(key) ? error.reason : undefined, domain, typeof error?.retryable === "boolean" ? error.retryable : undefined, error?.billing_status);
  return {
    reason: guidance?.reason,
    action: guidance?.action,
    domain,
    field: safeField(error?.field, key),
    billingStatus: safeBillingStatus(error?.billing_status),
    retryable: typeof error?.retryable === "boolean" ? error.retryable : undefined,
    statusCode,
    requestId:
      safeId(error?.request_id, key) ?? safeId(headers["x-request-id"], key),
    retryAfter:
      typeof retry === "string" &&
        !retry.includes(key) &&
        (/^\d{1,10}$/.test(retry) || new Date(retry).toUTCString() === retry)
        ? retry
        : undefined,
    code:
      typeof code === "string" &&
        !code.includes(key) &&
        /^[a-z][a-z0-9_]{0,63}$/.test(code)
        ? code
        : undefined,
  };
}
