import type { RayonErrorKind, ErrorMetadata } from "./types.js";

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
