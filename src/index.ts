import { Agent, request, type Dispatcher } from "undici";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type Profile = { [key: string]: JsonValue };
export interface BrowserProfile {
  user_agent?: string;
  platform?: string;
  language?: string;
  languages?: string[];
  screen?: {
    width?: number;
    height?: number;
    availWidth?: number;
    availHeight?: number;
    colorDepth?: number;
    pixelDepth?: number;
  };
  window?: {
    innerWidth?: number;
    innerHeight?: number;
    outerWidth?: number;
    outerHeight?: number;
    screenX?: number;
    screenY?: number;
    screenLeft?: number;
    screenTop?: number;
    pageXOffset?: number;
    pageYOffset?: number;
    devicePixelRatio?: number;
  };
  webgl?: { renderer?: string; vendor?: string };
  canvas?: { data_url?: string };
  navigator?: {
    userAgent?: string;
    platform?: string;
    vendor?: string;
    appVersion?: string;
    appCodeName?: string;
    appName?: string;
    product?: string;
    language?: string;
    languages?: string[];
    hardwareConcurrency?: number;
    maxTouchPoints?: number;
    webdriver?: boolean;
    cookieEnabled?: boolean;
    doNotTrack?: string | null;
  };
}
export interface ScriptMaterial {
  url: string;
  source: string;
}
export interface TargetRequest {
  url: string;
  method: string;
  content_type: string | null;
  body: string | null;
}
type MaterialInput =
  | { scripts: ScriptMaterial[]; material_ref?: never }
  | { scripts?: never; material_ref: string };
export type ShapeRequest = {
  source_url: string;
  profile: BrowserProfile;
  request: TargetRequest;
  document_cookie?: string;
} & MaterialInput;
export interface ShapeResult {
  headers: Record<string, string>;
  request_id: string;
  generation_ms: number;
  profile_used: BrowserProfile;
  material_ref?: string;
  material_expires_at?: string;
}
export interface ClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Optional injected dispatcher; owned by caller. */ dispatcher?: Dispatcher;
}
export interface GenerateOptions extends ClientOptions {
  signal?: AbortSignal;
}
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface UsageResult {
  request_id?: string;
  daily_used?: number;
  monthly_used?: number;
  [key: string]: JsonValue | undefined;
}
export type RayonErrorKind =
  | "validation"
  | "auth"
  | "rate_limit"
  | "http"
  | "migration"
  | "invalid_response"
  | "network"
  | "timeout"
  | "aborted";
