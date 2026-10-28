import { Agent, request, type Dispatcher } from "undici";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  MaterialPreparation, ReadyMaterial, PreparationOptions, GetPreparationOptions, WaitUntilReadyOptions,
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

type MaterialEntry = {
  ref: string; expires: number; sourceUrl: string;
  scripts: ScriptMaterial[]; size: number;
};
type MaterialFlight = { ready: Promise<boolean>; finish: (success: boolean) => void };

/** Persistent client. Only confirmed uncharged material misses recover once. */
export class RayonClient {
  #apiKey: string;
  #baseUrl: string;
  #timeoutMs: number;
  #dispatcher: Dispatcher;
  #ownedAgent?: Agent;
  #closed = false;
  #cache = new Map<string, MaterialEntry>();
  #cacheBytes = 0;
  #flights = new Map<string, MaterialFlight>();
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
    this.#cacheBytes = 0;
    for (const flight of this.#flights.values()) flight.finish(false);
    this.#flights.clear();
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
    let scripts = body.scripts;
    let cacheKey: string | undefined;
    if (scripts) {
      cacheKey = createHash("sha256").update(JSON.stringify([
        body.source_url, scripts.map((s) => [s.url, s.source]),
      ])).digest("hex");
    } else if (body.material_ref !== undefined) {
      for (const [key, cached] of this.#cache) {
        if (cached.ref === body.material_ref && cached.sourceUrl === body.source_url) {
          cacheKey = key;
          scripts = cached.scripts;
          break;
        }
      }
    }
    const deadline = performance.now() + this.#timeoutMs;
    let recovered = false;
    while (true) {
      if (this.#closed) throw new RayonError("validation");
      if (options.signal?.aborted) throw new RayonError("aborted");
      let flight: MaterialFlight | undefined;
      if (cacheKey && scripts) {
        const pending = this.#flights.get(cacheKey);
        if (pending) {
          if (!await this.#waitMaterial(pending, options.signal, deadline))
            throw new RayonError("network");
          continue;
        }
        const cached = this.#cache.get(cacheKey);
        if (cached && cached.expires > Date.now() + 5000) {
          delete (body as { scripts?: ScriptMaterial[] }).scripts;
          (body as { material_ref?: string }).material_ref = cached.ref;
        } else {
          delete (body as { material_ref?: string }).material_ref;
          (body as { scripts?: ScriptMaterial[] }).scripts = scripts;
          if (this.#flights.size < 128) {
            let finish!: (success: boolean) => void;
            const ready = new Promise<boolean>((resolve) => { finish = resolve; });
            flight = { ready, finish };
            this.#flights.set(cacheKey, flight);
          }
        }
      }
      let success = false;
      try {
        const [value, metadata] = await this.#send("POST", "/v1/shape", body, options, deadline);
        const result = parseResult(value, metadata, this.#apiKey, body.mode ?? "header");
        if (cacheKey && scripts) this.#remember(cacheKey, scripts, body, result);
        success = true;
        return result;
      } catch (error) {
        if (recovered || !scripts || !body.material_ref ||
            !(error instanceof RayonError) || error.kind !== "http" ||
            error.statusCode !== 422 || error.code !== "material_expired" ||
            error.billingStatus !== "not_charged") throw error;
        const cached = cacheKey ? this.#cache.get(cacheKey) : undefined;
        if (cached?.ref === body.material_ref) cached.expires = 0;
        recovered = true;
      } finally {
        if (flight) {
          if (this.#flights.get(cacheKey!) === flight) this.#flights.delete(cacheKey!);
          flight.finish(success);
        }
      }
    }
  }
  #remember(key: string, scripts: ScriptMaterial[],
    body: ShapeRequest<"header" | "form">, result: ShapeResult | FormShapeResult): void {
    // Reference generations cannot extend TTL or undo a confirmed miss.
    if (this.#closed || !body.scripts) return;
    const previous = this.#cache.get(key);
    const size = Buffer.byteLength(JSON.stringify([body.source_url, scripts]));
    if (size > 16 * 1024 * 1024) return;
    if (previous) { this.#cacheBytes -= previous.size; this.#cache.delete(key); }
    while (this.#cache.size && (this.#cache.size >= 128 || this.#cacheBytes + size > 16 * 1024 * 1024)) {
      const oldestKey = this.#cache.keys().next().value!;
      this.#cacheBytes -= this.#cache.get(oldestKey)!.size;
      this.#cache.delete(oldestKey);
    }
    this.#cache.set(key, {ref: result.material_ref, expires: Date.parse(result.material_expires_at),
      sourceUrl: body.source_url, scripts, size});
    this.#cacheBytes += size;
  }
  async #waitMaterial(flight: MaterialFlight, signal: AbortSignal | undefined,
    deadline: number): Promise<boolean> {
    if (signal?.aborted) throw new RayonError("aborted");
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new RayonError("aborted")); };
      const timer = setTimeout(() => { cleanup(); reject(new RayonError("timeout")); },
        Math.max(0, deadline - performance.now()));
      signal?.addEventListener("abort", abort, {once: true});
      flight.ready.then((success) => { cleanup(); resolve(success); });
    });
  }
  /** Explicitly start preparation. Generation is never performed by this method. */
  async prepare(shape: ShapeRequest<"header" | "form">, options: PreparationOptions = {}): Promise<MaterialPreparation> {
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
  async prepareAndWait(shape: ShapeRequest<"header" | "form">, options: WaitUntilReadyOptions = {}): Promise<ReadyMaterial> {
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
    return options.waitTimeoutMs ?? 60000;
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
    body: ShapeRequest<"header" | "form"> | undefined,
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
