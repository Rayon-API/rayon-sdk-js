import type { RayonErrorKind, ErrorMetadata } from "./types.js";

import { errorCatalog } from "./error-catalog.js";

const historyAction = "Check request history before sending another request. Contact support with the request ID if it remains unclear.";

export function trustedGuidance(code?: string, reason?: string, domain?: string, retryable?: boolean, billingStatus?: unknown) {
  if (typeof reason !== "string" || !Object.hasOwn(errorCatalog, reason)) return undefined;
  const entry = errorCatalog[reason as keyof typeof errorCatalog];
  if (!(entry.codes as readonly string[]).includes(code ?? "")) return undefined;
  return { reason, message: entry.message.replace("{domain}", safeDomain(domain) ?? "this domain"), action: entry.retryable && (safeBillingStatus(billingStatus) !== "not_charged" || retryable === false) ? historyAction : entry.action };
}

const messages: Record<RayonErrorKind, string> = {
  preparation_failed: "Rayon material preparation failed.",
  preparation_expired: "Rayon material preparation expired.",
  validation: "Invalid Rayon API request options.",
  auth: "Rayon API denied authentication or access.",
  rate_limit: "Rayon API request limit reached.",
  http: "Rayon API returned an unsuccessful HTTP response.",
  migration: "Rayon API returned an unsuccessful HTTP response.",
  invalid_response: "Rayon API returned an invalid response.",
  network: "Rayon API request could not be completed.",
  timeout: "Rayon API request timed out.",
  aborted: "Rayon API request was aborted.",
};

export class RayonError extends Error {
  readonly kind: RayonErrorKind;
  readonly preparationId?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly retryAfter?: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly reason?: string;
  readonly action?: string;
  readonly domain?: string;
  readonly field?: string;
  readonly billingStatus?: "not_charged" | "pending" | "unknown";
  constructor(kind: RayonErrorKind, metadata: ErrorMetadata = {}) {
    const guidance = trustedGuidance(metadata.code, metadata.reason, metadata.domain, metadata.retryable, metadata.billingStatus);
    super(guidance?.message ?? messages[kind]);
    this.name = "RayonError";
    this.kind = kind;
    this.preparationId = typeof metadata.preparationId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(metadata.preparationId) ? metadata.preparationId : undefined;
    this.statusCode = metadata.statusCode;
    this.requestId = metadata.requestId;
    this.retryAfter = metadata.retryAfter;
    this.code = metadata.code;
    this.retryable = metadata.retryable;
    this.reason = guidance?.reason;
    this.action = guidance?.action;
    this.domain = safeDomain(metadata.domain);
    this.field = safeField(metadata.field);
    this.billingStatus = safeBillingStatus(metadata.billingStatus);
  }
}

/** Recognize native Undici Error instances without inspecting or exposing their messages. */
export function isTransportTimeout(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    const code = (error as { code?: unknown }).code;
    return (
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT"
    );
  } catch {
    return false;
  }
}

/** Display hostnames only: never retain a source URL, IP literal or credential. */
export function safeDomain(value: unknown, key?: string): string | undefined {
  return typeof value === "string" && value.length <= 253 && (key === undefined || !value.includes(key)) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) &&
    !/[^a-z0-9.-]/.test(value) ? value : undefined;
}

export function safeField(value: unknown, key?: string): string | undefined {
  return typeof value === "string" && value.length <= 96 && (key === undefined || !value.includes(key)) &&
    /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(value) &&
    !/[^a-zA-Z0-9_.]/.test(value) &&
    !value.split(".").some(part => ["__proto__", "constructor", "prototype"].includes(part))
    ? value : undefined;
}

export function safeBillingStatus(value: unknown): ErrorMetadata["billingStatus"] {
  return value === "not_charged" || value === "pending" || value === "unknown" ? value : undefined;
}