export interface ErrorMetadata {
  statusCode?: number;
  requestId?: string;
  retryAfter?: string;
  code?: string;
}
const messages: Record<RayonErrorKind, string> = {
  validation: "Invalid Rayon API request options.",
  auth: "Rayon API denied authentication or access.",
  rate_limit: "Rayon API request limit reached.",
  http: "Rayon API returned an unsuccessful HTTP response.",
  migration:
    "This API is retired. Migrate to POST /v1/shape with caller-supplied material.",
  invalid_response: "Rayon API returned an invalid response.",
  network: "Rayon API request could not be completed.",
  timeout: "Rayon API request timed out.",
  aborted: "Rayon API request was aborted.",
};
export class RayonError extends Error {
  readonly kind: RayonErrorKind;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly retryAfter?: string;
  readonly code?: string;
  constructor(kind: RayonErrorKind, metadata: ErrorMetadata = {}) {
    super(messages[kind]);
    this.name = "RayonError";
    this.kind = kind;
    this.statusCode = metadata.statusCode;
    this.requestId = metadata.requestId;
    this.retryAfter = metadata.retryAfter;
    this.code = metadata.code;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
function validUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /[\u0000-\u0020\u007f\\#]/.test(value)
  )
    return false;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value);
  if (!authority || !authority[1] || authority[1].includes("@")) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.port !== "0"
    );
  } catch {
    return false;
  }
}
function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("Invalid JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return Array.from(value, (item) => copyJson(item, ancestors));
    if (!isRecord(value)) throw new Error("Invalid JSON object");
    const copied: Profile = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        throw new Error("Unsafe JSON key");
      copied[key] = copyJson(item, ancestors);
    }
    return copied;
  } finally {
    ancestors.delete(value);
  }
}
function safeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length !== 6)
    throw new Error("Invalid header set");
  const copied: Record<string, string> = Object.create(null);
  const suffixes = new Set<string>();
  let prefix: string | undefined;
  for (const [name, content] of Object.entries(value)) {
    const match = /^([!#$%&'*+\-.^_`|~0-9a-z]+)-([abcdfz])$/i.exec(name);
    if (
      !match ||
      typeof content !== "string" ||
      /[\u0000-\u001f\u007f\u0100-\uffff]/.test(content)
    )
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
  return copied;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
async function readResponse(
  body: Dispatcher.ResponseData["body"],
  encoding: string | string[] | undefined,
  signal: AbortSignal,
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const profileFields = {
  user_agent: "string",
  platform: "string",
  language: "string",
  languages: "strings",
  screen: "object",
  window: "object",
  webgl: "object",
  canvas: "object",
  navigator: "object",
};
const intFields = (names: string[]) =>
  Object.fromEntries(names.map((k) => [k, "integer"]));
const nestedFields: Record<string, Record<string, string>> = {
  screen: intFields([
    "width",
    "height",
    "availWidth",
    "availHeight",
    "colorDepth",
    "pixelDepth",
  ]),
  window: {
    ...intFields([
      "innerWidth",
      "innerHeight",
      "outerWidth",
      "outerHeight",
      "screenX",
      "screenY",
      "screenLeft",
      "screenTop",
      "pageXOffset",
      "pageYOffset",
    ]),
    devicePixelRatio: "number",
  },
  webgl: { renderer: "string", vendor: "string" },
  canvas: { data_url: "string" },
  navigator: {
    ...Object.fromEntries(
      [
        "userAgent",
        "platform",
        "vendor",
        "appVersion",
        "appCodeName",
        "appName",
        "product",
        "language",
      ].map((k) => [k, "string"]),
    ),
    languages: "strings",
    hardwareConcurrency: "integer",
    maxTouchPoints: "integer",
    webdriver: "boolean",
    cookieEnabled: "boolean",
    doNotTrack: "nullableString",
  },
};
function checkFields(
  value: unknown,
  fields: Record<string, string>,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!Object.hasOwn(fields, key)) return false;
    switch (fields[key]) {
      case "strings":
        return Array.isArray(item) && item.every((x) => typeof x === "string");
      case "integer":
        return Number.isSafeInteger(item);
      case "number":
        return typeof item === "number" && Number.isFinite(item);
      case "object":
        return isRecord(item);
      case "nullableString":
        return item === null || typeof item === "string";
      default:
        return typeof item === fields[key];
    }
  });
}
function validProfile(value: unknown): value is BrowserProfile {
  if (!checkFields(value, profileFields)) return false;
  if (
    Object.entries(nestedFields).some(
      ([k, fields]) =>
        Object.hasOwn(value, k) && !checkFields(value[k], fields),
    )
  )
    return false;
  const nav = value.navigator as Record<string, unknown> | undefined;
  if (
    nav &&
    [
      ["user_agent", "userAgent"],
      ["platform", "platform"],
      ["language", "language"],
      ["languages", "languages"],
    ].some(
      ([k, a]) =>
        Object.hasOwn(value, k) &&
        Object.hasOwn(nav, a) &&
        JSON.stringify(value[k]) !== JSON.stringify(nav[a]),
    )
  )
    return false;
  const canvas = value.canvas as Record<string, string> | undefined;
  if (
    canvas &&
    Object.hasOwn(canvas, "data_url") &&
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(canvas.data_url)
  )
    return false;
  for (const obj of [value, nav, value.webgl]) {
    if (isRecord(obj)) {
      if (
        Object.values(obj).some((v) => typeof v === "string" && v.length > 8192)
      )
        return false;
      if (
        Object.hasOwn(obj, "languages") &&
        ((obj.languages as string[]).length < 1 ||
          (obj.languages as string[]).length > 32 ||
          (obj.languages as string[]).some((v) => v.length > 8192))
      )
        return false;
    }
  }
  const ranges: Record<string, Record<string, [number, number]>> = {
    screen: {
      width: [1, 32768],
      height: [1, 32768],
      availWidth: [0, 32768],
      availHeight: [0, 32768],
      colorDepth: [1, 64],
      pixelDepth: [1, 64],
    },
    window: {
      innerWidth: [1, 32768],
      innerHeight: [1, 32768],
      outerWidth: [1, 32768],
      outerHeight: [1, 32768],
      devicePixelRatio: [0.1, 16],
    },
    navigator: { hardwareConcurrency: [1, 1024], maxTouchPoints: [0, 100] },
  };
  for (const [section, fields] of Object.entries(ranges)) {
    const obj = value[section];
    if (
      isRecord(obj) &&
      Object.entries(fields).some(
        ([k, [lo, hi]]) =>
          Object.hasOwn(obj, k) &&
          ((obj[k] as number) < lo || (obj[k] as number) > hi),
      )
    )
      return false;
  }
  return true;
}
function validateShape(value: ShapeRequest): ShapeRequest {
  try {
    const v = copyJson(value) as Record<string, unknown>;
    if (
      !isRecord(v) ||
      !["source_url", "profile", "request"].every((k) => Object.hasOwn(v, k)) ||
      Object.keys(v).some(
        (k) =>
          ![
            "source_url",
            "scripts",
            "material_ref",
            "profile",
            "request",
            "document_cookie",
          ].includes(k),
      ) ||
      !validUrl(v.source_url) ||
      Object.hasOwn(v, "scripts") === Object.hasOwn(v, "material_ref")
    )
      throw new Error();
    if (Object.hasOwn(v, "scripts")) {
      if (
        !Array.isArray(v.scripts) ||
        v.scripts.length < 1 ||
        v.scripts.length > 16
      )
        throw new Error();
      for (const script of v.scripts)
        if (
          !isRecord(script) ||
          Object.keys(script).length !== 2 ||
          !validUrl(script.url) ||
          typeof script.source !== "string" ||
          !script.source ||
          Buffer.byteLength(script.source) > 2 * 1024 * 1024
        )
          throw new Error();
      if (
        v.scripts.reduce(
          (n: number, s: any) => n + Buffer.byteLength(s.source),
          0,
        ) >
        3 * 1024 * 1024
      )
        throw new Error();
    } else if (
      typeof v.material_ref !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(v.material_ref)
    )
      throw new Error();
    if (
      !validProfile(v.profile) ||
      Buffer.byteLength(JSON.stringify(v.profile)) > 64 * 1024
    )
      throw new Error();
    const r = v.request;
    if (
      !isRecord(r) ||
      Object.keys(r).length !== 4 ||
      !["url", "method", "content_type", "body"].every((k) =>
        Object.hasOwn(r, k),
      ) ||
      !validUrl(r.url) ||
      typeof r.method !== "string" ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        r.method,
      )
    )
      throw new Error();
    if (
      r.content_type !== null &&
      (typeof r.content_type !== "string" ||
        r.content_type.length > 256 ||
        !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(
          r.content_type,
        ) ||
        /[\u0000-\u001f\u007f]/.test(r.content_type))
    )
      throw new Error();
    if (
      r.body !== null &&
      (typeof r.body !== "string" || Buffer.byteLength(r.body) > 256 * 1024)
    )
      throw new Error();
    if (
      r.body !== null &&
      (r.method === "GET" ||
        r.method === "HEAD" ||
        !r.content_type ||
        [
          "application/octet-stream",
          "application/pdf",
          "application/zip",
        ].includes((r.content_type as string).split(";")[0].toLowerCase()) ||
        /^(image|audio|video|multipart)\//i.test(r.content_type as string))
    )
      throw new Error();
    if (
      Object.hasOwn(v, "document_cookie") &&
      (typeof v.document_cookie !== "string" ||
        Buffer.byteLength(v.document_cookie) > 16 * 1024 ||
        /[\u0000-\u001f\u007f]/.test(v.document_cookie))
    )
      throw new Error();
    if (Buffer.byteLength(JSON.stringify(v)) > 4 * 1024 * 1024)
      throw new Error();
    return v as unknown as ShapeRequest;
  } catch {
    throw new RayonError("validation");
  }
}
function safeId(value: unknown, key: string): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    !value.includes(key)
    ? value
    : undefined;
}
function parseResult(
  value: unknown,
  metadata: ErrorMetadata,
  key: string,
): ShapeResult {
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
      (value.material_ref === undefined) !==
      (value.material_expires_at === undefined)
    )
      throw new Error();
    if (
      value.material_ref !== undefined &&
      (typeof value.material_ref !== "string" ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(value.material_ref) ||
        typeof value.material_expires_at !== "string" ||
        value.material_expires_at.length > 64 ||
        !/(?:Z|[+-]\d\d:\d\d)$/.test(value.material_expires_at) ||
        !Number.isFinite(Date.parse(value.material_expires_at)))
    )
      throw new Error();
    const result: ShapeResult = {
      headers: safeHeaders(value.headers),
      request_id: value.request_id as string,
      generation_ms: value.generation_ms as number,
      profile_used: copyJson(value.profile_used) as BrowserProfile,
      ...(value.material_ref === undefined
        ? {}
        : {
            material_ref: value.material_ref as string,
            material_expires_at: value.material_expires_at as string,
          }),
    };
    Object.defineProperty(result, Symbol.for("nodejs.util.inspect.custom"), {
      value: () => ({
        request_id: result.request_id,
        generation_ms: result.generation_ms,
        headers: "[REDACTED]",
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
function responseMetadata(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  key: string,
  value?: unknown,
): ErrorMetadata {
  const retry = headers["retry-after"];
  const error =
    isRecord(value) && isRecord(value.error) ? value.error : undefined;
  const code = error?.code;
  return {
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

/** Persistent ordinary-TLS client. No automatic generation retries or URL downloads. */
export class RayonClient {
  #apiKey: string;
  #baseUrl: string;
  #timeoutMs: number;
  #dispatcher: Dispatcher;
  #ownedAgent?: Agent;
  #closed = false;
  #cache = new Map<string, { ref: string; expires: number }>();
  constructor(apiKey: string, options: ClientOptions = {}) {
    try {
      if (
        typeof apiKey !== "string" ||
        !apiKey ||
        /[^\x21-\x7e]/.test(apiKey) ||
        !isRecord(options as unknown)
      )
        throw new Error();
      const base = options.baseUrl ?? "https://api.rayonapi.com";
      if (!validUrl(base)) throw new Error();
      const parsed = new URL(base);
      if (
        parsed.search ||
        (parsed.protocol === "http:" &&
          !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
      )
        throw new Error();
      const timeout = options.timeoutMs ?? 150000;
      if (
        !Number.isSafeInteger(timeout) ||
        timeout <= 0 ||
        timeout > 2147483647
      )
        throw new Error();
      this.#apiKey = apiKey;
      this.#baseUrl = base.replace(/\/$/, "");
      this.#timeoutMs = timeout;
      this.#ownedAgent = options.dispatcher ? undefined : new Agent();
      this.#dispatcher = options.dispatcher ?? this.#ownedAgent!;
    } catch {
      throw new RayonError("validation");
    }
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return {
      client: "RayonClient",
      credentials: "[REDACTED]",
      closed: this.#closed,
    };
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cache.clear();
    await this.#ownedAgent?.close();
  }
  async generate(
    shape: ShapeRequest,
    options: RequestOptions = {},
  ): Promise<ShapeResult> {
    const body = validateShape(shape);
    let cacheKey: string | undefined;
    if (body.scripts) {
      cacheKey = createHash("sha256")
        .update(
          JSON.stringify([
            body.source_url,
            body.scripts.map((s) => [s.url, s.source]),
          ]),
        )
        .digest("hex");
      const cached = this.#cache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        delete (body as { scripts?: ScriptMaterial[] }).scripts;
        (body as { material_ref?: string }).material_ref = cached.ref;
      } else if (cached) this.#cache.delete(cacheKey);
    }
    const [value, metadata] = await this.#send(
      "POST",
      "/v1/shape",
      body,
      options,
    );
    const result = parseResult(value, metadata, this.#apiKey);
    if (cacheKey && result.material_ref && result.material_expires_at) {
      const expires = Date.parse(result.material_expires_at);
      if (expires > Date.now()) {
        if (this.#cache.size >= 128)
          this.#cache.delete(this.#cache.keys().next().value!);
        this.#cache.set(cacheKey, { ref: result.material_ref, expires });
      }
    }
    return result;
  }
  async usage(options: RequestOptions = {}): Promise<UsageResult> {
    const [value] = await this.#send("GET", "/v1/usage", undefined, options);
    try {
      if (!isRecord(value)) throw new Error();
      return copyJson(value) as UsageResult;
    } catch {
      throw new RayonError("invalid_response");
    }
  }
  async #send(
    method: "GET" | "POST",
    path: string,
    body: ShapeRequest | undefined,
    options: RequestOptions,
  ): Promise<[unknown, ErrorMetadata]> {
    if (
      this.#closed ||
      !isRecord(options) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    )
      throw new RayonError("validation");
    if (options.signal?.aborted) throw new RayonError("aborted");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let metadata: ErrorMetadata = {};
    try {
      const response = await request(this.#baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        headersTimeout: this.#timeoutMs,
        bodyTimeout: this.#timeoutMs,
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
      metadata = responseMetadata(
        response.statusCode,
        response.headers,
        this.#apiKey,
      );
      let value: unknown;
      try {
        value = await readResponse(
          response.body,
          response.headers["content-encoding"],
          controller.signal,
        );
      } catch {
        if (controller.signal.aborted)
          throw new RayonError(
            options.signal?.aborted ? "aborted" : "timeout",
            metadata,
          );
        if (response.statusCode === 200)
          throw new RayonError("invalid_response", metadata);
      }
      metadata = responseMetadata(
        response.statusCode,
        response.headers,
        this.#apiKey,
        value,
      );
      if (response.statusCode !== 200)
        throw new RayonError(
          response.statusCode === 401 || response.statusCode === 403
            ? "auth"
            : response.statusCode === 429
              ? "rate_limit"
              : response.statusCode === 410
                ? "migration"
                : "http",
          metadata,
        );
      return [value, metadata];
    } catch (error) {
      if (error instanceof RayonError) throw error;
      const timedOut =
        controller.signal.aborted ||
        (isRecord(error) &&
          ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(
            error.code as string,
          ));
      throw new RayonError(
        options.signal?.aborted ? "aborted" : timedOut ? "timeout" : "network",
        metadata,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
export async function generate(
  shape: ShapeRequest,
  apiKey: string,
  options: GenerateOptions = {},
): Promise<ShapeResult> {
  const client = new RayonClient(apiKey, options);
  try {
    return await client.generate(shape, { signal: options.signal });
  } finally {
    await client.close();
  }
}
