import { request } from 'undici';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Profile = { [key: string]: JsonValue };
export interface SolveOptions {
  profile?: Profile;
  baseUrl?: string;
  /** Total request deadline, including reading the response body. */
  timeoutMs?: number;
}
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  [key: string]: JsonValue;
}
export interface SolveResult {
  status: 'accepted';
  method: 'v8_sandbox' | 'playwright';
  target_url: string;
  duration_ms: number;
  headers: Record<string, string>;
  cookies: SessionCookie[];
  profile_used: Profile;
  errors: string[];
}
export type RayonErrorKind = 'validation' | 'auth' | 'rate_limit' | 'http' | 'capture' | 'invalid_response' | 'network' | 'timeout';
export interface ErrorMetadata {
  statusCode?: number;
  requestId?: string;
  retryAfter?: string;
}
const messages: Record<RayonErrorKind, string> = {
  validation: 'Invalid Rayon API request options.',
  auth: 'Rayon API denied authentication or access.',
  rate_limit: 'Rayon API request limit reached.',
  http: 'Rayon API returned an unsuccessful HTTP response.',
  capture: 'Rayon API could not capture a complete header set.',
  invalid_response: 'Rayon API returned an invalid response.',
  network: 'Rayon API request could not be completed.',
  timeout: 'Rayon API request timed out.',
};
export class RayonError extends Error {
  readonly kind: RayonErrorKind;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly retryAfter?: string;
  constructor(kind: RayonErrorKind, metadata: ErrorMetadata = {}) {
    super(messages[kind]);
    this.name = 'RayonError';
    this.kind = kind;
    this.statusCode = metadata.statusCode;
    this.requestId = metadata.requestId;
    this.retryAfter = metadata.retryAfter;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch { return false; }
}
function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid JSON value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, item => copyJson(item, ancestors));
    if (!isRecord(value)) throw new Error('Invalid JSON object');
    const copied: Profile = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Unsafe JSON key');
      copied[key] = copyJson(item, ancestors);
    }
    return copied;
  } finally { ancestors.delete(value); }
}
function safeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length !== 6) throw new Error('Invalid header set');
  const copied: Record<string, string> = Object.create(null);
  const suffixes = new Set<string>();
  let prefix: string | undefined;
  for (const [name, content] of Object.entries(value)) {
    const match = /^([!#$%&'*+\-.^_`|~0-9a-z]+)-([abcdfz])$/i.exec(name);
    if (!match || typeof content !== 'string' || /[\r\n\u0000]/.test(content)) throw new Error('Invalid header');
    const family = match[1].toLowerCase();
    const suffix = match[2].toLowerCase();
    if ((prefix !== undefined && prefix !== family) || suffixes.has(suffix) || (suffix !== 'd' && !content.trim())) throw new Error('Incomplete header family');
    prefix = family;
    suffixes.add(suffix);
    copied[name] = content;
  }
  return copied;
}
function parseResult(value: unknown, targetUrl: string, metadata: ErrorMetadata): SolveResult {
  try {
    if (!isRecord(value) || !['accepted', 'failed', 'rejected'].includes(value.status as string)
      || !['v8_sandbox', 'playwright'].includes(value.method as string)
      || value.target_url !== targetUrl || !validUrl(value.target_url)
      || !Number.isSafeInteger(value.duration_ms) || (value.duration_ms as number) < 0
      || !isRecord(value.headers) || !Array.isArray(value.cookies) || !isRecord(value.profile_used)
      || !Array.isArray(value.errors) || !value.errors.every(item => typeof item === 'string')) throw new Error('Invalid result');
    const profile = copyJson(value.profile_used) as Profile;
    const cookies = value.cookies.map(cookie => {
      if (!isRecord(cookie) || !['name', 'value', 'domain', 'path'].every(key => typeof cookie[key] === 'string')) throw new Error('Invalid cookie');
      // Preserve future fields supplied by the API; no browser attributes are inferred.
      return { ...(copyJson(cookie) as Profile) } as SessionCookie;
    });
    if (value.status !== 'accepted') throw new RayonError('capture', metadata);
    return {
      status: 'accepted', method: value.method as SolveResult['method'], target_url: targetUrl,
      duration_ms: value.duration_ms as number, headers: safeHeaders(value.headers), cookies,
      profile_used: profile, errors: [...value.errors] as string[],
    };
  } catch (error) {
    if (error instanceof RayonError) throw error;
    throw new RayonError('invalid_response', metadata);
  }
}
function responseMetadata(statusCode: number, headers: Record<string, string | string[] | undefined>, apiKey: string): ErrorMetadata {
  const requestId = headers['x-request-id'];
  const retryAfter = headers['retry-after'];
  return {
    statusCode,
    requestId: typeof requestId === 'string' && /^[a-z0-9._:-]{1,128}$/i.test(requestId) && !requestId.includes(apiKey) ? requestId : undefined,
    retryAfter: typeof retryAfter === 'string' && /^\d{1,10}$/.test(retryAfter) && !retryAfter.includes(apiKey) ? retryAfter : undefined,
  };
}

/** Capture telemetry headers through Rayon API. Keep API keys in server-side code. */
export async function solve(targetUrl: string, apiKey: string, options: SolveOptions = {}): Promise<SolveResult> {
  let endpoint: URL;
  let profile: Profile | undefined;
  let timeoutMs: number;
  try {
    if (!validUrl(targetUrl) || typeof apiKey !== 'string' || !apiKey || apiKey.trim() !== apiKey || /[^\x21-\x7e]/.test(apiKey)
      || !isRecord(options as unknown)) throw new Error('Invalid request');
    timeoutMs = options.timeoutMs ?? 150_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Invalid timeout');
    const baseUrl = options.baseUrl ?? 'https://api.rayonapi.com';
    if (!validUrl(baseUrl)) throw new Error('Invalid base URL');
    endpoint = new URL(baseUrl);
    if (endpoint.search || endpoint.hash || (endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('Unsafe base URL');
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/solve';
    if (options.profile !== undefined) {
      if (!isRecord(options.profile)) throw new Error('Invalid profile');
      profile = copyJson(options.profile) as Profile;
    }
  } catch { throw new RayonError('validation'); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let metadata: ErrorMetadata = {};
  try {
    const response = await request(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target_url: targetUrl, ...(profile === undefined ? {} : { profile }) }),
      signal: controller.signal, headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
    });
    metadata = responseMetadata(response.statusCode, response.headers, apiKey);
    if (response.statusCode !== 200) {
      // Discard without parsing server diagnostics or retaining the response body.
      response.body.destroy();
      const kind = response.statusCode === 401 || response.statusCode === 403 ? 'auth' : response.statusCode === 429 ? 'rate_limit' : 'http';
      throw new RayonError(kind, metadata);
    }
    let value: unknown;
    try { value = await response.body.json(); }
    catch {
      if (controller.signal.aborted) throw new RayonError('timeout', metadata);
      throw new RayonError('invalid_response', metadata);
    }
    return parseResult(value, targetUrl, metadata);
  } catch (error) {
    if (error instanceof RayonError) throw error;
    const timedOut = controller.signal.aborted || (isRecord(error) && ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error.code as string));
    throw new RayonError(timedOut ? 'timeout' : 'network', metadata);
  } finally { clearTimeout(timer); }
}
