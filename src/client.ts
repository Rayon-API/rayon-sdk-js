import { Agent, request, type Dispatcher } from "undici";
import { createHash } from "node:crypto";
import type {
  ShapeRequest,
  ShapeResult,
  FormShapeResult,
  HeaderShapeRequest,
  FormShapeRequest,
  ScriptMaterial,
  ClientOptions,
  RequestOptions,
  UsageResult,
  ErrorMetadata,
  GenerateOptions,
} from "./types.js";
import { RayonError, isTransportTimeout } from "./errors.js";
import { isRecord, copyJson } from "./json.js";
import { validateShape, validUrl } from "./validation.js";
import { parseResult, readResponse, responseMetadata } from "./response.js";

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
      const timeout = options.timeoutMs ?? 45000;
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
  generate(
    shape: HeaderShapeRequest, options?: RequestOptions,
  ): Promise<ShapeResult>;
  generate(
    shape: FormShapeRequest, options?: RequestOptions,
  ): Promise<FormShapeResult>;
  generate(
    shape: ShapeRequest<"header" | "form">, options?: RequestOptions,
  ): Promise<ShapeResult | FormShapeResult>;
  async generate(
    shape: ShapeRequest<"header" | "form">,
    options: RequestOptions = {},
  ): Promise<ShapeResult | FormShapeResult> {
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
    const result = parseResult(value, metadata, this.#apiKey, body.mode ?? "header");
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
    body: ShapeRequest<"header" | "form"> | undefined,
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
          body?.mode === "form",
        );
      } catch (error) {
        if (controller.signal.aborted || isTransportTimeout(error))
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
              : "http",
          metadata,
        );
      return [value, metadata];
    } catch (error) {
      if (error instanceof RayonError) throw error;
      const timedOut = controller.signal.aborted || isTransportTimeout(error);
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

export function generate(
  shape: HeaderShapeRequest, apiKey: string, options?: GenerateOptions,
): Promise<ShapeResult>;
export function generate(
  shape: FormShapeRequest, apiKey: string, options?: GenerateOptions,
): Promise<FormShapeResult>;
export function generate(
  shape: ShapeRequest<"header" | "form">, apiKey: string, options?: GenerateOptions,
): Promise<ShapeResult | FormShapeResult>;
export async function generate(
  shape: ShapeRequest<"header" | "form">,
  apiKey: string,
  options: GenerateOptions = {},
): Promise<ShapeResult | FormShapeResult> {
  const client = new RayonClient(apiKey, options);
  try {
    return await client.generate(shape, { signal: options.signal });
  } finally {
    await client.close();
  }
}
