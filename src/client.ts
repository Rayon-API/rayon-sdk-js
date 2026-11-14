import { Agent, request, type Dispatcher } from "undici";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  MaterialPreparation, ReadyMaterial, PreparationOptions, GetPreparationOptions, WaitUntilReadyOptions,
  PreparationRequest,
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
import { parsePreparation, preparationId } from "./preparation.js";
import { RayonError, isTransportTimeout } from "./errors.js";
import { isRecord, copyJson } from "./json.js";
import { validateShape, validUrl } from "./validation.js";
import { parseResult, readResponse, responseMetadata } from "./response.js";

/** Persistent client. Generation never uploads scripts, starts learning or retries automatically. */
export class RayonClient {
  #apiKey: string;
  #baseUrl: string;
  #timeoutMs: number;
  #dispatcher: Dispatcher;
  #ownedAgent?: Agent;
  #closed = false;
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
    if (this.#closed || !isRecord(options) ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal)))
      throw new RayonError("validation");
    if (options.signal?.aborted) throw new RayonError("aborted");
    const body = validateShape(shape);
    const [value, metadata] = await this.#send("POST", "/v1/shape", body, options);
    if (!isRecord(value) || !(
        ((value.path == null || value.path === "native") && value.fallback_reason == null) ||
        (value.path === "isolated" && value.fallback_reason === "material_preparing")))
      throw new RayonError("invalid_response", metadata);
    return parseResult(value, metadata, this.#apiKey, body.mode ?? "header");
  }
  /** Explicitly start preparation. Generation is never performed by this method. */
  async prepare(shape: PreparationRequest, options: PreparationOptions = {}): Promise<MaterialPreparation> {
    const body = validateShape(shape, true);
    const [value, metadata] = await this.#send("POST", "/v1/materials/prepare", body, options,
      undefined, randomUUID());
    return parsePreparation(value, metadata, this.#apiKey);
  }
  async getPreparation(id: string, options: GetPreparationOptions = {}): Promise<MaterialPreparation> {
    try { return await this.#getPreparation(id, options); }
    catch (error) {
      if (error instanceof RayonError && preparationId(id) && !id.includes(this.#apiKey))
        throw new RayonError(error.kind, {...error, preparationId: id});
      throw error;
    }
  }
  async #getPreparation(id: string, options: GetPreparationOptions, deadline?: number): Promise<MaterialPreparation> {
    if (!preparationId(id) || id.includes(this.#apiKey) || !isRecord(options as unknown) ||
        (options.wait !== undefined && (!Number.isSafeInteger(options.wait) || options.wait < 0 || options.wait > 10)))
      throw new RayonError("validation");
    const [value, metadata] = await this.#send("GET", `/v1/materials/preparations/${id}?wait=${options.wait ?? 0}`,
      undefined, options, deadline);
    return parsePreparation(value, metadata, this.#apiKey, id);
  }
  async waitUntilReady(id: string, options: WaitUntilReadyOptions = {}): Promise<ReadyMaterial> {
    if (!preparationId(id) || id.includes(this.#apiKey)) throw new RayonError("validation");
    const deadline = performance.now() + this.#waitBudget(options);
    try {
      while (true) {
        if (options.signal?.aborted) throw new RayonError("aborted");
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new RayonError("timeout");
        let result: MaterialPreparation;
        try {
          result = await this.#getPreparation(id, {signal: options.signal, wait: Math.min(10, Math.floor(Math.min(remaining, this.#timeoutMs) / 1000))}, deadline);
        } catch (error) {
          if (!(error instanceof RayonError) || !(
              error.kind === "network" || error.kind === "timeout" ||
              [408, 429, 500, 502, 503, 504].includes(error.statusCode ?? 0))) throw error;
          await this.#preparationPause(100 + Math.random() * 300, deadline, options.signal);
          continue;
        }
        if (result.state === "ready") return result as ReadyMaterial;
        if (result.state === "failed" || result.state === "expired")
          throw new RayonError(result.state === "failed" ? "preparation_failed" : "preparation_expired",
            {code: result.error?.code, reason: result.error?.reason, retryable: result.error?.retryable});
        await this.#preparationPause(Math.max(10, result.retry_after_ms), deadline, options.signal);
      }
    } catch (error) {
      if (error instanceof RayonError) throw new RayonError(error.kind, {...error, preparationId: id});
      throw error;
    }
  }
  async prepareAndWait(shape: PreparationRequest, options: WaitUntilReadyOptions = {}): Promise<ReadyMaterial> {
    this.#waitBudget(options);
    const result = await this.prepare(shape, options);
    if (result.state === "ready") return result as ReadyMaterial;
    return this.waitUntilReady(result.preparation_id, options);
  }
  #waitBudget(options: WaitUntilReadyOptions): number {
    if (!isRecord(options as unknown) ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
        (options.waitTimeoutMs !== undefined && (!Number.isSafeInteger(options.waitTimeoutMs) ||
          options.waitTimeoutMs <= 0 || options.waitTimeoutMs > 2147483647)))
      throw new RayonError("validation");
    return options.waitTimeoutMs ?? 30 * 60_000;
  }
  async #preparationPause(delay: number, deadline: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RayonError("aborted");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new RayonError("timeout");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new RayonError("aborted")); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(delay, remaining));
      signal?.addEventListener("abort", abort, {once:true});
    });
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
    body: ShapeRequest<"header" | "form"> | PreparationRequest | undefined,
    options: RequestOptions,
    deadline?: number,
    idempotencyKey?: string,
  ): Promise<[unknown, ErrorMetadata]> {
    if (
      this.#closed ||
      !isRecord(options) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    )
      throw new RayonError("validation");
    if (options.signal?.aborted) throw new RayonError("aborted");
    const budget = deadline === undefined ? this.#timeoutMs : Math.min(this.#timeoutMs, Math.ceil(deadline - performance.now()));
    if (budget <= 0) throw new RayonError("timeout");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), budget);
    let metadata: ErrorMetadata = {};
    try {
      const response = await request(this.#baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          ...(path === "/v1/shape" ? {"x-rayon-capabilities": "managed-fallback-v1"} : {}),
          ...(idempotencyKey ? {"idempotency-key": idempotencyKey} : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        headersTimeout: budget,
        bodyTimeout: budget,
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
          body?.mode === "form" || path.startsWith("/v1/materials/"),
          path.startsWith("/v1/materials/"),
        );
      } catch (error) {
        if (controller.signal.aborted || isTransportTimeout(error))
          throw new RayonError(
            options.signal?.aborted ? "aborted" : "timeout",
            metadata,
          );
        if (response.statusCode === 200 || (idempotencyKey && response.statusCode === 202))
          throw new RayonError("invalid_response", metadata);
      }
      metadata = responseMetadata(
        response.statusCode,
        response.headers,
        this.#apiKey,
        value,
      );
      if (response.statusCode !== 200 && !(idempotencyKey && response.statusCode === 202))
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
